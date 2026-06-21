import { Router } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import { Permission, requireScope } from '../middleware/auth.js';
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

export const adminRouter = Router();

/**
 * GET /api/admin/status/read-only
 * Read-only endpoint for pause-flag visibility without admin credentials.
 * Exposes non-sensitive service posture only.
 */
adminRouter.get('/status/read-only', (_req, res) => {
  res.json({ pauseFlags: getPauseFlags() });
});

// Every admin route requires a valid Bearer token.
adminRouter.use(requireAdminAuth);

/**
 * GET /api/admin/status
 * Returns current pause flags and reindex state so operators can
 * inspect service posture at a glance.
 */
adminRouter.get('/status', requireScope(Permission.ADMIN_READ), (_req, res) => {
  res.json({
    pauseFlags: getPauseFlags(),
    reindex: getReindexState(),
  });
});

/**
 * GET /api/admin/pause
 * Read-only view of the current pause flags.
 */
adminRouter.get('/pause', requireScope(Permission.ADMIN_PAUSE), (_req, res) => {
  res.json(getPauseFlags());
});

/**
 * PUT /api/admin/pause
 * Update one or both pause flags.
 *
 * Body (all fields optional):
 *   { "streamCreation": true, "ingestion": false }
 */
adminRouter.put('/pause', requireScope(Permission.ADMIN_PAUSE), (req, res) => {
  const { streamCreation, ingestion } = req.body ?? {};

  if (streamCreation === undefined && ingestion === undefined) {
    res.status(400).json({
      error: 'Request body must include at least one of: streamCreation, ingestion.',
    });
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
    res.status(400).json({ error: errors.join(' ') });
    return;
  }

  const previous = getPauseFlags();
  let updated;
  try {
    updated = setPauseFlags({ streamCreation, ingestion });
  } catch (err) {
    if (err instanceof AdminStatePersistenceError) {
      res.status(503).json({
        error: 'Unable to persist pause flags. Try again later.',
      });
      return;
    }
    throw err;
  }

  recordAuditEvent('PAUSE_FLAGS_UPDATED', 'pauseFlags', 'system', req.correlationId, {
    previous,
    updated,
    ...(streamCreation !== undefined ? { streamCreation } : {}),
    ...(ingestion !== undefined ? { ingestion } : {}),
  });

  res.json({ message: 'Pause flags updated.', pauseFlags: updated });
});

/**
 * GET /api/admin/reindex
 * Returns the current reindex job state.
 */
adminRouter.get('/reindex', requireScope(Permission.ADMIN_REINDEX), (_req, res) => {
  res.json(getReindexState());
});

/**
 * POST /api/admin/reindex
 * Triggers a reindex operation. Returns 409 if one is already running.
 */
adminRouter.post('/reindex', requireScope(Permission.ADMIN_REINDEX), async (_req, res) => {
  const current = getReindexState();
  if (current.status === 'running') {
    res.status(409).json({
      error: 'A reindex operation is already in progress.',
      reindex: current,
    });
    return;
  }

  const state = await triggerReindex();

  recordAuditEvent('REINDEX_TRIGGERED', 'reindex', 'system', _req.correlationId, {
    status: state.status,
    startedAt: state.startedAt,
  });

  res.status(202).json({
    message: 'Reindex started.',
    reindex: state,
  });
});

/**
 * POST /api/admin/ws/disconnect
 * Forcibly closes every active WebSocket subscription for a given stream_id.
 */
adminRouter.post('/ws/disconnect', requireScope(Permission.ADMIN_PAUSE), async (req, res) => {
  const { stream_id: streamIdValue } = req.body ?? {};

  if (typeof streamIdValue !== 'string') {
    res.status(400).json({ error: 'stream_id (string) is required.' });
    return;
  }

  const streamId = streamIdValue.trim();
  if (streamId.length === 0) {
    res.status(400).json({ error: 'stream_id (string) is required.' });
    return;
  }

  const hub = getStreamHub();
  if (!hub) {
    res.status(503).json({
      error: 'WebSocket hub is not initialized. Try again after the service starts.',
    });
    return;
  }

  const disconnectedCount = hub.disconnectByStreamId(streamId);

  try {
    await recordAuditEventToDb('ADMIN_WS_DISCONNECT', 'stream', streamId, req.correlationId, {
      disconnectedCount,
      closeCode: 4000,
      closeReason: 'admin-forced-disconnect',
    });
  } catch {
    res.status(503).json({
      error: 'Unable to persist audit log entry. Try again later.',
      disconnectedCount,
    });
    return;
  }

  res.json({
    message: 'WebSocket subscribers disconnected.',
    stream_id: streamId,
    disconnectedCount,
  });
});

// ─── API Key Management ───────────────────────────────────────────────────────

/**
 * GET /api/admin/api-keys
 * Lists all API key records (hashes only — raw keys are never returned).
 */
adminRouter.get('/api-keys', requireScope(Permission.ADMIN_API_KEYS), (_req, res) => {
  res.json({ apiKeys: listApiKeys() });
});

/**
 * POST /api/admin/api-keys
 * Creates a new API key. The raw key is returned exactly once.
 *
 * Body: { "name": "my-service", "scopes": ["streams:read"] }
 */
adminRouter.post('/api-keys', requireScope(Permission.ADMIN_API_KEYS), (req, res) => {
  const { name, scopes } = req.body ?? {};
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name (string) is required.' });
    return;
  }
  try {
    const created = createApiKey(name, scopes);
    recordAuditEvent(
      'API_KEY_CREATED',
      'api_key',
      created.id,
      req.correlationId,
      {
        prefix: created.prefix,
        name: created.name,
        scopes: created.scopes,
      },
    );
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/admin/api-keys/:id/rotate
 * Issues a new raw key for an existing key record. The old key is immediately
 * invalidated. The new raw key is returned exactly once.
 */
adminRouter.post('/api-keys/:id/rotate', requireScope(Permission.ADMIN_API_KEYS), (req, res) => {
  try {
    const rotated = rotateApiKey(req.params.id);
    recordAuditEvent(
      'API_KEY_ROTATED',
      'api_key',
      rotated.id,
      req.correlationId,
      {
        prefix: rotated.prefix,
        name: rotated.name,
        scopes: rotated.scopes,
      },
    );
    res.json(rotated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

/**
 * DELETE /api/admin/api-keys/:id
 * Revokes an API key. Revoked keys cannot authenticate requests.
 */
adminRouter.delete('/api-keys/:id', requireScope(Permission.ADMIN_API_KEYS), (req, res) => {
  try {
    revokeApiKey(req.params.id);
    recordAuditEvent(
      'API_KEY_REVOKED',
      'api_key',
      req.params.id,
      req.correlationId,
    );
    res.status(204).send();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});
