import { Router, Request, Response } from 'express';
import { HealthCheckManager } from '../config/health.js';
import { Logger } from '../config/logger.js';
import { Config } from '../config/env.js';
import { successResponse, errorResponse } from '../utils/response.js';

export const healthRouter = Router();

/**
 * GET /health - Liveness probe
 * Returns 200 if service is running.
 * Success: { success: true, data: { status, service, network, contractAddresses }, meta }
 */
healthRouter.get('/', (req: Request, res: Response) => {
  const config = req.app.locals.config as Config | undefined;
  res.json(successResponse({
    status: 'ok',
    service: 'fluxora-backend',
    network: config?.stellarNetwork ?? 'unknown',
    contractAddresses: config?.contractAddresses ?? {},
  }));
});

/**
 * GET /health/ready - Readiness probe
 * Returns 200 only if all dependencies are healthy.
 * Unhealthy: 503 { success: false, error, code, details }
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
        errorResponse('Service not ready', 'SERVICE_UNAVAILABLE', JSON.stringify(report))
      );
    }

    res.json(successResponse({ report }));
  } catch (err) {
    logger.error('Readiness check error', err as Error);
    res.status(503).json(
      errorResponse('Health check failed', 'HEALTH_CHECK_ERROR')
    );
  }
});

/**
 * GET /health/live - Detailed health report
 * Returns current health status and dependency details.
 */
healthRouter.get('/live', async (req: Request, res: Response) => {
  const healthManager = req.app.locals.healthManager as HealthCheckManager;
  const config = req.app.locals.config as Config;

  try {
    const report = healthManager.getLastReport(config.apiVersion);
    res.json(successResponse({ report }));
  } catch (err) {
    res.status(500).json(
      errorResponse('Failed to get health report', 'HEALTH_CHECK_ERROR')
    );
  }
});
