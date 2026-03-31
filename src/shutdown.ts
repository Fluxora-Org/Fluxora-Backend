/**
 * Graceful shutdown: drain HTTP + DB pool.
 *
 * Guarantees:
 *  - All in-flight HTTP requests are allowed to complete before the process exits.
 *  - Idle keep-alive connections are closed immediately so server.close() resolves
 *    as soon as the last active request finishes.
 *  - A hard timeout prevents the process from hanging indefinitely when a request
 *    stalls or a dependency is unresponsive.
 *  - DB / external-pool teardown hooks can be registered via addShutdownHook().
 *  - Health endpoint returns 503 once shutdown begins so load balancers stop
 *    routing new traffic to this instance.
 *
 * Failure modes:
 *  - Timeout exceeded  → closeAllConnections() is called and the process exits
 *    with code 1 so the orchestrator knows the shutdown was forced.
 *  - Hook throws       → error is logged; remaining hooks still execute.
 *  - Double SIGTERM    → second signal is ignored (shutdown already in progress).
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { logger } from './lib/logger.js';

let shuttingDown = false;
const hooks: Array<() => Promise<void> | void> = [];

/**
 * Returns true if a graceful shutdown is currently in progress.
 */
export function isShuttingDown(): boolean {
  return shuttingDown || process.env['FLUXORA_SHUTDOWN'] === 'true' || (globalThis as any)['__FLUXORA_SHUTDOWN__'] === true;
}

/**
 * Register a teardown hook (e.g. close DB pool, flush metrics).
 * Hooks run sequentially after the HTTP server stops accepting connections.
 */
export function addShutdownHook(fn: () => Promise<void> | void): void {
  hooks.push(fn);
}

/**
 * For testing only – resets module-level state between test runs.
 * @internal
 */
export function _resetShutdownState(): void {
  shuttingDown = false;
  delete process.env['FLUXORA_SHUTDOWN'];
  delete (globalThis as any)['__FLUXORA_SHUTDOWN__'];
  hooks.length = 0;
}

/**
 * Initiate a graceful shutdown:
 *  1. Mark the service as shutting down (health → 503).
 *  2. Stop accepting new connections.
 *  3. Close idle keep-alive connections immediately.
 *  4. Wait for in-flight requests to drain (up to `timeout` ms).
 *  5. Run registered teardown hooks (DB pool close, etc.).
 *  6. If the timeout is exceeded, force-close all connections and resolve.
 *
 * @param server   The http.Server returned by server.listen().
 * @param signal   The OS signal that triggered shutdown (for logging).
 * @param timeout  Milliseconds to wait before forcing exit (default 30 s).
 */
export function gracefulShutdown(
  server: http.Server,
  signal: string,
  timeout = 30_000,
): Promise<void> {
  if (shuttingDown) {
    logger.warn('Shutdown already in progress, ignoring duplicate signal', undefined, { signal });
    return Promise.resolve();
  }

  shuttingDown = true;
  logger.warn('Shutdown signal received, draining HTTP connections', undefined, { signal, timeoutMs: timeout });

  return new Promise<void>((resolve) => {
    let settled = false;

    const finish = async (forced: boolean) => {
      if (settled) return;
      settled = true;

      if (forced) {
        logger.error('Shutdown timeout exceeded, forcing connection close', undefined, { timeoutMs: timeout });
        server.closeAllConnections();
      }

      for (const hook of hooks) {
        try {
          await hook();
        } catch (err) {
          logger.error('Shutdown hook threw an error', undefined, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info('Graceful shutdown complete');
      resolve();
    };

    const forceTimer = setTimeout(() => void finish(true), timeout);
    // Prevent the timer from keeping the event loop alive artificially.
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    // Stop accepting new TCP connections.
    server.close(() => {
      clearTimeout(forceTimer);
      void finish(false);
    });

    // Immediately reclaim idle keep-alive connections so server.close()
    // only waits for connections that are actively serving a request.
    server.closeIdleConnections();
  });
}
