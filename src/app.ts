import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import type pg from 'pg';
import { streamsRouter, setIdempotencyStore, setIdempotencyDependencyState } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { indexerRouter } from './routes/indexer.js';
import { auditRouter } from './routes/audit.js';
import { adminRouter } from './routes/admin.js';
import { dlqRouter } from './routes/dlq.js';
import { authRouter } from './routes/auth.js';
import { webhooksRouter } from './routes/webhooks.js';
import { privacyRouter } from './routes/privacy.js';
import { privacyHeaders } from './middleware/pii.js';
import type { Config } from './config/env.js';
import { loadConfig } from './config/env.js';
import type { HealthCheckManager } from './config/health.js';
import { createRedisClient } from './redis/client.js';
import { RedisIdempotencyStore, NoOpIdempotencyStore } from './redis/idempotencyStore.js';
import {
  createWebhookCircuitBreakerStore,
  setWebhookCircuitBreakerStore,
  InMemoryWebhookCircuitBreakerStore,
} from './redis/webhookCircuitBreakerStore.js';
import { logger } from './lib/logger.js';
import { cspNonceMiddleware, createHelmetMiddleware } from './middleware/helmet.js';
import { metricsRouter } from './routes/metrics.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { corsAllowlistMiddleware } from './middleware/cors.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import {
  bodySizeLimitMiddleware,
  requestTimeoutMiddleware,
  BODY_LIMIT_BYTES,
} from './middleware/requestProtection.js';
import { apiVersionMiddleware } from './middleware/apiVersion.js';
import { httpMetrics } from './middleware/httpMetrics.js';
import { isShuttingDown, addShutdownHook, addShutdownDrainHook } from './shutdown.js';
import { startRuntimeMetrics, stopRuntimeMetrics } from './metrics/runtimeMetrics.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { createDeprecationMiddleware } from './middleware/deprecation.js';
import { routeDeprecations } from './config/deprecations.js';
import { createRateLimitsRouter } from './routes/rateLimits.js';
import { getRateLimitConfig } from './config/rateLimits.js';
import { successResponse, errorResponse } from './utils/response.js';
import { docsRouter } from './routes/docs.js';
import { startVacuumCollector } from './metrics/vacuumCollector.js';
import { indexerService } from './indexer/service.js';
import { drainSseConnections } from './streams/sseEmitter.js';

export interface AppOptions {
  /** When true, mounts a /__test/error and /__test/timeout route. */
  includeTestRoutes?: boolean;
  /** Environment variables used to seed the rate-limiter (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Socket-level request timeout in ms (defaults to 30000). */
  requestTimeoutMs?: number;
  /** Optional Config instance to expose to route handlers via `app.locals.config`. */
  config?: Config;
  /** Optional health-check manager exposed via `app.locals.healthManager`. */
  healthManager?: HealthCheckManager;
  /**
   * Optional pg.Pool used to start the Postgres VACUUM metrics collector.
   * When provided, a 60-second setInterval is registered and the handle is
   * stored on app.locals.vacuumInterval for graceful shutdown.
   * Omit in tests that do not require VACUUM metrics.
   */
  pool?: pg.Pool;
}

function registerProcessDrainHooks(): void {
  addShutdownDrainHook(() => {
    drainSseConnections();
  });
  addShutdownDrainHook(() => indexerService.stop());
}

/**
 * Wire the idempotency backing store for POST /api/streams.
 *
 * When `REDIS_ENABLED=true` (the default): creates a `RedisIdempotencyStore`
 * backed by the configured Redis instance and calls `setIdempotencyStore()`.
 * The `onStateChange` callback flips `idempotencyDependency` to unavailable on
 * Redis errors so that subsequent `POST /api/streams` requests return 503
 * instead of silently losing cross-instance duplicate protection.
 * Redis sockets created here are closed by the central Redis shutdown hook.
 *
 * When `REDIS_ENABLED=false`: installs a `NoOpIdempotencyStore` and logs a
 * warning about degraded idempotency semantics (no cross-instance dedup).
 *
 * The TTL is sourced from `config.idempotencyTtlSeconds`
 * (`IDEMPOTENCY_TTL_SECONDS` env var, default 86 400 s / 24 h).
 *
 * This function never rejects — all errors are caught and logged internally.
 */
async function wireIdempotencyStore(config: Config): Promise<void> {
  if (!config.redisEnabled) {
    logger.warn(
      'Redis disabled — stream idempotency running in NoOp mode; cross-instance duplicate protection is not enforced',
      undefined,
      { component: 'idempotency-store', ttlSeconds: config.idempotencyTtlSeconds },
    );
    setIdempotencyStore(new NoOpIdempotencyStore(), config.idempotencyTtlSeconds);
    return;
  }

  try {
    const redisClient = await createRedisClient({
      url: config.redisUrl,
      enabled: config.redisEnabled,
      mode: config.redisMode,
      sentinelHosts: config.redisSentinelHosts,
      sentinelName: config.redisSentinelName,
      clusterNodes: config.redisClusterNodes,
    });

    const store = new RedisIdempotencyStore(redisClient, {
      onStateChange: (healthy: boolean) =>
        setIdempotencyDependencyState(healthy ? 'healthy' : 'unavailable'),
    });

    setIdempotencyStore(store, config.idempotencyTtlSeconds);

    logger.info(
      'Redis idempotency store wired',
      undefined,
      { component: 'idempotency-store', ttlSeconds: config.idempotencyTtlSeconds },
    );
  } catch (err) {
    logger.warn(
      'Redis connection failed for idempotency store — POST /api/streams will return 503 until Redis is restored',
      undefined,
      {
        component: 'idempotency-store',
        error: err instanceof Error ? err.message : String(err),
      },
    );
    setIdempotencyDependencyState('unavailable');
  }
}

