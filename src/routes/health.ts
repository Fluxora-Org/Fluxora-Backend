import { Router } from 'express';

import {
  DEFAULT_INDEXER_STALL_THRESHOLD_MS,
  assessIndexerHealth,
} from '../indexer/stall.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  const indexer = assessIndexerHealth({
    enabled: process.env.INDEXER_ENABLED === 'true',
    lastSuccessfulSyncAt: process.env.INDEXER_LAST_SUCCESS_AT,
    stallThresholdMs: Number(process.env.INDEXER_STALL_THRESHOLD_MS)
      || DEFAULT_INDEXER_STALL_THRESHOLD_MS,
  });

  res.json({
    status: indexer.status === 'stalled' || indexer.status === 'starting'
      ? 'degraded'
      : 'ok',
    service: 'fluxora-backend',
    timestamp: new Date().toISOString(),
    indexer,
  });
});
