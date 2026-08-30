import { sseActiveConnectionsGauge, sseConnectionsRejectedTotal, isValidRejectionReason } from '../metrics/businessMetrics.js';

export const DEFAULT_SSE_MAX_CONNECTIONS_PER_IP = 10;
export const DEFAULT_SSE_MAX_GLOBAL_CONNECTIONS = 1000;
export const DEFAULT_SSE_MAX_CONNECTIONS_PER_API_KEY = 50;
const DEFAULT_SSE_MAX_CONNECTION_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_SSE_RETRY_AFTER_SECONDS = 15;

const MAX_SSE_CONNECTION_LIMIT = 100_000;
const MAX_SSE_CONNECTION_DURATION_MS = 86400_000;
const MAX_SSE_RETRY_AFTER_SECONDS = 86400;

export type SseConnectionRejectionReason =
  | 'per_ip_limit'
  | 'per_key_limit'
  | 'global_limit';

export interface SseConnectionLimits {
  maxConnectionsPerIp: number;
  maxConnectionsPerApiKey: number;
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
   * and pre-header failure paths without double-decreminting the per-IP/global
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
const activeConnectionsByApiKey = new Map<string, number>();
const activeTimers = new Set<ReturnType<typeof setTimeout>>();

function normalizeApiKey(apiKey: string | undefined): string | undefined {
  if (apiKey === undefined) return undefined;
  const normalized = apiKey.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeIp(ip: string): string {
  const normalized = ip.trim();
  return normalized.length > 0 ? normalized : 'unknown';
}

function readBoundedPositiveInteger(
  env: Record<string, string | undefined>,
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
  env: Record<string, string | undefined> = process.env,
): SseConnectionLimits {
  return {
    maxConnectionsPerIp: readBoundedPositiveInteger(
      env,
      'SSE_MAX_CONNECTIONS_PER_IP',
      DEFAULT_SSE_MAX_CONNECTIONS_PER_IP,
      1,
      MAX_SSE_CONNECTION_LIMIT,
    ),
    maxConnectionsPerApiKey: readBoundedPositiveInteger(
      env,
      'SSE_MAX_CONNECTIONS_PER_API_KEY',
      DEFAULT_SSE_MAX_CONNECTIONS_PER_API_KEY,
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
  apiKey?: string,
): SseConnectionAttempt {
  const normalizedIp = normalizeIp(ip);
  const normalizedKey = normalizeApiKey(apiKey);
  const activeConnectionsForIp = activeConnectionsByIp.get(normalizedIp) ?? 0;

  if (activeConnectionsForIp >= limits.maxConnectionsPerIp) {
    if (isValidRejectionReason('per_ip_limit')) {
      sseConnectionsRejectedTotal.inc({
        reason: 'per_ip_limit',
      });
    }
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

  if (normalizedKey !== undefined) {
    const activeForKey = activeConnectionsByApiKey.get(normalizedKey) ?? 0;
    if (activeForKey >= limits.maxConnectionsPerApiKey) {
      sseConnectionsRejectedTotal.inc({ reason: 'per_key_limit' });
      return {
        ok: false,
        reason: 'per_key_limit',
        message: 'Too many active SSE connections for this API key',
        limits,
        retryAfterSeconds: limits.retryAfterSeconds,
        activeConnections,
        activeConnectionsForIp,
      };
    }
  }

  if (activeConnections >= limits.maxGlobalConnections) {
    if (isValidRejectionReason('global_limit')) {
      sseConnectionsRejectedTotal.inc({ reason: 'global_limit' });
    }
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
  if (normalizedKey !== undefined) {
    const currentForKey = activeConnectionsByApiKey.get(normalizedKey) ?? 0;
    activeConnectionsByApiKey.set(normalizedKey, currentForKey + 1);
  }
  sseActiveConnectionsGauge.set(activeConnections);

  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const acceptedAt = Date.now();

  const connection: AcceptedSseConnection = {
    ip: normalizedIp,
    acceptedAt,
    limits,
    release(): void {
      if (released) return;
      released = true;

      if (timer !== undefined) {
        clearTimeout(timer);
        activeTimers.delete(timer);
        timer = undefined;
      }

      const currentForIp = activeConnectionsByIp.get(normalizedIp) ?? 0;
      if (currentForIp <= 1) {
        activeConnectionsByIp.delete(normalizedIp);
      } else {
        activeConnectionsByIp.set(normalizedIp, currentForIp - 1);
      }

      if (normalizedKey !== undefined) {
        const currentForKey = activeConnectionsByApiKey.get(normalizedKey) ?? 0;
        if (currentForKey <= 1) {
          activeConnectionsByApiKey.delete(normalizedKey);
        } else {
          activeConnectionsByApiKey.set(normalizedKey, currentForKey - 1);
        }
      }

      activeConnections = Math.max(0, activeConnections - 1);
      sseActiveConnectionsGauge.set(activeConnections);
    },
  };

  if (limits.maxConnectionDurationMs > 0) {
    timer = setTimeout(() => {
      connection.release();
    }, limits.maxConnectionDurationMs);
    activeTimers.add(timer);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  return { ok: true, connection };
}

export function getActiveSseConnectionCount(): number {
  return activeConnections;
}

export function getActiveSseConnectionCountForIp(ip: string): number {
  return activeConnectionsByIp.get(normalizeIp(ip)) ?? 0;
}

/** Reset limiter state between tests without touching the rejection counter. */
export function _resetSseConnectionLimiter(): void {
  for (const timer of activeTimers) {
    clearTimeout(timer);
  }
  activeTimers.clear();
  activeConnectionsByIp.clear();
  activeConnectionsByApiKey.clear();
  activeConnections = 0;
  sseActiveConnectionsGauge.set(0);
}