import { Router } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import { getHybridBanStoreStatus } from '../redis/banStore.js';
import {
  getPauseFlags,
  setPauseFlags,
  getReindexState,
  triggerReindex,
  triggerStreamReindex,
  AdminStatePersistenceError,
} from '../state/adminState.js';
import { z } from 'zod';
import { formatZodIssues } from '../validation/schemas.js';
import { streamRepository } from '../db/repositories/streamRepository.js';
import { createApiKey, rotateApiKey, revokeApiKey, listApiKeys } from '../lib/apiKey.js';
import { recordAuditEvent, recordAuditEventToDb } from '../lib/auditLog.js';
import { getStreamHub } from '../ws/hub.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { clearIndexerStall, ActiveStallError } from '../indexer/stall.js';
import { routeDeprecations } from '../config/deprecations.js';
import {
  queueRestoreJob,
  getRestoreJob,
  listRestoreJobs,
  ValidationError,
  ConfigurationError,
  type RestoreJob,
} from '../scripts/backup-retention.js';
import { tenantRateLimitOverridesRouter } from './admin/tenantRateLimitOverrides.js';

export const adminRouter = Router();

/**
 * GET /api/admin/status/read-only
 * Read-only endpoint for pause-flag visibility without admin credentials.
 * Exposes non-sensitive service posture only.
 */
adminRouter.get('/status/read-only', (req, res) => {
  const requestId = req.correlationId;
  res.json(successResponse({ pauseFlags: getPauseFlags() }, requestId));
});

// Every admin route requires a valid Bearer token.
adminRouter.use(requireAdminAuth);

// Per-tenant rate limit override management
adminRouter.use('/rate-limits/overrides', tenantRateLimitOverridesRouter);

/**
 * GET /api/admin/deprecations
 * Returns all registered deprecated routes with their sunset dates and
 * computed daysUntilSunset, enabling SRE tooling to alert before removal.
 *
 * @security Requires valid Bearer admin token.
 * @returns Array of deprecated route entries, each with `route`, `sunsetDate`,
 *          optional `link`, and computed `daysUntilSunset` (negative if past sunset).
 */
adminRouter.get('/deprecations', (req, res) => {
  const requestId = req.correlationId;
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;

  const deprecations = routeDeprecations.map(({ route, sunsetDate, link }) => {
    const sunsetMs = new Date(sunsetDate).getTime();
    const daysUntilSunset = Math.floor((sunsetMs - now) / MS_PER_DAY);
    return { route, sunsetDate, ...(link !== undefined ? { link } : {}), daysUntilSunset };
  });

  res.json(successResponse(deprecations, requestId));
});

/**
 * GET /api/admin/status
 * Returns current pause flags and reindex state so operators can
 * inspect service posture at a glance.
 */
adminRouter.get('/status', (req, res) => {
  const requestId = req.correlationId;
  res.json(
    successResponse(
      {
        pauseFlags: getPauseFlags(),
        reindex: getReindexState(),
      },
      requestId
    )
  );
});

/**
 * GET /api/admin/pause
 * Read-only view of the current pause flags.
 */
adminRouter.get('/pause', (req, res) => {
  const requestId = req.correlationId;
  res.json(successResponse(getPauseFlags(), requestId));
});

/**
 * PUT /api/admin/pause
 * Update one or both pause flags.
 *
 * Body (all fields optional):
 *   { "streamCreation": true, "ingestion": false }
 */