async function wireWebhookCircuitBreakerStore(config: Config): Promise<void> {
  if (!config.redisEnabled) {
    logger.warn(
      'Redis disabled — webhook circuit breaker using in-process fallback; state is not shared across instances',
      undefined,
      { component: 'webhook-circuit-breaker' },
    );
    setWebhookCircuitBreakerStore(new InMemoryWebhookCircuitBreakerStore());
    return;
  }

  try {
    const redisClient = await createRedisClient({
      url: config.redisUrl,
      enabled: config.redisEnabled,
      mode: config.redisMode,
      sentinelHosts: config.redisSentinelHosts,
      sentinelName: config.redisSentinelName,
      clusterNodes: config.redisClusterNodes,
    });

    const store = createWebhookCircuitBreakerStore(redisClient);
    setWebhookCircuitBreakerStore(store);

    logger.info('Redis webhook circuit breaker store wired', undefined, {
      component: 'webhook-circuit-breaker',
    });
  } catch (err) {
    logger.warn(
      'Redis connection failed for webhook circuit breaker — falling back to in-process store',
      undefined,
      {
        component: 'webhook-circuit-breaker',
        error: err instanceof Error ? err.message : String(err),
      },
    );
    setWebhookCircuitBreakerStore(new InMemoryWebhookCircuitBreakerStore());
  }
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const rateLimiter = createRateLimiter(env);

  registerProcessDrainHooks();
  startRuntimeMetrics();
  addShutdownHook(() => {
    stopRuntimeMetrics();
  });

  // Expose the limiter on app.locals so index.ts can register a shutdown hook
  app.locals.rateLimiter = rateLimiter;
  addShutdownHook(() => rateLimiter.close());

  // Inject config and healthManager into app.locals for route handlers
  if (options.config) {
    app.locals.config = options.config;
  }
  if (options.healthManager) {
    app.locals.healthManager = options.healthManager;
  }

  if (options.pool) {
    const vacuumInterval = startVacuumCollector(options.pool);
    app.locals.vacuumInterval = vacuumInterval;
    addShutdownHook(() => {
      clearInterval(vacuumInterval);
    });
  }

  // Wire the Redis-backed idempotency store (fire-and-forget; errors handled internally).
  const appConfig = options.config ?? loadConfig();
  void wireIdempotencyStore(appConfig);
  void wireWebhookCircuitBreakerStore(appConfig);

  app.use(requestTimeoutMiddleware(options.requestTimeoutMs ?? appConfig.requestTimeoutMs));
  app.use(privacyHeaders);
  app.use(cspNonceMiddleware);
  app.use(createHelmetMiddleware());
  app.use(bodySizeLimitMiddleware);
  app.use(express.json({ limit: BODY_LIMIT_BYTES }));
  // Correlation ID must be first so all subsequent middleware/routes have req.correlationId.
  app.use(correlationIdMiddleware);
  app.use(apiVersionMiddleware);
  app.use(corsAllowlistMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(httpMetrics);
  app.use(createDeprecationMiddleware(routeDeprecations));
  app.use(rateLimiter);

  app.use((_req: Request, res: Response, next: NextFunction) => {
    if (isShuttingDown()) {
      res.setHeader('Connection', 'close');
    }
    next();
  });

  if (options.includeTestRoutes) {
    app.get('/__test/error', () => {
      throw new Error('Intentional test error');
    });
    app.get('/__test/timeout', () => {
      return;
    });
  }

  // Metrics endpoint - requires Bearer token (ADMIN_API_KEY) for Prometheus scraping
  app.use('/metrics', metricsRouter);

  // OpenAPI spec and Swagger UI — no auth required
  app.use(docsRouter);

  app.use('/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/streams', streamsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/internal/indexer', indexerRouter);
  app.use('/internal/webhooks', webhooksRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/privacy', privacyRouter);
  app.use('/admin/dlq', dlqRouter);
  app.use('/api/rate-limits', createRateLimitsRouter(rateLimiter, { defaults: getRateLimitConfig(env) }));

  app.get('/', (_req: Request, res: Response) => {
    res.json(
      successResponse({
        name: 'Fluxora API',
        version: '0.1.0',
        docs: 'Programmable treasury streaming on Stellar.',
      }),
    );
  });

  app.use((req: Request, res: Response) => {
    const requestId = req.id;
    res.status(404).json(
      errorResponse('NOT_FOUND', 'The requested resource was not found', undefined, requestId),
    );
  });

  app.use(errorHandler);

  return app;
}

export const app = createApp();
export default app;
