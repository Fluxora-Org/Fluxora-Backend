// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
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
 *
 * Failure history
 * ---------------
 * A dead-lettered item is only actionable if it records why it failed, so every
 * entry carries the full `failureHistory`: an append-only, oldest-first list of
 * attempt records ({ error, attempt, failedAt, source }).
 *  - `entry.error` is the FIRST failure cause and is never rewritten, so a retry
 *    can no longer erase the original diagnosis.
 *  - Each failed replay appends its reported cause (body `error`, or
 *    `UNREPORTED_REPLAY_FAILURE` when the caller reports none) and increments
 *    the attempt counter, updating `last_failed_at`.
 *  - GET /admin/dlq/:id and the replay response both return the stored history.
 */

import { Router, type Request, type Response } from 'express';
import { authenticate, requireAuth, requirePermission, Permission } from '../middleware/auth.js';
import { asyncHandler, validationError } from '../middleware/errorHandler.js';
import { info, warn } from '../lib/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { dlqRepository } from '../db/repositories/dlqRepository.js';
import { OffsetPaginationSchema, DEFAULT_PAGE_LIMIT } from '../validation/paginationSchema.js';

/** Shape of a dead-letter entry */
export interface DlqEntry {
  id: string;
  /** Tenant that owns the failed delivery. Legacy rows may omit this value. */
  tenantId?: string;
  topic: string;
  payload: unknown;
  /**
   * The FIRST recorded failure cause for this item.
   *
   * This value is written once, when the entry is enqueued, and is never
   * rewritten by a later attempt: the original cause is the one worth
   * diagnosing. Later causes are appended to {@link DlqEntry.failureHistory}.
   */
  error: string;
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
  correlationId?: string;
  status?: 'dead' | 'replayed';
  /**
   * Every recorded failure cause for this item, oldest first.
   *
   * Index 0 always mirrors {@link DlqEntry.error}. Subsequent attempt failures
   * are appended, never substituted, so the full diagnosis history survives
   * however many times the item is retried. Optional only for callers that
   * build an entry object by hand — the repository always produces an array.
   */
  failureHistory?: DlqFailureAttempt[];
}

/**
 * One recorded failure of a dead-lettered item.
 *
 * @see DlqEntry.failureHistory
 */
export interface DlqFailureAttempt {
  /** Failure cause for this attempt, verbatim as reported by the caller. */
  error: string;
  /** The entry's attempt counter at the time this failure was recorded. */
  attempt: number;
  /** ISO-8601 timestamp of the failure. */
  failedAt: string;
  /**
   * Where the record came from — `enqueue` for the first cause,
   * `replay` for a failed retry, `legacy-backfill` for rows migrated from
   * before the history column existed.
   */
  source?: string;
}

/** Recorded as the cause of a failed replay that reported no reason. */
export const UNREPORTED_REPLAY_FAILURE = 'replay failed (reason not reported)';

/** Maximum accepted length of a caller-reported failure cause. */
const MAX_FAILURE_ERROR_LENGTH = 2_000;

/**
 * Normalise a caller-reported failure cause.
 *
 * Yields null for anything that is not a usable string, so a malformed body
 * cannot end up in the failure history, and bounds the length so repeated
 * retries cannot grow the stored history without limit.
 *
 * @returns The trimmed, length-bounded cause, or null when unusable.
 */
