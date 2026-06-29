import { Router } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import { getHybridBanStoreStatus } from '../redis/banStore.js';
import {
  getPauseFlags,
  setPauseFlags,
  getReindexState,
  triggerReindex,
  AdminStatePersistenceError,
} from '../state/adminState.js';
import { createApiKey, rotateApiKey, revokeApiKey, listApiKeys } from '../lib/apiKey.js';
import { recordAuditEvent, recordAuditEventToDb } from '../lib/auditLog.js';
import { getStreamHub } from '../ws/hub.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { clearIndexerStall, ActiveStallError } from '../indexer/stall.js';

export const adminRouter = Router();

/**
 * GET /api/admin/status/read-only
 * Read-only endpoint for pause-flag visibility without admin credentials.
 * Exposes non-sensitive service posture only.
 */
adminRouter.get('/status/read-only', (_req, res) => {
  const requestId = _req.id ?? _req.correlationId;
  res.json(successResponse({ pauseFlags: getPauseFlags() }, requestId));
});

// Every admin route requires a valid Bearer token.
adminRouter.use(requireAdminAuth);

/**
 * GET /api/admin/status
 * Returns current pause flags and reindex state so operators can
 * inspect service posture at a glance.
 */
adminRouter.get('/status', (_req, res) => {
  const requestId = _req.id ?? _req.correlationId;
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
adminRouter.get('/pause', (_req, res) => {
  const requestId = _req.id ?? _req.correlationId;
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
  const requestId = req.id ?? req.correlationId;
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
adminRouter.get('/reindex', (_req, res) => {
  const requestId = _req.id ?? _req.correlationId;
  res.json(successResponse(getReindexState(), requestId));
});

/**
 * POST /api/admin/reindex
 * Triggers a reindex operation. Returns 409 if one is already running.
 */
adminRouter.post('/reindex', async (_req, res) => {
  const requestId = _req.id ?? _req.correlationId;
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
  const requestId = req.id ?? req.correlationId;
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

// ─── API Key Management ───────────────────────────────────────────────────────

/**
 * GET /api/admin/api-keys
 * Lists all API key records (hashes only — raw keys are never returned).
 */
adminRouter.get('/api-keys', async (_req, res) => {
  const requestId = _req.id ?? _req.correlationId;
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
  const requestId = req.id ?? req.correlationId;
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
    const created = await createApiKey(name, req.correlationId);
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
  const requestId = req.id ?? req.correlationId;
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
  const requestId = req.id ?? req.correlationId;
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
adminRouter.get('/ban-store/status', (_req, res) => {
  try {
    const status = typeof getHybridBanStoreStatus === 'function'
      ? getHybridBanStoreStatus()
      : { available: false, reason: 'getHybridBanStoreStatus not implemented' };
    res.json({ ok: true, banStore: status });
  } catch (err) {
    res.status(503).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
