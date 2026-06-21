/**
 * Dead-Letter Queue (DLQ) Inspection API - Admin Only
 *
 * Issue #43 - Dead-letter queue inspection API (admin-only)
 *
 * Trust boundaries
 * ----------------
 * - Public internet clients:       403 Forbidden on all routes.
 * - Authenticated partners:        403 Forbidden - operator role required.
 * - Administrators (operator role): Full read + delete access.
 * - Internal workers:              Call enqueueDeadLetter() directly; not exposed via HTTP.
 *
 * Failure modes
 * -------------
 * - No auth header          ? 401 UNAUTHORIZED
 * - Valid token, wrong role ? 403 FORBIDDEN
 * - Entry not found         ? 404 NOT_FOUND
 * - Invalid pagination      ? 400 VALIDATION_ERROR
 * - Dependency outage       ? 503 SERVICE_UNAVAILABLE (future)
 *
 * @openapi
 * /admin/dlq:
 *   get:
 *     summary: List dead-letter queue entries (admin only)
 *     tags: [admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: limit
 *         in: query
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 50 }
 *       - name: offset
 *         in: query
 *         schema: { type: integer, minimum: 0, default: 0 }
 *       - name: topic
 *         in: query
 *         schema: { type: string }
 *         description: Filter by topic name
 *     responses:
 *       200:
 *         description: Paginated DLQ entries
 *       400:
 *         description: Invalid pagination parameters
 *       401:
 *         description: Missing or invalid authentication
 *       403:
 *         description: Operator role required
 * /admin/dlq/{id}:
 *   get:
 *     summary: Get a single DLQ entry (admin only)
 *     tags: [admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: DLQ entry }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Not found }
 *   delete:
 *     summary: Remove (acknowledge) a DLQ entry (admin only)
 *     tags: [admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Entry removed }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Not found }
 */
import { Router, type Request, type Response } from 'express';
import { authenticate, requireAuth, requirePermission, Permission } from '../middleware/auth.js';
import { asyncHandler, validationError } from '../middleware/errorHandler.js';
import { info } from '../utils/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { dlqRepository } from '../db/repositories/dlqRepository.js';
import { extractDlqConsumerUrl, hashDlqConsumerUrl, normalizeDlqConsumerUrl } from '../lib/dlqConsumer.js';

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

export interface DlqConsumerReplayState {
  consumerUrl: string;
  consumerUrlHash: string;
  consecutiveFailures: number;
  suspended: boolean;
  suspendedAt?: string;
  updatedAt: string;
}

interface DlqConsumerReplaySummary {
  consumerUrlHash: string;
  consecutiveFailures: number;
  suspended: boolean;
  suspendedAt?: string;
}

type DlqEntryResponse = DlqEntry & {
  consumerReplay?: DlqConsumerReplaySummary;
};

