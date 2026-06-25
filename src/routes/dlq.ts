/**
 * Dead-Letter Queue (DLQ) Inspection API — Admin Only
 *
 * Implements #43 (DLQ inspection) and #349 (dead-consumer suspension).
 *
 * Trust boundaries
 * ----------------
 * - Public internet clients:        403 Forbidden on all routes.
 * - Authenticated partners:         403 Forbidden — operator role required.
 * - Administrators (operator role): Full read + replay + delete + resume access.
 * - Internal workers:               Call enqueueDeadLetter() directly; not HTTP.
 *
 * Suspension logic (#349)
 * -----------------------
 * Each POST /admin/dlq/:id/replay attempt:
 *  1. Checks whether the topic is suspended → 409 CONSUMER_SUSPENDED if so.
 *  2. Resets the entry's attempt counter (existing behaviour).
 *  3. Calls recordReplaySuccess(topic) on success or recordReplayFailure(topic)
 *     when the re-queued delivery is known to have failed.
 *     Because the replay endpoint only resets state (no synchronous delivery),
 *     we model "replay attempt accepted" as a success-signal and leave failure
 *     counting to the worker that actually delivers. If the caller explicitly
 *     reports a failure (body: { failed: true }), we record a failure.
 *  4. If consecutive_failures reaches DLQ_SUSPENSION_THRESHOLD (default 5),
 *     the topic is suspended automatically.
 *  5. POST /admin/dlq/consumers/:topic/resume clears suspension (operator only).
 *
 * GET /admin/dlq includes a `suspendedTopics` field listing all suspended topics.
 * GET /admin/dlq/:id includes `consumerSuspended` for that entry's topic.
 */

import { Router, type Request, type Response } from 'express';
import { authenticate, requireAuth, requirePermission, Permission } from '../middleware/auth.js';
import { asyncHandler, validationError } from '../middleware/errorHandler.js';
import { info } from '../utils/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { dlqRepository } from '../db/repositories/dlqRepository.js';

/** Shape of a dead-letter entry */
export interface DlqEntry {
  id: string;
  topic: string;
  payload: unknown;
  error: string;
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
  correlationId?: string;
}

