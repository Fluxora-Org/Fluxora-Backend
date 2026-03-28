import { Router, Request, Response } from 'express';
import { getIndexerHealth } from './indexer.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { HealthCheckManager } from '../config/health.js';
import { Logger } from '../config/logger.js';
import { Config } from '../config/env.js';
import { isShuttingDown } from '../shutdown.js';

export const healthRouter = Router();

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

healthRouter.get('/ready', async (req: Request, res: Response) => {
  const healthManager = req.app.locals.healthManager as HealthCheckManager | undefined;
  const logger = req.app.locals.logger as Logger | undefined;

  if (!healthManager) {
    logger?.warn('Health manager missing for readiness check');
    return res.status(503).json(
      errorResponse('Health manager not configured', 'SERVICE_UNAVAILABLE')
    );
  }

  try {
    const report = await healthManager.checkAll();
    const dependencies = Object.fromEntries(
      report.dependencies.map((dependency) => [dependency.name, dependency.status])
    ) as Record<string, string>;

    const payload = {
      status: report.status,
      version: report.version,
      timestamp: report.timestamp,
      uptime: report.uptime,
      dependencies,
    };

    if (report.status === 'unhealthy') {
      logger?.warn('Readiness check failed', { dependencies });
      return res.status(503).json(payload);
    }

    return res.json(payload);
  } catch (err) {
    logger?.error('Readiness check error', err as Error);
    return res.status(503).json(
      errorResponse('Health check failed', 'HEALTH_CHECK_ERROR')
    );
  }
});

healthRouter.get('/live', async (req: Request, res: Response) => {
  const healthManager = req.app.locals.healthManager as HealthCheckManager | undefined;
  const config = req.app.locals.config as Config | undefined;
  const logger = req.app.locals.logger as Logger | undefined;

  if (!healthManager) {
    logger?.warn('Health manager missing for live health report');
    return res.status(503).json(
      errorResponse('Health manager not configured', 'SERVICE_UNAVAILABLE')
    );
  }

  try {
    const report = healthManager.getLastReport(config?.apiVersion ?? '0.1.0');
    return res.json(successResponse({ report }));
  } catch (err) {
    logger?.error('Failed to get health report', err as Error);
    return res.status(500).json(
      errorResponse('Failed to get health report', 'HEALTH_CHECK_ERROR')
    );
  }
});
