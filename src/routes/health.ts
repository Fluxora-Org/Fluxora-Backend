import { Router, Request, Response } from 'express';

import {
  DEFAULT_INDEXER_STALL_THRESHOLD_MS,
  assessIndexerHealth,
} from '../indexer/stall.js';

export const healthRouter = Router();

healthRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    status: indexer.status === 'stalled' || indexer.status === 'starting'
      ? 'degraded'
      : 'ok',
    service: 'fluxora-backend',
    timestamp: new Date().toISOString(),
    indexer,
  });
});

/**
 * GET /health/ready - Readiness probe
 * Returns 200 only if all dependencies are healthy
 */
healthRouter.get('/ready', async (req: Request, res: Response) => {
  const healthManager = req.app.locals.healthManager as HealthCheckManager;
  const logger = req.app.locals.logger as Logger;
  const config = req.app.locals.config as Config;

  try {
    const report = await healthManager.checkAll();

    if (report.status === 'unhealthy') {
      logger.warn('Readiness check failed', {
        dependencies: report.dependencies.map(d => ({
          name: d.name,
          status: d.status,
          error: d.error,
        })),
      });
      return res.status(503).json(report);
    }

    res.json(report);
  } catch (err) {
    logger.error('Readiness check error', err as Error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
    });
  }
});

/**
 * GET /health/live - Detailed health report
 * Returns current health status and dependency details
 */
healthRouter.get('/live', async (req: Request, res: Response) => {
  const healthManager = req.app.locals.healthManager as HealthCheckManager;
  const config = req.app.locals.config as Config;

  try {
    const report = healthManager.getLastReport(config.apiVersion);
    res.json(report);
  } catch (err) {
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Failed to get health report',
    });
  }
});