adminRouter.put('/pause', async (req, res) => {
  const requestId = req.correlationId;
  const { streamCreation, ingestion } = req.body ?? {};

  if (streamCreation === undefined && ingestion === undefined) {
    res.status(400).json(
      errorResponse(
        'VALIDATION_ERROR',
        'Request body must include at least one of: streamCreation, ingestion.',
        undefined,
        requestId
      )
    );
    return;
  }

  const errors: string[] = [];
  if (streamCreation !== undefined && typeof streamCreation !== 'boolean') {
    errors.push('streamCreation must be a boolean.');
  }
  if (ingestion !== undefined && typeof ingestion !== 'boolean') {
    errors.push('ingestion must be a boolean.');
  }
  if (errors.length > 0) {
    res.status(400).json(
      errorResponse(
        'VALIDATION_ERROR',
        errors.join(' '),
        undefined,
        requestId
      )
    );
    return;
  }

  const previous = getPauseFlags();
  let updated;
  try {
    updated = await setPauseFlags({ streamCreation, ingestion });
  } catch (err) {
    if (err instanceof AdminStatePersistenceError) {
      res.status(503).json(
        errorResponse(
          'PERSISTENCE_ERROR',
          'Unable to persist pause flags. Try again later.',
          undefined,
          requestId
        )
      );
      return;
    }
    throw err;
  }

  recordAuditEvent('PAUSE_FLAGS_UPDATED', 'pauseFlags', 'system', requestId, {
    previous,
    updated,
    ...(streamCreation !== undefined ? { streamCreation } : {}),
    ...(ingestion !== undefined ? { ingestion } : {}),
  });

  res.json(
    successResponse(
      {
        message: 'Pause flags updated.',
        pauseFlags: updated,
      },
      requestId
    )
  );
});

/**
 * GET /api/admin/reindex
 * Returns the current reindex job state.
 */
adminRouter.get('/reindex', (req, res) => {
  const requestId = req.correlationId;
  res.json(successResponse(getReindexState(), requestId));
});

/**
 * POST /api/admin/reindex
 * Triggers a reindex operation. Returns 409 if one is already running.
 */
adminRouter.post('/reindex', async (req, res) => {
  const requestId = req.correlationId;
  const current = getReindexState();
  if (current.status === 'running') {
    res.status(409).json(
      errorResponse(
        'CONFLICT',
        'A reindex operation is already in progress.',
        { reindex: current },
        requestId
      )
    );
    return;
  }

  const state = await triggerReindex();

  recordAuditEvent('REINDEX_TRIGGERED', 'reindex', 'system', requestId, {
    status: state.status,
    startedAt: state.startedAt,
  });

  res.status(202).json(
    successResponse(
      {
        message: 'Reindex started.',
        reindex: state,
      },
      requestId
    )
  );
});

/**
 * POST /api/admin/indexer/stall/clear
 * Clears a latched indexer stall flag. Refuses to clear if the underlying
 * lag is still violating the freshness threshold.
 */
