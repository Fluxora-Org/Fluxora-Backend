import { sseActiveConnectionsGauge } from '../metrics/businessMetrics.js';

export const DEFAULT_SSE_MAX_CONNECTIONS_PER_IP = 10;
export const DEFAULT_SSE_MAX_GLOBAL_CONNECTIONS = 1000;
export const DEFAULT_SSE_MAX_CONNECTION_DURATION_MS = 30 * 60 * 1000;
export const DEFAULT_SSE_RETRY_AFTER_SECONDS = 15;

const MAX_SSE_CONNECTION_LIMIT = 100_000;
const MAX_SSE_CONNECTION_DURATION_MS = 86_400_000;
const MAX_SSE_RETRY_AFTER_SECONDS = 86_400;

export type SseConnectionRejectionReason = 'per_ip_limit' | 'global_limit';

export interface SseConnectionLimits {
  maxConnectionsPerIp: number;
  maxGlobalConnections: number;
  maxConnectionDurationMs: number;
  retryAfterSeconds: number;
}

export interface AcceptedSseConnection {
  readonly ip: string;
  readonly acceptedAt: number;
  readonly limits: SseConnectionLimits;
  /**
   * Release the active SSE connection exactly once.
   *
   * The route can safely call this from close, abort, timeout, write-error,
   * and pre-header failure paths without double-decrementing the per-IP/global
   * counters or the active Prometheus gauge.
   */
  release(): void;
}

export type SseConnectionAttempt =
  | { ok: true; connection: AcceptedSseConnection }
  | {
      ok: false;
      reason: SseConnectionRejectionReason;
      message: string;
      limits: SseConnectionLimits;
      retryAfterSeconds: number;
      activeConnections: number;
      activeConnectionsForIp: number;
    };

const activeConnectionsByIp = new Map<string, number>();
let activeConnections = 0;

function normalizeIp(ip: string): string {
  const normalized = ip.trim();
  return normalized.length > 0 ? normalized : 'unknown';
}

function readBoundedPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/**
 * Resolve the SSE limiter knobs from the current process environment.
 *
 * `src/config/env.ts` validates the same variables at startup. This resolver is
 * intentionally request-time rather than module-load-time so tests and runtime
 * configuration reloads do not require reconstructing the router singleton. The
 * bounded fallback parser mirrors the EnvSchema ranges so an invalid late
 * process.env mutation cannot accidentally create unbounded listener/socket
 * budgets.
 */
export function resolveSseConnectionLimits(
  env: NodeJS.ProcessEnv = process.env,
): SseConnectionLimits {
  return {
    maxConnectionsPerIp: readBoundedPositiveInteger(
      env,
      'SSE_MAX_CONNECTIONS_PER_IP',
      DEFAULT_SSE_MAX_CONNECTIONS_PER_IP,
      1,
      MAX_SSE_CONNECTION_LIMIT,
    ),
    maxGlobalConnections: readBoundedPositiveInteger(
      env,
      'SSE_MAX_GLOBAL_CONNECTIONS',
      DEFAULT_SSE_MAX_GLOBAL_CONNECTIONS,
      1,
      MAX_SSE_CONNECTION_LIMIT,
    ),
    maxConnectionDurationMs: readBoundedPositiveInteger(
      env,
      'SSE_MAX_CONNECTION_DURATION_MS',
      DEFAULT_SSE_MAX_CONNECTION_DURATION_MS,
      1,
      MAX_SSE_CONNECTION_DURATION_MS,
    ),
    retryAfterSeconds: readBoundedPositiveInteger(
      env,
      'SSE_RETRY_AFTER_SECONDS',
      DEFAULT_SSE_RETRY_AFTER_SECONDS,
      1,
      MAX_SSE_RETRY_AFTER_SECONDS,
    ),
  };
}

/**
 * Atomically check and reserve capacity for a new SSE stream.
 *
 * The implementation is O(1): one global counter plus one Map lookup for the
 * caller IP. No per-connection arrays are retained, so cleanup is bounded and
 * independent of total connection volume.
 */
export function tryAcquireSseConnection(
  ip: string,
  limits: SseConnectionLimits = resolveSseConnectionLimits(),
): SseConnectionAttempt {
  const normalizedIp = normalizeIp(ip);
  const activeConnectionsForIp = activeConnectionsByIp.get(normalizedIp) ?? 0;

  if (activeConnectionsForIp >= limits.maxConnectionsPerIp) {
    return {
      ok: false,
      reason: 'per_ip_limit',
      message: 'Too many active SSE connections from this IP address',
      limits,
      retryAfterSeconds: limits.retryAfterSeconds,
      activeConnections,
      activeConnectionsForIp,
    };
  }

  if (activeConnections >= limits.maxGlobalConnections) {
    return {
      ok: false,
      reason: 'global_limit',
      message: 'Too many active SSE connections',
      limits,
      retryAfterSeconds: limits.retryAfterSeconds,
      activeConnections,
      activeConnectionsForIp,
    };
  }

  activeConnectionsByIp.set(normalizedIp, activeConnectionsForIp + 1);
  activeConnections += 1;
  sseActiveConnectionsGauge.set(activeConnections);

  let released = false;
  const acceptedAt = Date.now();

  return {
    ok: true,
    connection: {
      ip: normalizedIp,
      acceptedAt,
      limits,
      release(): void {
        if (released) return;
        released = true;

        const currentForIp = activeConnectionsByIp.get(normalizedIp) ?? 0;
        if (currentForIp <= 1) {
          activeConnectionsByIp.delete(normalizedIp);
        } else {
          activeConnectionsByIp.set(normalizedIp, currentForIp - 1);
        }

        activeConnections = Math.max(0, activeConnections - 1);
        sseActiveConnectionsGauge.set(activeConnections);
      },
    },
  };
}

export function getActiveSseConnectionCount(): number {
  return activeConnections;
}

export function getActiveSseConnectionCountForIp(ip: string): number {
  return activeConnectionsByIp.get(normalizeIp(ip)) ?? 0;
}

/** Reset limiter state between tests without touching the rejection counter. */
export function _resetSseConnectionLimiter(): void {
  activeConnectionsByIp.clear();
  activeConnections = 0;
  sseActiveConnectionsGauge.set(0);
}
