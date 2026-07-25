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

import express from 'express';
import { config } from './config/index.js';
import { indexerRouter } from './routes/indexer.js';
import { gracefulShutdown } from './shutdown.js';
import { indexerService } from './indexer/service.js';
import { checkAdminStatePersistence } from './state/adminState.js';
import {
  captureStartupEnvSnapshot,
  reloadHotConfig,
  loadConfig,
} from './config/env.js';
import { setRuntimeRateLimitConfig } from './config/rateLimits.js';
import { reloadFlags } from './config/featureFlags.js';
import { logger } from './lib/logger.js';
import { probeStartupDependencies } from './config/health.js';

const app = express();

// Middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Indexer routes
app.use(indexerRouter);

// Error handling middleware
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message,
  });
});

let server: ReturnType<typeof app.listen> | undefined;

if (process.env.NODE_ENV !== 'test') {
  /**
   * Startup initialization sequence:
   * 1. Capture startup env snapshot for restart-only-key detection.
   * 2. Run tiered startup dependency probes:
   *    - Postgres (hard): single attempt, fast-fail on error.
   *    - Redis (soft): retry-with-backoff, degrade on budget exhaustion.
   *    - Stellar RPC (soft): retry-with-backoff, degrade on budget exhaustion.
   * 3. Validate admin state file writability (graceful degradation on failure).
   * 4. Start the HTTP server and begin accepting requests.
   * 5. Resume any incomplete indexer replays from the database checkpoint.
   */
  captureStartupEnvSnapshot();

  (async () => {
    const cfg = loadConfig();

    // ── Tiered startup probing ────────────────────────────────────────────
    // Build lightweight probes that do not require full client initialisation.
    // Each probe function attempts a minimal connectivity check.

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
        // Silently ignore errors on disconnect — we only care about the probe
        client.end().catch(() => { /* intentionally silent */ });
      }
    };

    /**
     * Redis probe: send a PING using a transient ioredis client.
     * Connection is immediately closed after the probe regardless of outcome.
     */
    const redisProbe = async (): Promise<void> => {
      if (!cfg.redisEnabled) return; // Redis explicitly disabled — treat as success
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
     * Uses fetch so there is no dependency on the full stellar-rpc client.
     */
    const stellarRpcProbe = async (): Promise<void> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        cfg.startupProbeStellarTimeoutMs,
      );
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
        {
          name: 'postgres',
          tier: 'hard',
          probe: postgresProbe,
          timeoutMs: cfg.startupProbePostgresTimeoutMs,
        },
        {
          name: 'redis',
          tier: 'soft',
          probe: redisProbe,
          timeoutMs: cfg.startupProbeRedisTimeoutMs,
        },
        {
          name: 'stellar_rpc',
          tier: 'soft',
          probe: stellarRpcProbe,
          timeoutMs: cfg.startupProbeStellarTimeoutMs,
        },
      ],
      budgetMs: cfg.startupProbeBudgetMs,
    });

    // ── Admin state & server start ────────────────────────────────────────
    void checkAdminStatePersistence();

    server = app.listen(config.server.port, () => {
      logger.info('server:listening', undefined, {
        port: config.server.port,
        replayBatchSize: config.indexer.replayBatchSize,
      });

      // Auto-resume any incomplete replays from the database checkpoint
      indexerService.resumeIncompleteReplay().catch((err) => {
        logger.error('indexer:resume_failed', undefined, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    // Delegate to the single graceful-shutdown path so all registered hooks
    // (SSE drain, indexer stop, Redis quit, DB pool close) run on SIGTERM.
    process.on('SIGTERM', () => void gracefulShutdown(server!, 'SIGTERM'));
    process.on('SIGINT', () => void gracefulShutdown(server!, 'SIGINT'));
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
   *   - Rate-limit windows and max values (applied via setRuntimeRateLimitConfig)
   *   - Feature flag definitions (applied via reloadFlags)
   *   - TRACING_SAMPLE_RATE, TRACING_ENABLED, LOG_LEVEL (logged; callers
   *     should re-read from reloadHotConfig() result when needed)
   *
   * What is NOT reloaded (restart required):
   *   - DATABASE_URL, REDIS_URL, JWT_SECRET, INDEXER_WORKER_TOKEN
   *   - Any variable requiring a new DB/Redis connection
   *
   * Safety:
   *   - reloadHotConfig() builds the config atomically before returning.
   *   - setRuntimeRateLimitConfig() performs a single object-assignment swap.
   *   - Any thrown error is caught and logged; the process is never killed.
   */
  process.on('SIGHUP', () => {
    logger.info('SIGHUP received — hot-reloading config', undefined, {
      component: 'sighup-reload',
    });

    try {
      const hot = reloadHotConfig();

      // 1. Hot-swap rate-limit config
      setRuntimeRateLimitConfig({
        ip: {
          windowMs: hot.rateLimitIpWindowMs ?? 60_000,
          max: hot.rateLimitIpMax ?? 100,
          enabled: true,
        },
        apiKey: {
          windowMs: hot.rateLimitApikeyWindowMs ?? 60_000,
          max: hot.rateLimitApikeyMax ?? 500,
          enabled: true,
        },
        admin: {
          windowMs: hot.rateLimitAdminWindowMs ?? 60_000,
          max: hot.rateLimitAdminMax ?? 2000,
          enabled: true,
        },
      });

      // 2. Hot-swap feature flags
      const reloadedFlags = reloadFlags();

      logger.info('SIGHUP config reload complete', undefined, {
        component: 'sighup-reload',
        rateLimitIpWindowMs: hot.rateLimitIpWindowMs,
        rateLimitIpMax: hot.rateLimitIpMax,
        rateLimitApikeyWindowMs: hot.rateLimitApikeyWindowMs,
        rateLimitApikeyMax: hot.rateLimitApikeyMax,
        tracingSampleRate: hot.tracingSampleRate,
        tracingEnabled: hot.tracingEnabled,
        logLevel: hot.logLevel,
        featureFlagCount: reloadedFlags.size,
      });
    } catch (err) {
      // Never crash the process on a failed reload.
      logger.warn('SIGHUP config reload failed', undefined, {
        component: 'sighup-reload',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export { app };
