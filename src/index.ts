/**
 * Fluxora Backend — process entry point.
 *
 * Responsibilities:
 * 1. Run tiered startup dependency probes (Postgres hard-fail, Redis/Stellar-RPC
 *    retry-with-backoff) before accepting traffic.
 * 2. Start the HTTP server.
 * 3. Register graceful-shutdown handlers (SIGTERM, SIGINT).
 * 4. Register a SIGHUP handler for zero-downtime hot-reload of
 *    rate-limit and feature-flag configuration (issue #764).
 *
 * ## Startup Probe Strategy
 * Postgres is a *hard* dependency: if it is unreachable the process exits
 * immediately with a structured error log, short-circuiting the orchestrator's
 * readiness wait. Redis and Stellar RPC are *soft* dependencies: they are
 * retried with decorrelated-jitter backoff up to `STARTUP_PROBE_BUDGET_MS`
 * and the service starts in a *degraded* mode when they remain unreachable.
 *
 * The SIGHUP handler hot-swaps only the whitelisted subset of config
 * (rate limits, feature flags, tracing sample rate, log level) without
 * tearing down the HTTP server, database pool, or Redis connections.
 * Restart-only keys (DATABASE_URL, REDIS_URL, JWT_SECRET, etc.) are
 * detected and a warning is logged, but their new values are NOT applied.
 */

import { app } from './app.js';
import { gracefulShutdown } from './shutdown.js';
import { indexerService } from './indexer/service.js';
import { checkAdminStatePersistence } from './state/adminState.js';
import {
  captureStartupEnvSnapshot,
  refreshHotConfig,
  getConfig,
} from './config/env.js';
import { setRuntimeRateLimitConfig } from './config/rateLimits.js';
import { prepareReloadFlags } from './config/featureFlags.js';
import { logger } from './lib/logger.js';
import { probeStartupDependencies } from './config/health.js';
import { startTracing } from './tracing/index.js';
import { initLogsBridge } from './tracing/logsBridge.js';
import {
  recordConfigReloadFailure,
  recordConfigReloadSuccess,
} from './metrics.js';

let server: ReturnType<typeof app.listen> | undefined;

