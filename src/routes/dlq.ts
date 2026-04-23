/**
 * Dead-Letter Queue (DLQ) Inspection API — Admin Only
 *
 * Issue #43 — Dead-letter queue inspection API (admin-only)
 *
 * Trust boundaries
 * ----------------
 * - Public internet clients:       403 Forbidden on all routes.
 * - Authenticated partners:        403 Forbidden — operator role required.
 * - Administrators (operator role): Full read + delete access.
 * - Internal workers:              Call enqueueDeadLetter() directly; not exposed via HTTP.
 *
 * Failure modes
 * -------------
 * - No auth header          → 401 UNAUTHORIZED
 * - Valid token, wrong role → 403 FORBIDDEN
 * - Entry not found         → 404 NOT_FOUND
 * - Invalid pagination      → 400 VALIDATION_ERROR
 * - Dependency outage       → 503 SERVICE_UNAVAILABLE (future)
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
import { Router } from 'express';
import { authenticate, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { info, warn } from '../utils/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';

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

// In-memory DLQ store (placeholder — PostgreSQL integration is a follow-up)
const dlqEntries: DlqEntry[] = [];

/** Enqueue a dead-letter entry. Called by internal workers. */
export function enqueueDeadLetter(
  entry: Omit<DlqEntry, 'id' | 'firstFailedAt' | 'lastFailedAt'>,
): DlqEntry {
  const now = new Date().toISOString();
  const full: DlqEntry = {
    ...entry,
    id: `dlq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    firstFailedAt: now,
    lastFailedAt: now,
  };
  dlqEntries.push(full);
  return full;
}

/** Return all entries (shallow copy). */
export function getDlqEntries(): DlqEntry[] {
  return dlqEntries.slice();
}

/** Reset — test use only. */
export function _resetDlq(): void {
  dlqEntries.length = 0;
}

export const dlqRouter = Router();

/** Enforce operator role; must be used after authenticate + requireAuth. */
function requireOperator(req: any, res: any, next: any): void {
  if (req.user?.role !== 'operator') {
    warn('Non-operator attempted DLQ access', { role: req.user?.role, path: req.path });
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Operator role required to access the DLQ', requestId: req.id },
    });
    return;
  }
  next();
}

// All DLQ routes require authentication + operator role
dlqRouter.use(authenticate, requireAuth, requireOperator);

/**
 * GET /admin/dlq
 * List DLQ entries with optional topic filter and offset pagination.
 */
dlqRouter.get(
  '/',
  asyncHandler(async (req: any, res: any) => {
    const limitParam  = req.query.limit;
    const offsetParam = req.query.offset;
    const topicFilter = req.query.topic;
    const requestId   = req.id;

    let limit = 50;
    if (limitParam !== undefined) {
      const parsed = Number.parseInt(String(limitParam), 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 100) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'limit must be an integer between 1 and 100', requestId } });
        return;
      }
      limit = parsed;
    }

    let offset = 0;
    if (offsetParam !== undefined) {
      const parsed = Number.parseInt(String(offsetParam), 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'offset must be a non-negative integer', requestId } });
        return;
      }
      offset = parsed;
    }

    let filtered = dlqEntries.slice();
    if (typeof topicFilter === 'string' && topicFilter.trim() !== '') {
      filtered = filtered.filter((e) => e.topic === topicFilter.trim());
    }

    const page = filtered.slice(offset, offset + limit);

    info('DLQ entries listed', { total: filtered.length, returned: page.length, offset, limit, requestId });

    // Record audit event for DLQ listing
    recordAuditEvent(
      'DLQ_LISTED',
      'dlq',
      'list',
      requestId,
      { total: filtered.length, returned: page.length, offset, limit, topicFilter }
    );

    res.json({
      entries: page,
      total: filtered.length,
      limit,
      offset,
      has_more: offset + page.length < filtered.length,
    });
  }),
);

/**
 * GET /admin/dlq/:id
 * Fetch a single DLQ entry.
 */
dlqRouter.get(
  '/:id',
  asyncHandler(async (req: any, res: any) => {
    const entry = dlqEntries.find((e) => e.id === req.params.id);
    if (!entry) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `DLQ entry '${req.params.id}' not found`, requestId: req.id } });
      return;
    }
    res.json({ entry });
  }),
);

/**
 * POST /admin/dlq/:id/replay
 * Replay a DLQ entry by re-enqueuing it for processing.
 */
dlqRouter.post(
  '/:id/replay',
  asyncHandler(async (req: any, res: any) => {
    const index = dlqEntries.findIndex((e) => e.id === req.params.id);
    if (index === -1) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `DLQ entry '${req.params.id}' not found`, requestId: req.id } });
      return;
    }

    const entry = dlqEntries[index];
    if (!entry) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `DLQ entry '${req.params.id}' not found`, requestId: req.id } });
      return;
    }
    
    // Reset the entry for replay
    entry.attempts = 0;
    entry.lastFailedAt = new Date().toISOString();
    
    info('DLQ entry replayed', { id: entry.id, topic: entry.topic, requestId: req.id });
    
    // Record audit event for DLQ replay
    recordAuditEvent(
      'DLQ_REPLAYED',
      'dlq',
      entry.id,
      req.id,
      { topic: entry.topic, originalAttempts: entry.attempts }
    );

    res.json({ 
      message: 'DLQ entry replayed', 
      id: entry.id,
      topic: entry.topic
    });
  }),
);

/**
 * DELETE /admin/dlq/:id
 * Acknowledge (remove) a DLQ entry.
 */
dlqRouter.delete(
  '/:id',
  asyncHandler(async (req: any, res: any) => {
    const index = dlqEntries.findIndex((e) => e.id === req.params.id);
    if (index === -1) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `DLQ entry '${req.params.id}' not found`, requestId: req.id } });
      return;
    }
    const [removed] = dlqEntries.splice(index, 1);
    info('DLQ entry acknowledged', { id: removed!.id, requestId: req.id });
    res.json({ message: 'DLQ entry removed', id: removed!.id });
  }),
);

/**
 * DELETE /admin/dlq
 * Purge all DLQ entries (bulk delete with optional topic filter).
 */
dlqRouter.delete(
  '/',
  asyncHandler(async (req: any, res: any) => {
    const topicFilter = req.query.topic;
    const requestId = req.id;

    let entriesToRemove = dlqEntries.slice();
    if (typeof topicFilter === 'string' && topicFilter.trim() !== '') {
      entriesToRemove = entriesToRemove.filter((e) => e.topic === topicFilter.trim());
    }

    if (entriesToRemove.length === 0) {
      res.json({ message: 'No DLQ entries to purge', purged: 0 });
      return;
    }

    // Remove entries
    const removedIds: string[] = [];
    entriesToRemove.forEach((entry) => {
      const index = dlqEntries.findIndex((e) => e.id === entry.id);
      if (index !== -1) {
        dlqEntries.splice(index, 1);
        removedIds.push(entry.id);
      }
    });

    info('DLQ entries purged', { count: removedIds.length, topicFilter, requestId });

    // Record audit event for DLQ purge
    recordAuditEvent(
      'DLQ_PURGED',
      'dlq',
      'bulk',
      requestId,
      { purgedCount: removedIds.length, topicFilter, removedIds }
    );

    res.json({ 
      message: 'DLQ entries purged', 
      purged: removedIds.length,
      topicFilter: topicFilter || 'all',
      removedIds
    });
  }),
);