/** Enqueue a dead-letter entry. Called by internal workers. */
export async function enqueueDeadLetter(
  entry: Omit<DlqEntry, 'id' | 'firstFailedAt' | 'lastFailedAt'>,
): Promise<DlqEntry> {
  const now = new Date().toISOString();
  const full: DlqEntry = {
    ...entry,
    id: `dlq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    firstFailedAt: now,
    lastFailedAt: now,
  };
  await dlqRepository.insert(full);
  return full;
}

export const dlqRouter = Router();

dlqRouter.use(authenticate, requireAuth);

/**
 * GET /admin/dlq
 * List DLQ entries with optional topic filter and offset pagination.
 * Includes a `suspendedTopics` array surfacing all currently suspended consumers.
 */
dlqRouter.get(
  '/',
  requirePermission(Permission.DLQ_LIST),
  asyncHandler(async (req: Request, res: Response) => {
    const limitParam  = req.query.limit;
    const offsetParam = req.query.offset;
    const topicFilter = req.query.topic;
    const requestId   = req.id;

    let limit = 50;
    if (limitParam !== undefined) {
      const parsed = Number.parseInt(String(limitParam), 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 100) {
        throw validationError('limit must be an integer between 1 and 100');
      }
      limit = parsed;
    }

    let offset = 0;
    if (offsetParam !== undefined) {
      const parsed = Number.parseInt(String(offsetParam), 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        throw validationError('offset must be a non-negative integer');
      }
      offset = parsed;
    }

    const topic = typeof topicFilter === 'string' && topicFilter.trim() !== '' ? topicFilter.trim() : undefined;
    const [{ entries, total }, suspensions] = await Promise.all([
      dlqRepository.findAll({ limit, offset, topic }),
      dlqRepository.listSuspendedConsumers(),
    ]);

    const suspendedTopics = suspensions
      .filter((s) => s.suspended)
      .map((s) => ({ topic: s.topic, suspendedAt: s.suspendedAt, consecutiveFailures: s.consecutiveFailures }));

    info('DLQ entries listed', { total, returned: entries.length, offset, limit, requestId });
    recordAuditEvent('DLQ_LISTED', 'dlq', 'list', requestId, { total, returned: entries.length });

    res.json(successResponse({ entries, total, limit, offset, has_more: offset + entries.length < total, suspendedTopics }));
  }),
);

/**
 * GET /admin/dlq/:id
 * Fetch a single DLQ entry. Includes `consumerSuspended` for the entry's topic.
 */
dlqRouter.get(
  '/:id',
  requirePermission(Permission.DLQ_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const [entry, suspension] = await Promise.all([
      dlqRepository.findById(req.params.id),
      // We don't know the topic yet; fetch after entry resolves — two round-trips
      // is acceptable here; the read path is not hot.
      Promise.resolve(null) as Promise<null>,
    ]);

    if (!entry) {
      res.status(404).json(errorResponse('NOT_FOUND', `DLQ entry '${req.params.id}' not found`, undefined, req.id));
      return;
    }

    const consumerSuspension = await dlqRepository.getConsumerSuspension(entry.topic);
    res.json(successResponse({
      entry,
      consumerSuspended: consumerSuspension?.suspended ?? false,
      consecutiveFailures: consumerSuspension?.consecutiveFailures ?? 0,
    }, req.id));
  }),
);

/**
 * POST /admin/dlq/:id/replay
 * Replay a DLQ entry.
 *
 * - Rejects with 409 if the topic is currently suspended (#349).
 * - Accepts an optional JSON body: `{ failed?: boolean }`. When failed=true,
 *   the caller signals that the delivery is known to have failed immediately
 *   (e.g. SSRF-guard or network error) so consecutive_failures is incremented.
 *   Otherwise consecutive_failures is reset (optimistic success).
 */
dlqRouter.post(
  '/:id/replay',
  requirePermission(Permission.DLQ_REPLAY),
  asyncHandler(async (req: Request, res: Response) => {
    const entry = await dlqRepository.findById(req.params.id);
    if (!entry) {
      res.status(404).json(errorResponse('NOT_FOUND', `DLQ entry '${req.params.id}' not found`, undefined, req.id));
      return;
    }

    // ── Suspension gate (#349) ────────────────────────────────────────────────
    const suspension = await dlqRepository.getConsumerSuspension(entry.topic);
    if (suspension?.suspended) {
      res.status(409).json(errorResponse(
        'CONSUMER_SUSPENDED',
        `Consumer for topic '${entry.topic}' is suspended after ${suspension.consecutiveFailures} consecutive failures. ` +
        `Use POST /admin/dlq/consumers/${encodeURIComponent(entry.topic)}/resume to re-enable.`,
        undefined,
        req.id,
      ));
      return;
    }

    // ── Reset attempt counter and record outcome ──────────────────────────────
    const replayFailed = req.body?.failed === true;

    await dlqRepository.update(entry.id, { attempts: 0, lastFailedAt: new Date().toISOString() });

    if (replayFailed) {
      const updated = await dlqRepository.recordReplayFailure(entry.topic);
      if (updated.suspended) {
        info('DLQ consumer suspended after consecutive failures', { topic: entry.topic, failures: updated.consecutiveFailures, requestId: req.id });
        recordAuditEvent('DLQ_CONSUMER_SUSPENDED', 'dlq_consumer', entry.topic, req.id, {
          consecutiveFailures: updated.consecutiveFailures,
        });
      }
    } else {
      await dlqRepository.recordReplaySuccess(entry.topic);
    }

    info('DLQ entry replayed', { id: entry.id, topic: entry.topic, failed: replayFailed, requestId: req.id });
    recordAuditEvent('DLQ_REPLAYED', 'dlq', entry.id, req.id, {
      topic: entry.topic,
      originalAttempts: entry.attempts,
      replayFailed,
    });

    res.json(successResponse({ message: 'DLQ entry replayed', id: entry.id, topic: entry.topic }, req.id));
  }),
);

/**
 * POST /admin/dlq/consumers/:topic/resume
 * Re-enable a suspended consumer. Operator role required (#349).
 *
 * Clears consecutive_failures and the suspended flag; emits an audit event.
 * Idempotent — re-enabling an already-active consumer is a no-op (returns 200).
 */
dlqRouter.post(
  '/consumers/:topic/resume',
  requirePermission(Permission.DLQ_CONSUMER_RESUME),
  asyncHandler(async (req: Request, res: Response) => {
    const topic = req.params.topic;
    const updated = await dlqRepository.resumeConsumer(topic);

    if (!updated) {
      // No suspension record — consumer is healthy; treat as idempotent success.
      res.json(successResponse({ message: 'Consumer has no suspension record — already active', topic }, req.id));
      return;
    }

    info('DLQ consumer resumed by operator', { topic, requestId: req.id });
    recordAuditEvent('DLQ_CONSUMER_RESUMED', 'dlq_consumer', topic, req.id);

    res.json(successResponse({ message: 'Consumer resumed', topic, resumedAt: updated.resumedAt }, req.id));
  }),
);

/**
 * DELETE /admin/dlq/:id
 * Acknowledge (remove) a DLQ entry.
 */
dlqRouter.delete(
  '/:id',
  requirePermission(Permission.DLQ_DELETE),
  asyncHandler(async (req: Request, res: Response) => {
    const deleted = await dlqRepository.deleteById(req.params.id);
    if (!deleted) {
      res.status(404).json(errorResponse('NOT_FOUND', `DLQ entry '${req.params.id}' not found`, undefined, req.id));
      return;
    }
    info('DLQ entry acknowledged', { id: req.params.id, requestId: req.id });
    res.json(successResponse({ message: 'DLQ entry removed', id: req.params.id }, req.id));
  }),
);

/**
 * DELETE /admin/dlq
 * Purge all DLQ entries (bulk delete with optional topic filter).
 */
dlqRouter.delete(
  '/',
  requirePermission(Permission.DLQ_DELETE),
  asyncHandler(async (req: Request, res: Response) => {
    const topicFilter = req.query.topic;
    const requestId = req.id;

    const topic = typeof topicFilter === 'string' && topicFilter.trim() !== '' ? topicFilter.trim() : undefined;
    const purged = await dlqRepository.deleteAll(topic);

    info('DLQ entries purged', { count: purged, topicFilter, requestId });
    recordAuditEvent('DLQ_PURGED', 'dlq', 'bulk', requestId, { purgedCount: purged, topicFilter });

    res.json(successResponse({ message: 'DLQ entries purged', purged, topicFilter: topicFilter ?? 'all' }, requestId));
  }),
);
