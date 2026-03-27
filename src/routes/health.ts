import express from 'express';
import type { Request, Response } from 'express';
import { assessIndexerHealth } from '../indexer/stall.js';
import { getCacheClient } from '../cache/redis.js';

export const healthRouter = express.Router();

/**
 * GET /health
 *
 * Liveness probe — always 200 so load-balancers know the process is alive.
 * `status` reflects indexer freshness and dependency health so operators
 * can distinguish running-but-degraded from dead.
 *
 * Trust boundary: public, read-only — no authentication required.
 */
healthRouter.get('/', async (_req: Request, res: Response) => {
  const indexer = assessIndexerHealth({ enabled: false });
  const indexerDegraded = indexer.status === 'stalled' || indexer.status === 'starting';

  // Check Redis health
  const cache = getCacheClient();
  const redisPing = await cache.ping();
  const redisStatus = redisPing ? 'healthy' : 'unavailable';

  const status = indexerDegraded ? 'degraded' : 'ok';

  res.json({
    status,
    service: 'fluxora-backend',
    timestamp: new Date().toISOString(),
    indexer,
    dependencies: {
      redis: { status: redisStatus },
    },
  });
});