if (process.env.NODE_ENV !== 'test') {
  // app.ts calls initializeConfig() at module load, so getConfig() is safe here.
  const cfg = getConfig();

  /**
   * Startup initialization sequence:
   * 1. Capture startup env snapshot for restart-only-key detection.
   * 2. Start the OpenTelemetry SDK and activate the logs bridge.
   * 3. Run tiered startup dependency probes.
   * 4. Validate admin state file writability (graceful degradation on failure).
   * 5. Start the HTTP server and begin accepting requests.
   * 6. Resume any incomplete indexer replays from the database checkpoint.
   */
  captureStartupEnvSnapshot();

  (async () => {
    startTracing();
    initLogsBridge({ enabled: cfg.tracingOtelEnabled });

    /**
     * Postgres probe: attempt a single SELECT 1 via a transient pg.Client.
     * Uses a dedicated short-lived connection so it does not touch the pool.
     */
    const postgresProbe = async (): Promise<void> => {
      const { Client } = await import('pg');
      const client = new Client({ connectionString: cfg.databaseUrl });
      try {
        await client.connect();
        await client.query('SELECT 1');
      } finally {
        client.end().catch(() => { /* intentionally silent */ });
      }
    };

    /**
     * Redis probe: send a PING using a transient ioredis client.
     */
    const redisProbe = async (): Promise<void> => {
      if (!cfg.redisEnabled) return;
      const { Redis } = await import('ioredis');
      const client = new Redis(cfg.redisUrl, {
        lazyConnect: true,
        connectTimeout: cfg.startupProbeRedisTimeoutMs,
        maxRetriesPerRequest: 0,
        enableReadyCheck: false,
      });
      try {
        await client.connect();
        const pong = await client.ping();
        if (pong.toUpperCase() !== 'PONG') {
          throw new Error(`Unexpected PING response: ${pong}`);
        }
      } finally {
        client.disconnect();
      }
    };

    /**
     * Stellar RPC probe: call getLatestLedger on the configured RPC URL.
     */
    const stellarRpcProbe = async (): Promise<void> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), cfg.startupProbeStellarTimeoutMs);
      try {
        const response = await fetch(cfg.stellarRpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getLatestLedger',
            params: {},
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Stellar RPC responded with HTTP ${response.status}`);
        }
        const json = (await response.json()) as { result?: { sequence?: number } };
        if (typeof json.result?.sequence !== 'number') {
          throw new Error('Stellar RPC returned an invalid ledger response');
        }
      } finally {
        clearTimeout(timeoutId);
      }
    };

    await probeStartupDependencies({
      probes: [
        { name: 'postgres',    tier: 'hard', probe: postgresProbe,   timeoutMs: cfg.startupProbePostgresTimeoutMs },
        { name: 'redis',       tier: 'soft', probe: redisProbe,      timeoutMs: cfg.startupProbeRedisTimeoutMs },
        { name: 'stellar_rpc', tier: 'soft', probe: stellarRpcProbe, timeoutMs: cfg.startupProbeStellarTimeoutMs },
      ],
      budgetMs: cfg.startupProbeBudgetMs,
    });

    void checkAdminStatePersistence();

    server = app.listen(cfg.port, () => {
      logger.info('server:listening', undefined, {
        port: cfg.port,
        env: cfg.nodeEnv,
      });

      indexerService.resumeIncompleteReplay().catch((err) => {
        logger.error('indexer:resume_failed', undefined, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    process.on('SIGTERM', () => void gracefulShutdown(server!, 'SIGTERM'));
    process.on('SIGINT',  () => void gracefulShutdown(server!, 'SIGINT'));
  })().catch((err) => {
    logger.error('startup:fatal', undefined, {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });

  /**
   * SIGHUP — hot-reload whitelisted config without restarting the process.
   *
   * What is reloaded:
   *   - Rate-limit windows and max values (setRuntimeRateLimitConfig)
   *   - Feature flag definitions (reloadFlags)
   *   - TRACING_SAMPLE_RATE, TRACING_ENABLED, LOG_LEVEL
   *
   * What is NOT reloaded (restart required):
   *   - DATABASE_URL, REDIS_URL, JWT_SECRET, INDEXER_WORKER_TOKEN
   */
  process.on('SIGHUP', () => {
    logger.info('SIGHUP received — hot-reloading config', undefined, { component: 'sighup-reload' });

    void refreshHotConfig({
      prepareRateLimits: (hot) => {
        const nextConfig = {
          ip:     { windowMs: hot.rateLimitIpWindowMs     ?? 60_000, max: hot.rateLimitIpMax     ?? 100,  enabled: true },
          apiKey: { windowMs: hot.rateLimitApikeyWindowMs ?? 60_000, max: hot.rateLimitApikeyMax ?? 500,  enabled: true },
          admin:  { windowMs: hot.rateLimitAdminWindowMs  ?? 60_000, max: hot.rateLimitAdminMax  ?? 2000, enabled: true },
        };
        return () => setRuntimeRateLimitConfig(nextConfig);
      },
      prepareFeatureFlags: () => prepareReloadFlags(),
      prepareLogLevel: (level) => () => { process.env.LOG_LEVEL = level; },
      onSuccess: (result) => {
        recordConfigReloadSuccess({
          changed: result.changed,
          durationMs: result.durationMs,
          generation: result.generation,
        });
        logger.info('SIGHUP config reload complete', undefined, {
          component: 'sighup-reload',
          generation: result.generation,
          changed: result.changed,
          durationMs: result.durationMs,
          restartOnlyChanges: result.restartOnlyChanges,
          rateLimitIpWindowMs: result.hot.rateLimitIpWindowMs,
          rateLimitIpMax: result.hot.rateLimitIpMax,
          rateLimitApikeyWindowMs: result.hot.rateLimitApikeyWindowMs,
          rateLimitApikeyMax: result.hot.rateLimitApikeyMax,
          tracingSampleRate: result.hot.tracingSampleRate,
          tracingEnabled: result.hot.tracingEnabled,
          logLevel: result.hot.logLevel,
        });
      },
      onFailure: (err, durationMs) => {
        recordConfigReloadFailure(durationMs);
        logger.warn('SIGHUP config reload failed', undefined, {
          component: 'sighup-reload',
          error: err instanceof Error ? err.message : String(err),
          durationMs,
        });
      },
    }).catch(() => {
      // onFailure already recorded metrics + logged; swallow to keep process alive.
    });
  });
}
