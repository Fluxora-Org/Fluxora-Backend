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
import { createGrpcHealthServer, startGrpcHealthServer, stopGrpcHealthServer } from './health/grpcHealth.js';
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
import { requireJsonContentType } from './middleware/contentType.js';
import { requireJsonAccept } from './middleware/acceptNegotiation.js';
import { methodOverrideMiddleware } from './middleware/methodOverride.js';
import { httpMetrics } from './middleware/httpMetrics.js';
import { serverTimingMiddleware } from './middleware/serverTiming.js';
import { isShuttingDown, addShutdownHook } from './shutdown.js';
import { startRuntimeMetrics, stopRuntimeMetrics } from './metrics/runtimeMetrics.js';
import { drainSseEventBus } from './streams/sseEmitter.js';
import { requestStopReplay } from './indexer/service.js';
import { initializeIndexerLeaderElection, getIndexerLeaderElection } from './indexer/leaderElection.js';
import { quitAllRedisClients } from './redis/client.js';
import { initializeAdminStateLock } from './state/adminState.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { createDeprecationMiddleware } from './middleware/deprecation.js';
import { routeDeprecations } from './config/deprecations.js';
import { createRateLimitsRouter } from './routes/rateLimits.js';
import { getRateLimitConfig } from './config/rateLimits.js';
import { successResponse, errorResponse } from './utils/response.js';
import { docsRouter } from './routes/docs.js';
import { startVacuumCollector } from './metrics/vacuumCollector.js';
import { startBackgroundJobs } from './jobs/queue.js';

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

/**
 * Wire the idempotency backing store for POST /api/streams.
 *
 * When `REDIS_ENABLED=true` (the default): creates a `RedisIdempotencyStore`
 * backed by the configured Redis instance and calls `setIdempotencyStore()`.
 * The `onStateChange` callback flips `idempotencyDependency` to unavailable on
 * Redis errors so that subsequent `POST /api/streams` requests return 503
 * instead of silently losing cross-instance duplicate protection.
 * A shutdown hook is registered to close the Redis connection cleanly.
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
    addShutdownHook(() => store.close());

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
    addShutdownHook(() => store.close());

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

/**
 * Initialize distributed locking for adminState pause flags.
 *
 * When `REDIS_ENABLED=true` (the default): wires a Redis-backed distributed lock
 * that coordinates pause-flag writes across multiple processes.
 * Falls back to file-based locking if Redis is unavailable.
 *
 * This function never rejects — all errors are caught and logged internally.
 */
