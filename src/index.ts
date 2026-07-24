/**
 * Fluxora Backend — process entry point.
 *
 * Responsibilities:
 * 1. Start the HTTP server.
 * 2. Register graceful-shutdown handlers (SIGTERM, SIGINT).
 * 3. Register a SIGHUP handler for zero-downtime hot-reload of
 *    rate-limit and feature-flag configuration (issue #764).
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
} from './config/env.js';
import { setRuntimeRateLimitConfig } from './config/rateLimits.js';
import { reloadFlags } from './config/featureFlags.js';
import { logger } from './lib/logger.js';

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
   * 2. Validate admin state file writability (graceful degradation on failure).
   * 3. Start the HTTP server and begin accepting requests.
   * 4. Resume any incomplete indexer replays from the database checkpoint.
   */
  captureStartupEnvSnapshot();
  void checkAdminStatePersistence();

  // Start server
  server = app.listen(config.server.port, () => {
    console.log(`Indexer service listening on port ${config.server.port}`);
    console.log(`Replay batch size: ${config.indexer.replayBatchSize}`);

    // Auto-resume any incomplete replays from the database checkpoint
    indexerService.resumeIncompleteReplay().catch((err) => {
      console.error('Failed to resume incomplete replays on startup:', err);
    });
  });

  // Delegate to the single graceful-shutdown path so all registered hooks
  // (SSE drain, indexer stop, Redis quit, DB pool close) run on SIGTERM.
  process.on('SIGTERM', () => void gracefulShutdown(server!, 'SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown(server!, 'SIGINT'));

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
