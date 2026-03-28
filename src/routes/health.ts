import { Router, Request, Response } from 'express';
import { getIndexerHealth } from './indexer.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { HealthCheckManager } from '../config/health.js';
import { Logger } from '../config/logger.js';
import { Config } from '../config/env.js';

import { isShuttingDown } from '../shutdown.js';

export const healthRouter = Router();

/**
 * GET /health - Liveness + basic system status
 */
healthRouter.get('/', (req: Request, res: Response) => {
  const config = req.app.locals.config as Config | undefined;

  if (isShuttingDown()) {
    return res.status(503).json({
      status: 'shutting_down',
      service: 'fluxora-backend',
      timestamp: new Date().toISOString(),
    });
  }

  const indexer = getIndexerHealth();

  const status =
    indexer.dependency === 'unavailable' || indexer.dependency === 'degraded'
      ? 'degraded'
      : 'ok';

  return res.json({
    status,
    service: 'fluxora-backend',
    network: config?.stellarNetwork ?? 'unknown',
    timestamp: new Date().toISOString(),
    dependencies: {
      indexer,
    },
  });
});

/**
 * GET /health/ready - Readiness probe
 */
healthRouter.get('/ready', async (req: Request, res: Response) => {
  const healthManager = req.app.locals.healthManager as HealthCheckManager;
  const logger = req.app.locals.logger as Logger;

  try {
    const report = await healthManager.checkAll();

    if (report.status === 'unhealthy') {
      logger.warn('Readiness check failed', {
        dependencies: report.dependencies.map((d: any) => ({
          name: d.name,
          status: d.status,
          error: d.error,
        })),
      });

      return res.status(503).json(
        errorResponse(
          'Service not ready',
          'SERVICE_UNAVAILABLE',
          JSON.stringify(report)
        )
      );
    }

    return res.json(successResponse({ report }));
  } catch (err) {
    logger.error('Readiness check error', err as Error);

    return res.status(503).json(
      errorResponse('Health check failed', 'HEALTH_CHECK_ERROR')
    );
  }
});

/**
 * GET /health/live - Detailed health report
 */
healthRouter.get('/live', async (req: Request, res: Response) => {
  const healthManager = req.app.locals.healthManager as HealthCheckManager;
  const config = req.app.locals.config as Config;
  const logger = req.app.locals.logger as Logger;

  try {
    const report = healthManager.getLastReport(config.apiVersion);
    return res.json(successResponse({ report }));
  } catch (err) {
    logger.error('Failed to get health report', err as Error);

    return res.status(500).json(
      errorResponse('Failed to get health report', 'HEALTH_CHECK_ERROR')
    );
  }
});

/**
 * Readiness check - service can handle requests
 */
healthRouter.get("/ready", (_req: Request, res: Response) => {
  const dbHealth = checkDatabaseHealth();
  const health = getHealthMetrics();

  const isReady = dbHealth.healthy && health.healthy;

  res.status(isReady ? 200 : 503).json({
    status: isReady ? "ready" : "not_ready",
    timestamp: new Date().toISOString(),
    checks: {
      database: dbHealth,
      metrics: health.checks,
    },
  });
});

/**
 * Metrics endpoint for monitoring
 */
healthRouter.get("/metrics", (_req: Request, res: Response) => {
  const health = getHealthMetrics();

  res.json({
    timestamp: new Date().toISOString(),
    ...health,
  });
});