function getReplaySuspendThreshold(): number {
  const parsed = Number.parseInt(process.env.DLQ_REPLAY_SUSPEND_THRESHOLD ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

function summarizeConsumerReplayState(state: DlqConsumerReplayState): DlqConsumerReplaySummary {
  return {
    consumerUrlHash: state.consumerUrlHash,
    consecutiveFailures: state.consecutiveFailures,
    suspended: state.suspended,
    ...(state.suspendedAt ? { suspendedAt: state.suspendedAt } : {}),
  };
}

async function annotateConsumerReplayState(entries: DlqEntry[]): Promise<DlqEntryResponse[]> {
  const consumerUrls = entries
    .map((entry) => extractDlqConsumerUrl(entry.payload))
    .filter((url): url is string => url !== undefined);
  const states = await dlqRepository.findConsumerReplayStates(consumerUrls);

  return entries.map((entry) => {
    const consumerUrl = extractDlqConsumerUrl(entry.payload);
    if (!consumerUrl) return entry;

    const state = states.get(consumerUrl);
    return {
      ...entry,
      consumerReplay: state
        ? summarizeConsumerReplayState(state)
        : {
            consumerUrlHash: hashDlqConsumerUrl(consumerUrl),
            consecutiveFailures: 0,
            suspended: false,
          },
    };
  });
}

async function recordDlqReplayFailureIfConsumerKnown(entry: DlqEntry): Promise<void> {
  const consumerUrl = extractDlqConsumerUrl(entry.payload);
  if (!consumerUrl) return;

  const threshold = getReplaySuspendThreshold();
  const previous = await dlqRepository.findConsumerReplayState(consumerUrl);
  const next = await dlqRepository.recordConsumerReplayFailure(consumerUrl, threshold);

  if (next.suspended && !previous?.suspended) {
    recordAuditEvent(
      'DLQ_CONSUMER_SUSPENDED',
      'dlq_consumer',
      next.consumerUrlHash,
      entry.correlationId,
      {
        consecutiveFailures: next.consecutiveFailures,
        threshold,
        dlqEntryId: entry.id,
        topic: entry.topic,
      },
    );
  }
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
  await recordDlqReplayFailureIfConsumerKnown(full);
  return full;
}

/** Reset DLQ state. Test use only. */
export async function _resetDlq(): Promise<void> {
  await dlqRepository.deleteAll();
  await dlqRepository.deleteAllConsumerReplayStates();
}

export const dlqRouter = Router();

// All DLQ routes require authentication + appropriate permission
dlqRouter.use(authenticate, requireAuth);

/**
 * GET /admin/dlq
 * List DLQ entries with optional topic filter and offset pagination.
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
    const { entries, total } = await dlqRepository.findAll({ limit, offset, topic });
    const entriesWithConsumerState = await annotateConsumerReplayState(entries);

    info('DLQ entries listed', { total, returned: entriesWithConsumerState.length, offset, limit, requestId });

    recordAuditEvent('DLQ_LISTED', 'dlq', 'list', requestId, { total, returned: entriesWithConsumerState.length, offset, limit, topicFilter });

    res.json(successResponse({
      entries: entriesWithConsumerState,
      total,
      limit,
      offset,
      has_more: offset + entriesWithConsumerState.length < total,
    }));
  }),
);

/**
 * GET /admin/dlq/:id
 * Fetch a single DLQ entry.
 */
dlqRouter.get(
  '/:id',
  requirePermission(Permission.DLQ_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const entry = await dlqRepository.findById(req.params.id);
    if (!entry) {
      res.status(404).json(errorResponse('NOT_FOUND', `DLQ entry '${req.params.id}' not found`, undefined, req.id));
      return;
    }
    const [entryWithConsumerState] = await annotateConsumerReplayState([entry]);
    res.json(successResponse({ entry: entryWithConsumerState }, req.id));
  }),
);

/**
 * POST /admin/dlq/consumers/reenable
 * Re-enable a suspended consumer so operators can replay its DLQ entries.
 */
dlqRouter.post(
  '/consumers/reenable',
  requirePermission(Permission.DLQ_REPLAY),
  asyncHandler(async (req: Request, res: Response) => {
    const consumerUrl = normalizeDlqConsumerUrl((req.body as Record<string, unknown> | undefined)?.consumerUrl);
    if (!consumerUrl) {
      throw validationError('consumerUrl must be a valid http(s) URL');
    }

    const state = await dlqRepository.reenableConsumer(consumerUrl);
    if (!state) {
      res.status(404).json(errorResponse(
        'NOT_FOUND',
        'DLQ consumer replay state not found',
        { consumerUrlHash: hashDlqConsumerUrl(consumerUrl) },
        req.id,
      ));
      return;
    }

    recordAuditEvent(
      'DLQ_CONSUMER_REENABLED',
      'dlq_consumer',
      state.consumerUrlHash,
      req.id,
      { consecutiveFailures: 0 },
    );

    res.json(successResponse({
      message: 'DLQ consumer re-enabled',
      consumerReplay: summarizeConsumerReplayState(state),
    }, req.id));
  }),
);

/**
 * POST /admin/dlq/:id/replay
 * Replay a DLQ entry by re-enqueuing it for processing.
 */
dlqRouter.post(
  '/:id/replay',
  requirePermission(Permission.DLQ_REPLAY),
  asyncHandler(async (req: Request, res: Response) => {
    const entry = await dlqRepository.findById(req.params.id);
    if (!entry) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `DLQ entry '${req.params.id}' not found`, requestId: req.id } });
      return;
    }

    const consumerUrl = extractDlqConsumerUrl(entry.payload);
    if (consumerUrl) {
      const consumerState = await dlqRepository.findConsumerReplayState(consumerUrl);
      if (consumerState?.suspended) {
        res.status(409).json(errorResponse(
          'DLQ_CONSUMER_SUSPENDED',
          'DLQ consumer is suspended; re-enable it before replaying entries for this endpoint',
          summarizeConsumerReplayState(consumerState),
          req.id,
        ));
        return;
      }
    }

    await dlqRepository.update(entry.id, { attempts: 0, lastFailedAt: new Date().toISOString() });
    
    info('DLQ entry replayed', { id: entry.id, topic: entry.topic, requestId: req.id });
    
    // Record audit event for DLQ replay
    recordAuditEvent(
      'DLQ_REPLAYED',
      'dlq',
      entry.id,
      req.id,
      { topic: entry.topic, originalAttempts: entry.attempts }
    );

    res.json(successResponse({
      message: 'DLQ entry replayed',
      id: entry.id,
      topic: entry.topic,
    }, req.id));
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

    res.json(successResponse({
      message: 'DLQ entries purged',
      purged,
      topicFilter: topicFilter || 'all',
    }, requestId));
  }),
);
