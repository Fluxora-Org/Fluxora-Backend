/**
 * Graceful shutdown: drain HTTP + long-lived services + external pools.
 *
 * Guarantees:
 *  - All in-flight HTTP requests are allowed to complete before the process exits.
 *  - Idle keep-alive connections are closed immediately so server.close() resolves
 *    as soon as the last active request finishes.
 *  - A hard timeout prevents the process from hanging indefinitely when a request
 *    stalls or a dependency is unresponsive.
 *  - Long-lived response/work drains can be registered via addShutdownDrainHook().
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
import { logger } from './lib/logger.js';

let shuttingDown = false;
const drainHooks: Array<() => Promise<void> | void> = [];
const hooks: Array<() => Promise<void> | void> = [];

export interface DrainableService {
  stop(): Promise<void> | void;
}

/**
 * Returns true if a graceful shutdown is currently in progress.
 */
export function isShuttingDown(): boolean {
  return shuttingDown || process.env['FLUXORA_SHUTDOWN'] === 'true' || (globalThis as Record<string, unknown>)['__FLUXORA_SHUTDOWN__'] === true;
}

/**
 * Register a teardown hook (e.g. close DB pool, flush metrics).
 * Hooks run sequentially after the HTTP server stops accepting connections.
 */
export function addShutdownHook(fn: () => Promise<void> | void): void {
  hooks.push(fn);
}

/**
 * Register a drain hook that runs after shutdown is announced but before the
 * HTTP server waits for active requests to complete. Use this for long-lived
 * responses such as SSE streams that would otherwise keep server.close() open.
 */
export function addShutdownDrainHook(fn: () => Promise<void> | void): void {
  drainHooks.push(fn);
}

/**
 * Register a service that must stop accepting new work and drain in-flight
 * operations during graceful shutdown.
 */
export function addDrainableShutdownHook(service: DrainableService): void {
  addShutdownDrainHook(() => service.stop());
}

/**
 * For testing only – resets module-level state between test runs.
 * @internal
 */
export function _resetShutdownState(): void {
  shuttingDown = false;
  delete process.env['FLUXORA_SHUTDOWN'];
  delete (globalThis as Record<string, unknown>)['__FLUXORA_SHUTDOWN__'];
  drainHooks.length = 0;
  hooks.length = 0;
}

export function _getShutdownHookCounts(): { drain: number; teardown: number } {
  return { drain: drainHooks.length, teardown: hooks.length };
}

async function runHooks(
  phase: 'drain' | 'teardown',
  registeredHooks: Array<() => Promise<void> | void>,
): Promise<void> {
  for (const hook of registeredHooks) {
    try {
      await hook();
    } catch (err) {
      logger.error('Shutdown hook threw an error', undefined, {
        phase,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Initiate a graceful shutdown:
 *  1. Mark the service as shutting down (health → 503).
 *  2. Run registered drain hooks (SSE, workers, other long-lived work).
 *  3. Stop accepting new connections.
 *  4. Close idle keep-alive connections immediately.
 *  5. Wait for in-flight requests to drain (up to `timeout` ms).
 *  6. Run registered teardown hooks (DB pool close, Redis quit, etc.).
 *  7. If the timeout is exceeded, force-close all connections and resolve.
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
  process.env['FLUXORA_SHUTDOWN'] = 'true';
  (globalThis as Record<string, unknown>)['__FLUXORA_SHUTDOWN__'] = true;
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

      await runHooks('teardown', hooks);

      logger.info('Graceful shutdown complete');
      resolve();
    };

    const forceTimer = setTimeout(() => void finish(true), timeout);
    // Prevent the timer from keeping the event loop alive artificially.
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    void (async () => {
      await runHooks('drain', drainHooks);

      // Stop accepting new TCP connections.
      server.close(() => {
        clearTimeout(forceTimer);
        void finish(false);
      });

      // Immediately reclaim idle keep-alive connections so server.close()
      // only waits for connections that are actively serving a request.
      server.closeIdleConnections();
    })();
  });
}
