import { Router } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  getPauseFlags,
  setPauseFlags,
  getReindexState,
  triggerReindex,
} from '../state/adminState.js';

export const adminRouter = Router();

// Every admin route requires a valid Bearer token.
adminRouter.use(requireAdminAuth);

/**
 * GET /api/admin/status
 * Returns current pause flags and reindex state so operators can
 * inspect service posture at a glance.
 */
adminRouter.get('/status', (_req, res) => {
  res.json({
    pauseFlags: getPauseFlags(),
    reindex: getReindexState(),
  });
});

/**
 * GET /api/admin/pause
 * Read-only view of the current pause flags.
 */
adminRouter.get('/pause', (_req, res) => {
  res.json(getPauseFlags());
});

/**
 * PUT /api/admin/pause
 * Update one or both pause flags.
 *
 * Body (all fields optional):
 *   { "streamCreation": true, "ingestion": false }
 */
adminRouter.put('/pause', (req, res) => {
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

  const updated = setPauseFlags({ streamCreation, ingestion });
  res.json({ message: 'Pause flags updated.', pauseFlags: updated });
});

/**
 * GET /api/admin/reindex
 * Returns the current reindex job state.
 */
adminRouter.get('/reindex', (_req, res) => {
  res.json(getReindexState());
});

/**
 * POST /api/admin/reindex
 * Triggers a reindex operation. Returns 409 if one is already running.
 */
adminRouter.post('/reindex', async (_req, res) => {
  const current = getReindexState();
  if (current.status === 'running') {
    res.status(409).json({
      error: 'A reindex operation is already in progress.',
      reindex: current,
    });
    return;
  }

  const state = await triggerReindex();
  res.status(202).json({
    message: 'Reindex started.',
    reindex: state,
  });
});