export function normalizeFailureError(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.length > MAX_FAILURE_ERROR_LENGTH ? trimmed.slice(0, MAX_FAILURE_ERROR_LENGTH) : trimmed;
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
    // The enqueue IS the first failure: seed the history so the cause is
    // recorded even if every later attempt fails differently.
    failureHistory: entry.failureHistory ?? [
      { error: entry.error, attempt: entry.attempts, failedAt: now, source: 'enqueue' },
    ],
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
    const topicFilter = req.query.topic;
    const tenantFilter = req.query.tenantId;
    const requestId   = req.correlationId;

    const parsed = OffsetPaginationSchema.safeParse(req.query);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw validationError(firstIssue?.message ?? 'Invalid pagination parameters');
    }

    const limit  = parsed.data.limit  ?? DEFAULT_PAGE_LIMIT;
    const offset = parsed.data.offset ?? 0;

    const topic = typeof topicFilter === 'string' && topicFilter.trim() !== '' ? topicFilter.trim() : undefined;
    const tenantId = typeof tenantFilter === 'string' && tenantFilter.trim() !== '' ? tenantFilter.trim() : undefined;
    const [{ entries, total }, suspensions] = await Promise.all([
      dlqRepository.findAll({ limit, offset, ...(topic ? { topic } : {}), ...(tenantId ? { tenantId } : {}) }),
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
 * Fetch a single DLQ entry. Includes `consumerSuspended` for the entry's topic
 * and the entry's full `failureHistory` (oldest cause first) so an operator can
 * see every recorded failure, not just the first one.
 */
dlqRouter.get(
  '/:id',
  requirePermission(Permission.DLQ_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const entry = await dlqRepository.findById(req.params.id);

    if (!entry) {
      res.status(404).json(errorResponse('NOT_FOUND', `DLQ entry '${req.params.id}' not found`, undefined, req.correlationId));
      return;
    }

    const failureHistory = entry.failureHistory ?? [];
    const consumerSuspension = await dlqRepository.getConsumerSuspension(entry.topic);
    res.json(successResponse({
      entry,
      failureHistory,
      failureCount: failureHistory.length,
      firstFailure: failureHistory[0]?.error ?? entry.error,
      latestFailure: failureHistory[failureHistory.length - 1]?.error ?? entry.error,
      consumerSuspended: consumerSuspension?.suspended ?? false,
      consecutiveFailures: consumerSuspension?.consecutiveFailures ?? 0,
    }, req.correlationId));
  }),
);

/**
 * POST /admin/dlq/:id/replay
 * Replay a DLQ entry.
 *
 * - Rejects with 409 if the topic is currently suspended (#349).
 * - Accepts an optional JSON body: `{ failed?: boolean, error?: string }`. When
 *   failed=true, the caller signals that the delivery is known to have failed
 *   immediately (e.g. SSRF-guard or network error) so consecutive_failures is
 *   incremented. Otherwise consecutive_failures is reset (optimistic success).
 * - On failure the reported cause (body `error`, or the
 *   UNREPORTED_REPLAY_FAILURE placeholder when the caller reports none) is
 *   APPENDED to the entry's failure history. The first cause is never
 *   overwritten, so a replay failure can no longer erase the original
 *   diagnosis.
 */
dlqRouter.post(
  '/:id/replay',
  requirePermission(Permission.DLQ_REPLAY),
  asyncHandler(async (req: Request, res: Response) => {
    const entry = await dlqRepository.findById(req.params.id);
    if (!entry) {
      res.status(404).json(errorResponse('NOT_FOUND', `DLQ entry '${req.params.id}' not found`, undefined, req.correlationId));
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
        req.correlationId,
      ));
      return;
    }

    // ── Reject a malformed reported cause before any state changes ────────────
    const reportedError = req.body?.error;
    if (reportedError !== undefined && reportedError !== null && typeof reportedError !== 'string') {
      throw validationError('Field \'error\' must be a string');
    }

    // ── Reset attempt counter and record outcome, with optimistic concurrency ──
    const replayFailed = req.body?.failed === true;

    const replayed = await dlqRepository.replayEntry(entry.id, { attempts: 0, lastFailedAt: new Date().toISOString() });
    if (!replayed) {
      res.status(409).json(errorResponse(
        'ENTRY_ALREADY_REPLAYED',
        `DLQ entry '${entry.id}' has already been replayed or resolved.`,
        undefined,
        req.id,
      ));
      return;
    }

    let failureHistory = entry.failureHistory ?? [];

    if (replayFailed) {
      // Append this attempt's cause to the item's history. recordFailure never
      // rewrites `error`, so the original cause survives every retry.
      const withFailure = await dlqRepository.recordFailure(entry.id, {
        error: normalizeFailureError(reportedError) ?? UNREPORTED_REPLAY_FAILURE,
        source: 'replay',
        failedAt: new Date().toISOString(),
      });
      if (withFailure) {
        failureHistory = withFailure.failureHistory ?? failureHistory;
      } else {
        // The replay itself succeeded; only the history append was lost to a
        // concurrent delete. Report it without failing an accepted replay.
        warn('DLQ failure history append matched no row', { id: entry.id, topic: entry.topic, requestId: req.correlationId });
      }

      const updated = await dlqRepository.recordReplayFailure(entry.topic);
      if (updated.suspended) {
        info('DLQ consumer suspended after consecutive failures', { topic: entry.topic, failures: updated.consecutiveFailures, requestId: req.correlationId });
        recordAuditEvent('DLQ_CONSUMER_SUSPENDED', 'dlq_consumer', entry.topic, req.correlationId, {
          consecutiveFailures: updated.consecutiveFailures,
        });
      }
    } else {
      await dlqRepository.recordReplaySuccess(entry.topic);
    }

    info('DLQ entry replayed', { id: entry.id, topic: entry.topic, failed: replayFailed, requestId: req.correlationId });
    recordAuditEvent('DLQ_REPLAYED', 'dlq', entry.id, req.correlationId, {
      topic: entry.topic,
      originalAttempts: entry.attempts,
      replayFailed,
      failureCount: failureHistory.length,
    });

    res.json(successResponse({
      message: 'DLQ entry replayed',
      id: entry.id,
      topic: entry.topic,
      // Echo the history as stored after this call so a caller can verify the
      // new cause was appended rather than replacing a previous one.
      failureHistory,
    }, req.correlationId));
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
      res.json(successResponse({ message: 'Consumer has no suspension record — already active', topic }, req.correlationId));
      return;
    }

    info('DLQ consumer resumed by operator', { topic, requestId: req.correlationId });
    recordAuditEvent('DLQ_CONSUMER_RESUMED', 'dlq_consumer', topic, req.correlationId);

    res.json(successResponse({ message: 'Consumer resumed', topic, resumedAt: updated.resumedAt }, req.correlationId));
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
      res.status(404).json(errorResponse('NOT_FOUND', `DLQ entry '${req.params.id}' not found`, undefined, req.correlationId));
      return;
    }
    info('DLQ entry acknowledged', { id: req.params.id, requestId: req.correlationId });
    res.json(successResponse({ message: 'DLQ entry removed', id: req.params.id }, req.correlationId));
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
    const tenantFilter = req.query.tenantId;
    const requestId = req.correlationId;

    const topic = typeof topicFilter === 'string' && topicFilter.trim() !== '' ? topicFilter.trim() : undefined;
    const tenantId = typeof tenantFilter === 'string' && tenantFilter.trim() !== '' ? tenantFilter.trim() : undefined;
    const purged = tenantId
      ? await dlqRepository.deleteAll(topic, tenantId)
      : await dlqRepository.deleteAll(topic);

    info('DLQ entries purged', { count: purged, topicFilter, requestId });
    recordAuditEvent('DLQ_PURGED', 'dlq', 'bulk', requestId, { purgedCount: purged, topicFilter, tenantId });

    res.json(successResponse({ message: 'DLQ entries purged', purged, topicFilter: topicFilter ?? 'all' }, requestId));
  }),
);
