import { Router } from 'express';
import type { Request, Response } from 'express';
import { assessIndexerHealth, DEFAULT_INDEXER_STALL_THRESHOLD_MS } from '../indexer/stall.js';
import { HealthCheckManager, type HealthStatus, type DependencyHealth } from '../config/health.js';
import { checkInstanceReadiness } from '../health/readiness.js';
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
    res.status(503).json(errorResponse('SERVICE_SHUTTING_DOWN', 'Service is shutting down', {
      status: 'shutting_down',
      service: 'fluxora-backend',
      network: req.app.locals.config?.stellarNetwork ?? 'unknown',
      contractAddresses: (req.app.locals.config as Config | undefined)?.contractAddresses ?? {},
      timestamp: new Date().toISOString(),
    }));
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
 * The readiness verdict comes from `checkInstanceReadiness()`
 * (src/health/readiness.ts) — the same source the gRPC health service uses —
 * so this route and `grpc.health.v1.Health.Check` can never disagree about
 * the same instance.
 *
 * Degraded classification:
 *  - All dependencies healthy → 200, status "healthy"
 *  - Any dependency degraded within the grace period → 200, status "degraded"
 *  - Any dependency degraded during startup, or degraded past the grace
 *    period (high latency) → 503, status "degraded"
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
    res.status(503).json(errorResponse('SERVICE_UNAVAILABLE', 'Health manager not configured', { dependencies: {} }));
    return;
  }

  try {
    // One `checkAll()` for both surfaces: the report drives the verdict and
    // the per-dependency statuses reported here.
    const { report, assessment } = await checkInstanceReadiness(healthManager);
    const { ready, status, dependencies, blocking, reason } = assessment;

    if (!ready) {
      logger?.warn('Readiness check failed', req.correlationId, {
        reason,
        blocking,
        dependencies: report.dependencies.map((d: DependencyHealth) => ({
          name: d.name,
          status: d.status,
          error: d.error,
          degradedSince: d.degradedSince,
        })),
      });
      // 503 for unhealthy or unacceptably degraded
      res.status(503).json(errorResponse('HEALTH_CHECK_ERROR', reason ?? 'Service is not ready', {
        status,
        version: report.version,
        dependencies,
      }));
      return;
    }

    res.status(200).json({
      status, // "healthy" | "degraded"
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
    if (statusCode === 503) {
      res.status(statusCode).json(errorResponse('HEALTH_CHECK_ERROR', 'Service readiness check failed', { report }));
    } else {
      res.status(statusCode).json({ report });
    }
  } catch (err) {
    logger?.error('Failed to generate deployment report', req.correlationId, {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json(errorResponse('HEALTH_CHECK_ERROR', 'Failed to generate deployment report'));
  }
});

