import { Router } from 'express';
import type { Request, Response } from 'express';
import { assessIndexerHealth, DEFAULT_INDEXER_STALL_THRESHOLD_MS } from '../indexer/stall.js';
import { HealthCheckManager, type HealthStatus, type DependencyHealth } from '../config/health.js';
import type { Logger } from '../config/logger.js';
import { Config } from '../config/env.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { isShuttingDown } from '../shutdown.js';
import { getIndexerHealth } from './indexer.js';
import { buildDeploymentChecklistReport } from '../config/deployment.js';

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
  // Return 503 during graceful shutdown.  The body uses a flat shape so
  // operators reading `/health` always see `status` at the top level.
  if (isShuttingDown()) {
    res.status(503).json({
      status: 'shutting_down',
      service: 'fluxora-backend',
      network: req.app.locals.config?.stellarNetwork ?? 'unknown',
      contractAddresses: (req.app.locals.config as Config | undefined)?.contractAddresses ?? {},
      timestamp: new Date().toISOString(),
      message: 'Service is shutting down',
    });
    return;
  }

  const config = req.app.locals.config as Config | undefined;
  let indexerStall;
  try {
    indexerStall = assessIndexerHealth({ stallThresholdMs: DEFAULT_INDEXER_STALL_THRESHOLD_MS });
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
    catchupTelemetry: indexerHealth.catchupTelemetry,
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
healthRouter.get('/ready', async (req: Request, res: Response): Promise<void> => {
  const logger = req.app.locals.logger as Logger | undefined;
  const healthManager = req.app.locals.healthManager as HealthCheckManager | undefined;

  // Return 503 during graceful shutdown
  if (isShuttingDown()) {
    res.status(503).json(errorResponse('SERVICE_SHUTTING_DOWN', 'Service is shutting down'));
    return;
  }

  if (!healthManager) {
    res.status(503).json({
      status: 'unhealthy',
      reason: 'Health manager not configured',
      dependencies: {},
    });
    return;
  }

  try {
    const report = await healthManager.checkAll();

    // Build a flat dependencies map: { [name]: HealthStatus }
    const dependencies: Record<string, HealthStatus> = {};
    for (const dep of report.dependencies) {
      dependencies[dep.name] = dep.status;
    }

    let isReady = true;
    if (report.status === 'unhealthy') {
      isReady = false;
    } else if (report.status === 'degraded') {
      const gracePeriodMs = 30_000;
      const uptimeMs = report.uptime * 1000;
      
      if (uptimeMs < gracePeriodMs) {
        // Startup phase: no grace period, fail readiness until healthy
        isReady = false;
      } else {
        // Steady state: fail if any dependency has been degraded longer than grace period
        const now = Date.now();
        for (const dep of report.dependencies) {
          if (dep.status === 'degraded' && dep.degradedSince) {
            const degradedTime = now - new Date(dep.degradedSince).getTime();
            if (degradedTime >= gracePeriodMs) {
              isReady = false;
              break;
            }
          }
        }
      }
    }

    if (!isReady) {
      logger?.warn('Readiness check failed', req.correlationId, {
        dependencies: report.dependencies.map((d: DependencyHealth) => ({
          name: d.name,
          status: d.status,
          error: d.error,
          degradedSince: d.degradedSince,
        })),
      });
      // 503 for unhealthy or unacceptably degraded
      res.status(503).json({
        status: report.status,
        version: report.version,
        dependencies,
      });
      return;
    }

    res.status(200).json({
      status: report.status, // "healthy" | "degraded"
      version: report.version,
      dependencies,
    });
  } catch (err) {
    logger?.error('Readiness check error', req.correlationId, {
      error: err instanceof Error ? err.message : String(err),
    });
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
    logger?.error('Failed to get health report', req.correlationId, {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json(errorResponse('HEALTH_CHECK_ERROR', 'Failed to get health report'));
  }
});

/**
 * GET /health/deployment - Staging-to-prod deployment parity report
 *
 * Checks configured auth, Redis, background workers, indexer, dependency readiness,
 * and operator metrics to report deployment parity.
 */
healthRouter.get('/deployment', async (req: Request, res: Response) => {
  const config = req.app.locals.config as Config | undefined;
  const healthManager = req.app.locals.healthManager as HealthCheckManager | undefined;
  const logger = req.app.locals.logger as Logger | undefined;

  if (!config) {
    res.status(503).json(errorResponse('HEALTH_CHECK_ERROR', 'Config not loaded'));
    return;
  }

  try {
    const dependencyHealth = healthManager
      ? await healthManager.checkAll()
      : { status: 'healthy' as HealthStatus, version: '0.1.0', timestamp: new Date().toISOString(), uptime: 0, dependencies: [] };
    // getIndexerHealth() returns the ingestion snapshot, which is a different
    // shape; the checklist wants the assessed IndexerHealth.
    const indexerHealth = assessIndexerHealth();
    const report = buildDeploymentChecklistReport({ config, dependencyHealth, indexerHealth });
    const statusCode = report.status === 'fail' ? 503 : 200;
    res.status(statusCode).json({ report });
  } catch (err) {
    logger?.error('Failed to generate deployment report', req.correlationId, {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json(errorResponse('HEALTH_CHECK_ERROR', 'Failed to generate deployment report'));
  }
});

