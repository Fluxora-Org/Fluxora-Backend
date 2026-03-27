import express from 'express';
import type { Request, Response } from 'express';
import { assessIndexerHealth } from '../indexer/stall.js';

import { HealthCheckManager } from '../config/health.js';
import { Logger } from '../config/logger.js';
import { Config } from '../config/env.js';
import { successResponse, errorResponse } from '../utils/response.js';

import {
  DEFAULT_INDEXER_STALL_THRESHOLD_MS,
  assessIndexerHealth,
} from '../indexer/stall.js';

export const healthRouter = Router();

    enabled: false,
    stallThresholdMs: DEFAULT_INDEXER_STALL_THRESHOLD_MS,
  });

  res.json({
    status: indexer.status === 'stalled' || indexer.status === 'starting'
/**
 * GET /health - Liveness + basic system status
 */
healthRouter.get('/', (req: Request, res: Response) => {
  const config = req.app.locals.config as Config | undefined;

  // Assess indexer health (safe fallback if not present)
  let indexer;
  try {
    indexer = assessIndexerHealth({
      thresholdMs: DEFAULT_INDEXER_STALL_THRESHOLD_MS,
    });
  } catch {
    indexer = { status: 'unknown' };
  }

  const status =
    indexer.status === 'stalled' || indexer.status === 'starting'
      ? 'degraded'
      : 'ok';

  res.json(
    successResponse({
      status,
      service: 'fluxora-backend',
      network: config?.stellarNetwork ?? 'unknown',
      contractAddresses: config?.contractAddresses ?? {},
      timestamp: new Date().toISOString(),
      indexer,
    })
  );
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
          report
        )
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
 */
healthRouter.get('/live', async (req: Request, res: Response) => {
  const healthManager = req.app.locals.healthManager as HealthCheckManager;
  const config = req.app.locals.config as Config;
  const logger = req.app.locals.logger as Logger;

  try {
    const report = healthManager.getLastReport(config.apiVersion);
    res.json(successResponse({ report }));
  } catch (err) {
    logger.error('Failed to get health report', err as Error);

    res.status(500).json(
      errorResponse('Failed to get health report', 'HEALTH_CHECK_ERROR')
    );
  }
});