async function wireAdminStateLock(config: Config): Promise<void> {
  if (!config.redisEnabled) {
    logger.info(
      'Redis disabled — adminState will use file-based locking for pause flags',
      undefined,
      { component: 'admin-state-lock' },
    );
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

    initializeAdminStateLock(redisClient);

    logger.info('Redis adminState lock wired', undefined, {
      component: 'admin-state-lock',
    });
  } catch (err) {
    logger.warn(
      'Redis connection failed for adminState lock — falling back to file-based locking',
      undefined,
      {
        component: 'admin-state-lock',
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

/**
 * Blue/green deployment slot middleware.
 *
 * Emits `X-Fluxora-Deployment-Slot` on every response so that a front-side
 * load balancer or the e2e suite can verify which slot answered a request
 * during a blue/green cutover.
 *
 * The slot is read from `DEPLOYMENT_SLOT` env var at request time (not module
 * load) so that the same binary can serve either slot depending on how it is
 * launched. Defaults to `"blue"` when the env var is absent or empty.
 *
 * Security: the header value is constrained to alphanumeric + hyphens to
 * prevent header injection. Any non-conforming value is replaced with `"blue"`.
 */
function deploymentSlotMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = process.env.DEPLOYMENT_SLOT ?? 'blue';
  // Sanitise: only allow [a-z0-9-] to prevent header injection.
  const slot = /^[a-z0-9-]+$/i.test(raw) ? raw : 'blue';
  res.setHeader('X-Fluxora-Deployment-Slot', slot);
  next();
}

/**
 * Wire Redis-backed distributed leader election for indexer replay.
 *
 * When `REDIS_ENABLED=true` (the default): wires a Redis-backed lease so only
 * one replica runs indexer replay at a time in a multi-instance deployment.
 * Falls back to the always-leader `NoOpLeaderElection` (today's single-process
 * behaviour) when Redis is disabled or unreachable.
 *
 * This function never rejects — all errors are caught and logged internally.
 */
async function wireIndexerLeaderElection(config: Config): Promise<void> {
  if (!config.redisEnabled) {
    logger.info(
      'Redis disabled — indexer replay leader election running in always-leader (single-instance) mode',
      undefined,
      { component: 'indexer-leader-election' },
    );
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

    initializeIndexerLeaderElection(redisClient);

    logger.info('Redis indexer leader election wired', undefined, {
      component: 'indexer-leader-election',
    });
  } catch (err) {
    logger.warn(
      'Redis connection failed for indexer leader election — falling back to always-leader mode',
      undefined,
      {
        component: 'indexer-leader-election',
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const { trustProxy } = getRateLimitConfig(env);
  app.set('trust proxy', trustProxy);
  const rateLimiter = createRateLimiter(env);

  startRuntimeMetrics();
  addShutdownHook(() => {
    stopRuntimeMetrics();
  });

  // Shutdown hook ordering (runs after server.close() drains HTTP):
  //   1. Drain SSE — close open event-stream responses with retry:0.
  //   2. Stop indexer — signal replay loop to stop at next safe batch boundary.
  //   3. Release the indexer leader-election lease — must happen before Redis
  //      is closed, and after replay has been signalled to stop, so another
  //      instance can take over promptly instead of waiting out the full lease.
  //   4. Quit Redis — close all tracked Redis sockets.
  addShutdownHook(() => drainSseEventBus(appConfig.sseDrainTimeoutMs));
  addShutdownHook(() => requestStopReplay());
  addShutdownHook(() => getIndexerLeaderElection().release());
  addShutdownHook(() => quitAllRedisClients());

  // Expose the limiter on app.locals so index.ts can register a shutdown hook
  app.locals.rateLimiter = rateLimiter;

  // Inject config and healthManager into app.locals for route handlers
  if (options.config) {
    app.locals.config = options.config;
  }
  if (options.healthManager) {
    app.locals.healthManager = options.healthManager;
  }

  if (options.pool) {
    app.locals.vacuumInterval = startVacuumCollector(options.pool);
    startBackgroundJobs(options.pool);
  }

  // Wire the Redis-backed idempotency store (fire-and-forget; errors handled internally).
  const appConfig = options.config ?? loadConfig();
  void wireIdempotencyStore(appConfig);
  void wireWebhookCircuitBreakerStore(appConfig);
  void wireAdminStateLock(appConfig);
  void wireIndexerLeaderElection(appConfig);

  // Optional grpc.health.v1.Health service for Kubernetes-native gRPC probes,
  // on a separate port from the HTTP server so it never competes with API
  // traffic. Requires a healthManager (same dependency-check logic as
  // /health/ready) — without one there is nothing meaningful to reuse.
  if (options.healthManager && appConfig.grpcHealthEnabled) {
    const grpcHealthServer = createGrpcHealthServer(options.healthManager);
    app.locals.grpcHealthServer = grpcHealthServer;
    startGrpcHealthServer(grpcHealthServer, appConfig.grpcHealthPort).catch((err) => {
      logger.warn('gRPC health server failed to start', undefined, {
        component: 'grpc-health',
        error: err instanceof Error ? err.message : String(err),
      });
    });
    addShutdownHook(() => stopGrpcHealthServer(grpcHealthServer));
  }

  // Blue/green slot header — must run before any response can be sent.
  app.use(deploymentSlotMiddleware);

  app.use(requestTimeoutMiddleware(options.requestTimeoutMs ?? appConfig.requestTimeoutMs));
  app.use(privacyHeaders);
  app.use(cspNonceMiddleware);
  app.use(createHelmetMiddleware());
  app.use(bodySizeLimitMiddleware);
  app.use('/api', requireJsonContentType);
  app.use('/api', requireJsonAccept);
  // Correlation ID must run before express.json() so req.correlationId is available
  // even when JSON parsing throws and the error handler fires immediately.
  app.use(correlationIdMiddleware);
  app.use(express.json({ limit: BODY_LIMIT_BYTES }));
  app.use(methodOverrideMiddleware);
  app.use(apiVersionMiddleware);
  app.use(corsAllowlistMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(serverTimingMiddleware());
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
    const requestId = req.correlationId ?? req.id;
    res.status(404).json(
      errorResponse('NOT_FOUND', 'The requested resource was not found', undefined, requestId),
    );
  });

  app.use(errorHandler);

  return app;
}

export const app = createApp();
export default app;
