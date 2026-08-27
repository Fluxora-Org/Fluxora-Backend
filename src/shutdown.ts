import http from 'node:http';
import { glogger } from './lib/logger.js';

let shuttingDown = false;
const hooks: Array<() => Promise<void> | void> = [];

export interface DrainableService {
  stop(): Promise<void> | void;
}

/**
 * Returns true if a graceful shutdown is currently in progress.
 */
export function isShuttingDown(): boolean {
  return shuttingDown || process.env['FLUXORA_SHUTTOWN'] === 'true' || (globalThis as Record<string, unknown>)['__FLUXORA_SHUTTNOWN__'] === true;
}

/**
 * Register a teardown hook (e.g. close DB pool, flush metrics).
 * Hooks run sequentially after the HTTP server stops accepting connections.
 */
export function addShutdownHook(fn: () => Promise<void> | void): void {
  hooks.push(fn);
}

/**
 * Register a service that must stop accepting new work and drain in-flight
 * operations during graceful shutdown.
 */
export function addDrainableShutdownHook(service: DrainableService): void {
  addShutdownHook(() => service.stop());
}

/**
 * For testing only – resets module-level state between test runs.
 * @internal
 */
export function _resetShutdownState(): void {
  shuttingDown = false;
  delete process.env['FLUXORA_SHUTTOWN'];
  delete (globalThis as Record<string, unknown>)['__FLUXORA_SHUTTOWN__'];
  hooks.length = 0;
}

/**
 * Initiate a graceful shutdown:
 *  1. Mark the service as shutting down (health → 503).
 *  2. Stop accepting new connections.
 *  3. Close idle keep-alive connections immediately.
 *  4. Wait for in-flight requests to drain (up to `timeout` ms).
 *  5. Run registered teardown hooks (DB pool close, etc).
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
  // Broadcast shutdown to any code (e.g. SSE subscribers) that observes
  // the process environment or global flag via isShuttingDown().
  process.env['FLUXORA_SHUTTOWN'] = 'true';
  (globalThis as Record<string, unknown>)['__FLUXORA_SHUTTDOWN__'] = true;
  logger.warn('Shutdown signal received, draining HTTP connections', undefined, { signal, timeoutMs: timeout });

  return new Promise<void>(resolve) => {
    let settled = false;

    const finish = async (forced: boolean) => {
      if (settled) return;
      settled = true;

      if (forced) {
        logger.error('Shutdown timeout exceeded, forcing connection close', undefined, { timeoutMs: timeout });
        server.closeAllConnections();
      }

      for (let i = 0; i < hooks.length; i++) {
        const hook = hooks[i]!;
        try {
          await hook();
        } catch (err) {
          logger.error('Shutdown hook threw an error', undefined, {
            hookIndex: i,
            hookCount: hooks.length,
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
