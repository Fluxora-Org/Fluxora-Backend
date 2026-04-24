import { Router } from 'express';
import type { Request, Response } from 'express';
import { assessIndexerHealth, DEFAULT_INDEXER_STALL_THRESHOLD_MS } from '../indexer/stall.js';
import { HealthCheckManager, type HealthStatus } from '../config/health.js';
import { Logger } from '../config/logger.js';
import { Config } from '../config/env.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { isShuttingDown } from '../shutdown.js';

export const healthRouter = Router();

/**
 * GET /health - Liveness + basic system status
 *
 * Observable behaviour:
 *  - Returns 503 during graceful shutdown.
 *  - Returns status "degraded" when the indexer is stalled or starting.
 *  - Returns status "ok" otherwise.
 *  - Never exposes internal config values (connection strings, secrets).
 */
healthRouter.get('/', (req: Request, res: Response) => {
  // Return 503 during graceful shutdown
  if (isShuttingDown()) {
    res.status(503).json(
      successResponse({
        status: 'shutting_down',
        service: 'fluxora-backend',
        network: req.app.locals.config?.stellarNetwork ?? 'unknown',
        contractAddresses: (req.app.locals.config as Config | undefined)?.contractAddresses ?? {},
        timestamp: new Date().toISOString(),
        message: 'Service is shutting down',
      })
    );
    return;
  }

  const config = req.app.locals.config as Config | undefined;
  let indexerStall;
  try {
    indexer = assessIndexerHealth({ stallThresholdMs: DEFAULT_INDEXER_STALL_THRESHOLD_MS });
  } catch {
    indexerStall = { status: 'unknown' };
  }
  const status =
    indexerStall.status === 'stalled' || indexerStall.status === 'starting' ? 'degraded' : 'ok';

  const indexerHealth = getIndexerHealth();

  res.json({
    status,
    service: 'fluxora-backend',
    network: config?.stellarNetwork ?? 'unknown',
    contractAddresses: config?.contractAddresses ?? {},
    timestamp: new Date().toISOString(),
    indexer: indexerStall,
    dependencies: {
      indexer: indexerHealth,
    },
  });
});

/**
 * GET /health/ready - Readiness probe
 *
 * Degraded classification:
 *  - All dependencies healthy → 200, status "healthy"
 *  - Any dependency degraded (high latency) → 200, status "degraded"
 *  - Any dependency unhealthy (error / timeout) → 503, status "unhealthy"
 *  - No health manager configured → 503
 *
 * Security:
 *  - Error messages are sanitised by checkers before reaching this layer.
 *  - Connection strings and credentials never appear in the response body.
 *  - The flat `dependencies` map exposes only status strings, not raw errors,
 *    to unauthenticated callers.
 *
 * Observable behaviour:
 *  - `dependencies` is a flat map of { [name]: HealthStatus } for easy
 *    consumption by load-balancer health checks and dashboards.
 *  - `version` is always present for cache-busting and audit trails.
 */
healthRouter.get('/ready', async (req: Request, res: Response) => {
  // Return 503 during graceful shutdown
  if (isShuttingDown()) {
    return res.status(503).json(errorResponse('SERVICE_SHUTTING_DOWN', 'Service is shutting down'));
  }

  try {
    const report = await healthManager.checkAll();

    // Build a flat dependencies map: { [name]: HealthStatus }
    const dependencies: Record<string, HealthStatus> = {};
    for (const dep of report.dependencies) {
      dependencies[dep.name] = dep.status;
    }

    if (report.status === 'unhealthy') {
      logger?.warn('Readiness check failed', {
        dependencies: report.dependencies.map((d) => ({
          name: d.name,
          status: d.status,
          error: d.error,
        })),
      });
      return res.status(503).json(errorResponse('SERVICE_UNAVAILABLE', 'Service not ready', report));
    }

    // "degraded" is still ready — return 200 so load balancers keep routing
    // traffic, but signal the degraded state for observability.
    return res.status(200).json({
      status: report.status, // "healthy" | "degraded"
      version: report.version,
      dependencies,
    });
  } catch (err) {
    logger.error('Readiness check error', err as Error);
    res.status(503).json(errorResponse('HEALTH_CHECK_ERROR', 'Health check failed'));
  }
});

/**
 * GET /health/live - Detailed health report (admin-gated in staging/production)
 *
 * Returns the full HealthReport including per-dependency latency and error
 * details. Intended for internal dashboards and on-call engineers.
 */
healthRouter.get('/live', async (req: Request, res: Response) => {
  const healthManager = req.app.locals.healthManager as HealthCheckManager | undefined;
  const config = req.app.locals.config as Config | undefined;
  const logger = req.app.locals.logger as Logger | undefined;
  try {
    const report = healthManager
      ? healthManager.getLastReport(config?.apiVersion)
      : { status: 'healthy', version: '0.1.0', timestamp: new Date().toISOString(), uptime: 0, dependencies: [] };
    res.json(successResponse({ report }));
  } catch (err) {
    logger.error('Failed to get health report', err as Error);
    res.status(500).json(errorResponse('HEALTH_CHECK_ERROR', 'Failed to get health report'));
  }
});