adminRouter.post('/indexer/stall/clear', (req, res) => {
  try {
    clearIndexerStall();
    recordAuditEvent('INDEXER_STALL_CLEARED', 'indexer', 'system', req.correlationId);
    res.json({ message: 'Indexer stall flag cleared successfully.' });
  } catch (err) {
    if (err instanceof ActiveStallError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * POST /api/admin/ws/disconnect
 * Forcibly closes every active WebSocket subscription for a given stream_id.
 */
adminRouter.post('/ws/disconnect', async (req, res) => {
  const requestId = req.correlationId;
  const { stream_id: streamIdValue } = req.body ?? {};

  if (typeof streamIdValue !== 'string') {
    res.status(400).json(
      errorResponse(
        'VALIDATION_ERROR',
        'stream_id (string) is required.',
        undefined,
        requestId
      )
    );
    return;
  }

  const streamId = streamIdValue.trim();
  if (streamId.length === 0) {
    res.status(400).json(
      errorResponse(
        'VALIDATION_ERROR',
        'stream_id (string) is required.',
        undefined,
        requestId
      )
    );
    return;
  }

  const hub = getStreamHub();
  if (!hub) {
    res.status(503).json(
      errorResponse(
        'SERVICE_UNAVAILABLE',
        'WebSocket hub is not initialized. Try again after the service starts.',
        undefined,
        requestId
      )
    );
    return;
  }

  const disconnectedCount = hub.disconnectByStreamId(streamId);

  try {
    await recordAuditEventToDb('ADMIN_WS_DISCONNECT', 'stream', streamId, requestId, {
      disconnectedCount,
      closeCode: 4000,
      closeReason: 'admin-forced-disconnect',
    });
  } catch (err) {
    res.status(503).json(
      errorResponse(
        'PERSISTENCE_ERROR',
        'Unable to persist audit log entry. Try again later.',
        { disconnectedCount },
        requestId
      )
    );
    return;
  }

  res.json(
    successResponse(
      {
        message: 'WebSocket subscribers disconnected.',
        stream_id: streamId,
        disconnectedCount,
      },
      requestId
    )
  );
});

// ─── Bulk Operations ──────────────────────────────────────────────────────────

const bulkActionItemSchema = z.object({
  streamId: z.string().min(1, 'streamId cannot be empty'),
  action: z.enum(['pause', 'cancel', 'reindex']),
});

const bulkActionSchema = z.object({
  batch: z.array(bulkActionItemSchema).min(1, 'Batch cannot be empty').max(500, 'Batch size exceeds limit of 500'),
});

/**
 * POST /api/admin/streams/bulk-actions
 * Accepts a batch of { streamId, action } pairs and applies them atomically via repository updates.
 * Partial failures are reported per-item in the response.
 */
adminRouter.post('/streams/bulk-actions', async (req, res) => {
  const requestId = req.correlationId;
  const parseResult = bulkActionSchema.safeParse(req.body);

  if (!parseResult.success) {
    res.status(400).json(
      errorResponse(
        'VALIDATION_ERROR',
        'Request validation failed',
        formatZodIssues(parseResult.error.issues),
        requestId
      )
    );
    return;
  }

  const { batch } = parseResult.data;
  const results: Array<{ streamId: string; action: string; status: 'success' | 'failed'; error?: string }> = [];
  let successCount = 0;
  let failureCount = 0;

  for (const item of batch) {
    try {
      if (item.action === 'pause') {
        await streamRepository.updateStream(item.streamId, { status: 'paused' }, req.correlationId);
      } else if (item.action === 'cancel') {
        await streamRepository.updateStream(item.streamId, { status: 'cancelled' }, req.correlationId);
      } else if (item.action === 'reindex') {
        await triggerStreamReindex(item.streamId);
      }
      
      results.push({ streamId: item.streamId, action: item.action, status: 'success' });
      successCount++;
    } catch (err) {
      results.push({
        streamId: item.streamId,
        action: item.action,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      failureCount++;
    }
  }

  recordAuditEvent('ADMIN_BULK_ACTION', 'stream_batch', 'bulk', requestId, {
    batchSize: batch.length,
    successCount,
    failureCount,
  });

  res.json(successResponse({ results, successCount, failureCount }, requestId));
});

// ─── API Key Management ───────────────────────────────────────────────────────

/**
 * GET /api/admin/api-keys
 * Lists all API key records (hashes only — raw keys are never returned).
 */
adminRouter.get('/api-keys', async (req, res) => {
  const requestId = req.correlationId;
  res.json(successResponse({ apiKeys: await listApiKeys() }, requestId));
});

/**
 * POST /api/admin/api-keys
 * Creates a new API key. The raw key is returned exactly once.
 *
 * The create/rotate/revoke handlers delegate audit logging to the apiKey
 * library so every key mutation is recorded durably, regardless of caller.
 *
 * Body: { "name": "my-service" }
 */
adminRouter.post('/api-keys', async (req, res) => {
  const requestId = req.correlationId;
  const { name } = req.body ?? {};
  if (!name || typeof name !== 'string') {
    res.status(400).json(
      errorResponse(
        'VALIDATION_ERROR',
        'name (string) is required.',
        undefined,
        requestId
      )
    );
    return;
  }
  try {
    const created = await createApiKey(name, undefined, req.correlationId);
    res.status(201).json(successResponse(created, requestId));
  } catch (err) {
    res.status(400).json(
      errorResponse(
        'API_KEY_ERROR',
        err instanceof Error ? err.message : String(err),
        undefined,
        requestId
      )
    );
  }
});

/**
 * POST /api/admin/api-keys/:id/rotate
 * Issues a new raw key for an existing key record. The old key is immediately
 * invalidated. The new raw key is returned exactly once.
 */
adminRouter.post('/api-keys/:id/rotate', async (req, res) => {
  const requestId = req.correlationId;
  try {
    const rotated = await rotateApiKey(req.params.id, req.correlationId);
    res.json(successResponse(rotated, requestId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('not found') ? 404 : 400;
    const code = status === 404 ? 'NOT_FOUND' : 'API_KEY_ERROR';
    res.status(status).json(errorResponse(code, msg, undefined, requestId));
  }
});

/**
 * DELETE /api/admin/api-keys/:id
 * Revokes an API key. Revoked keys cannot authenticate requests.
 */
adminRouter.delete('/api-keys/:id', async (req, res) => {
  const requestId = req.correlationId;
  try {
    await revokeApiKey(req.params.id, req.correlationId);
    res.status(204).send();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('not found') ? 404 : 400;
    const code = status === 404 ? 'NOT_FOUND' : 'API_KEY_ERROR';
    res.status(status).json(errorResponse(code, msg, undefined, requestId));
  }
});

/**
 * GET /api/admin/ban-store/status
 * Returns the health and fallback state of the HybridBanStore.
 */
adminRouter.get('/ban-store/status', (req, res) => {
  const requestId = req.correlationId;
  try {
    const status = typeof getHybridBanStoreStatus === 'function'
      ? getHybridBanStoreStatus()
      : { available: false, reason: 'getHybridBanStoreStatus not implemented' };
    res.json(successResponse({ banStore: status }, requestId));
  } catch (err) {
    res.status(503).json(
      errorResponse(
        'SERVICE_UNAVAILABLE',
        err instanceof Error ? err.message : String(err),
        undefined,
        requestId,
      ),
    );
  }
});

// ─── Backup Restore ───────────────────────────────────────────────────────────

/**
 * POST /api/admin/restore
 *
 * Accepts a backup restore request and queues an async S3 copy job.
 *
 * The endpoint returns immediately with HTTP 202 once the job is queued.
 * The actual S3 copy runs out-of-band; poll GET /api/admin/restore/:jobId
 * for progress.
 *
 * ### Request body
 * ```json
 * {
 *   "backupId": "backups/db-2026-07-01.sql.gz",
 *   "targetEnvironment": "staging",   // optional, default: "staging"
 *   "confirmProduction": true          // required only when targetEnvironment is "production"
 * }
 * ```
 *
 * ### Status transitions (recorded in audit_logs)
 * ```
 * queued  →  running  →  completed
 *                      ↘  failed
 * ```
 *
 * @security Requires valid Bearer admin token (`ADMIN_API_KEY`).
 * @throws 400 when `backupId` is missing, empty, starts with "/",
 *             contains "..", or exceeds 1 024 characters.
 * @throws 400 when `targetEnvironment === "production"` and
 *             `confirmProduction` is not explicitly `true`.
 * @throws 503 when the `S3_BACKUP_BUCKET` environment variable is unset.
 * @returns 202 Accepted with the queued {@link RestoreJob} record.
 */
adminRouter.post('/restore', async (req, res) => {
  const requestId = req.correlationId;
  const { backupId, targetEnvironment, confirmProduction } = req.body ?? {};

  // ── Input validation ────────────────────────────────────────────────────
  if (!backupId || typeof backupId !== 'string') {
    res.status(400).json(
      errorResponse(
        'VALIDATION_ERROR',
        'backupId (non-empty string) is required.',
        undefined,
        requestId,
      ),
    );
    return;
  }

  if (
    targetEnvironment !== undefined &&
    targetEnvironment !== 'staging' &&
    targetEnvironment !== 'production'
  ) {
    res.status(400).json(
      errorResponse(
        'VALIDATION_ERROR',
        'targetEnvironment must be "staging" or "production".',
        undefined,
        requestId,
      ),
    );
    return;
  }

  // Require S3_BACKUP_BUCKET to be configured before queueing.
  if (!process.env.S3_BACKUP_BUCKET) {
    res.status(503).json(
      errorResponse(
        'CONFIGURATION_ERROR',
        'S3_BACKUP_BUCKET environment variable is required for restore operations.',
        undefined,
        requestId,
      ),
    );
    return;
  }

  // ── Queue job ───────────────────────────────────────────────────────────
  let job: RestoreJob;

  try {
    job = queueRestoreJob({
      backupId,
      targetEnvironment: targetEnvironment ?? 'staging',
      confirmProduction: confirmProduction === true,
      correlationId: requestId,
      onStatusChange: (updatedJob) => {
        // Translate each status transition to a durable audit event.
        // These fire from the async background loop so we use the
        // non-throwing recordAuditEvent path.
        const auditActionMap = {
          queued: 'BACKUP_RESTORE_QUEUED',
          running: 'BACKUP_RESTORE_STARTED',
          completed: 'BACKUP_RESTORE_COMPLETED',
          failed: 'BACKUP_RESTORE_FAILED',
        } as const;

        const auditAction = auditActionMap[updatedJob.status];
        if (!auditAction) return;

        recordAuditEvent(auditAction, 'backup', updatedJob.jobId, requestId, {
          backupId: updatedJob.backupId,
          targetEnvironment: updatedJob.targetEnvironment,
          ...(updatedJob.restoredTo !== undefined ? { restoredTo: updatedJob.restoredTo } : {}),
          ...(updatedJob.errorMessage !== undefined ? { errorMessage: updatedJob.errorMessage } : {}),
        });
      },
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json(
        errorResponse('VALIDATION_ERROR', err.message, undefined, requestId),
      );
      return;
    }
    if (err instanceof ConfigurationError) {
      res.status(503).json(
        errorResponse('CONFIGURATION_ERROR', err.message, undefined, requestId),
      );
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(503).json(errorResponse('RESTORE_ERROR', message, undefined, requestId));
    return;
  }

  res.status(202).json(
    successResponse(
      {
        message: 'Restore job queued.',
        job,
      },
      requestId,
    ),
  );
});

/**
 * GET /api/admin/restore/:jobId
 *
 * Polls the status of a previously queued restore job.
 *
 * Returns the full {@link RestoreJob} record, including:
 * - `status`:          "queued" | "running" | "completed" | "failed"
 * - `queuedAt`:        ISO-8601 timestamp when the job was queued
 * - `startedAt`:       ISO-8601 timestamp when execution began (if started)
 * - `completedAt`:     ISO-8601 timestamp when the job finished (if finished)
 * - `restoredTo`:      S3 URI of the restored object (if completed)
 * - `errorMessage`:    Failure description (if failed)
 *
 * @security Requires valid Bearer admin token (`ADMIN_API_KEY`).
 * @throws 400 when `jobId` is empty or exceeds 255 characters.
 * @throws 404 when no job with the given ID exists in the current process.
 * @returns 200 with the job record.
 */
adminRouter.get('/restore/:jobId', (req, res) => {
  const requestId = req.correlationId;
  const { jobId } = req.params;

  // Lightweight ID validation — cuid2 IDs are 24 characters but allow
  // any non-empty string up to 255 chars to future-proof persistent stores.
  if (!jobId || jobId.trim().length === 0) {
    res.status(400).json(
      errorResponse('VALIDATION_ERROR', 'jobId must be a non-empty string.', undefined, requestId),
    );
    return;
  }

  if (jobId.length > 255) {
    res.status(400).json(
      errorResponse(
        'VALIDATION_ERROR',
        'jobId exceeds maximum length of 255 characters.',
        undefined,
        requestId,
      ),
    );
    return;
  }

  const job = getRestoreJob(jobId);

  if (!job) {
    res.status(404).json(
      errorResponse(
        'NOT_FOUND',
        `Restore job "${jobId}" not found. It may have expired or belong to a different replica.`,
        undefined,
        requestId,
      ),
    );
    return;
  }

  res.json(successResponse({ job }, requestId));
});

/**
 * GET /api/admin/restore
 *
 * Lists all restore jobs in the current process (newest first).
 *
 * In a multi-replica deployment, each replica maintains its own in-memory
 * store; the list reflects only jobs queued on the responding replica.
 *
 * @security Requires valid Bearer admin token (`ADMIN_API_KEY`).
 * @returns 200 with `{ jobs: RestoreJob[] }`.
 */
adminRouter.get('/restore', (req, res) => {
  const requestId = req.correlationId;
  const jobs = listRestoreJobs();
  res.json(successResponse({ jobs }, requestId));
});
