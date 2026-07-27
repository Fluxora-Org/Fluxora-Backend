import { longPollActiveConnectionsGauge, longPollConnectionsRejectedTotal } from '../metrics/businessMetrics.js';

export const DEFAULT_LONG_POLL_MAX_CONNECTIONS_PER_IP = 10;
export const DEFAULT_LONG_POLL_MAX_GLOBAL_CONNECTIONS = 1000;
export const DEFAULT_LONG_POLL_MAX_CONNECTIONS_PER_API_KEY = 50;
export const DEFAULT_LONG_POLL_MAX_CONNECTION_DURATION_MS = 30000; // 30s limit
export const DEFAULT_LONG_POLL_RETRY_AFTER_SECONDS = 15;

const MAX_LONG_POLL_CONNECTION_LIMIT = 100_000;
const MAX_LONG_POLL_CONNECTION_DURATION_MS = 86_400_000;
const MAX_LONG_POLL_RETRY_AFTER_SECONDS = 86_400;

export type LongPollConnectionRejectionReason =
  | 'per_ip_limit'
  | 'per_key_limit'
  | 'global_limit';

export interface LongPollConnectionLimits {
  maxConnectionsPerIp: number;
  maxConnectionsPerApiKey: number;
  maxGlobalConnections: number;
  maxConnectionDurationMs: number;
  retryAfterSeconds: number;
}

export interface AcceptedLongPollConnection {
  readonly ip: string;
  readonly acceptedAt: number;
  readonly limits: LongPollConnectionLimits;
  /**
   * Release the active long-poll connection exactly once.
   */
  release(): void;
}

export type LongPollConnectionAttempt =
  | { ok: true; connection: AcceptedLongPollConnection }
  | {
      ok: false;
      reason: LongPollConnectionRejectionReason;
      message: string;
      limits: LongPollConnectionLimits;
      retryAfterSeconds: number;
      activeConnections: number;
      activeConnectionsForIp: number;
    };

const activeConnectionsByIp = new Map<string, number>();
let activeConnections = 0;
const activeConnectionsByApiKey = new Map<string, number>();

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
 * Resolve the LongPoll limiter knobs from the current process environment.
 * Fallbacks to SSE config if LONG_POLL env var is missing, ensuring backwards compatibility or unified limit control.
 */
export function resolveLongPollConnectionLimits(
  env: NodeJS.ProcessEnv = process.env,
): LongPollConnectionLimits {
  const sseIp = readBoundedPositiveInteger(env, 'SSE_MAX_CONNECTIONS_PER_IP', DEFAULT_LONG_POLL_MAX_CONNECTIONS_PER_IP, 1, MAX_LONG_POLL_CONNECTION_LIMIT);
  const sseKey = readBoundedPositiveInteger(env, 'SSE_MAX_CONNECTIONS_PER_API_KEY', DEFAULT_LONG_POLL_MAX_CONNECTIONS_PER_API_KEY, 1, MAX_LONG_POLL_CONNECTION_LIMIT);
  const sseGlobal = readBoundedPositiveInteger(env, 'SSE_MAX_GLOBAL_CONNECTIONS', DEFAULT_LONG_POLL_MAX_GLOBAL_CONNECTIONS, 1, MAX_LONG_POLL_CONNECTION_LIMIT);
  const sseRetry = readBoundedPositiveInteger(env, 'SSE_RETRY_AFTER_SECONDS', DEFAULT_LONG_POLL_RETRY_AFTER_SECONDS, 1, MAX_LONG_POLL_RETRY_AFTER_SECONDS);

  const maxConnectionsPerIp = readBoundedPositiveInteger(
    env,
    'LONG_POLL_MAX_CONNECTIONS_PER_IP',
    sseIp,
    1,
    MAX_LONG_POLL_CONNECTION_LIMIT,
  );

  const maxConnectionsPerApiKey = readBoundedPositiveInteger(
    env,
    'LONG_POLL_MAX_CONNECTIONS_PER_API_KEY',
    sseKey,
    1,
    MAX_LONG_POLL_CONNECTION_LIMIT,
  );

  const maxGlobalConnections = readBoundedPositiveInteger(
    env,
    'LONG_POLL_MAX_GLOBAL_CONNECTIONS',
    sseGlobal,
    1,
    MAX_LONG_POLL_CONNECTION_LIMIT,
  );

  const maxConnectionDurationMs = readBoundedPositiveInteger(
    env,
    'LONG_POLL_MAX_CONNECTION_DURATION_MS',
    DEFAULT_LONG_POLL_MAX_CONNECTION_DURATION_MS,
    1,
    MAX_LONG_POLL_CONNECTION_DURATION_MS,
  );

  const retryAfterSeconds = readBoundedPositiveInteger(
    env,
    'LONG_POLL_RETRY_AFTER_SECONDS',
    sseRetry,
    1,
    MAX_LONG_POLL_RETRY_AFTER_SECONDS,
  );

  return {
    maxConnectionsPerIp,
    maxConnectionsPerApiKey,
    maxGlobalConnections,
    maxConnectionDurationMs,
    retryAfterSeconds,
  };
}

/**
 * Atomically check and reserve capacity for a new long-poll connection.
 */
export function tryAcquireLongPollConnection(
  ip: string,
  limits: LongPollConnectionLimits = resolveLongPollConnectionLimits(),
  apiKey?: string,
): LongPollConnectionAttempt {
  const normalizedIp = normalizeIp(ip);
  const normalizedKey = normalizeApiKey(apiKey);
  const activeConnectionsForIp = activeConnectionsByIp.get(normalizedIp) ?? 0;

  if (activeConnectionsForIp >= limits.maxConnectionsPerIp) {
    longPollConnectionsRejectedTotal.inc({ reason: 'per_ip_limit' });
    return {
      ok: false,
      reason: 'per_ip_limit',
      message: 'Too many active long-polling connections from this IP address',
      limits,
      retryAfterSeconds: limits.retryAfterSeconds,
      activeConnections,
      activeConnectionsForIp,
    };
  }

  if (normalizedKey !== undefined) {
    const activeForKey = activeConnectionsByApiKey.get(normalizedKey) ?? 0;
    if (activeForKey >= limits.maxConnectionsPerApiKey) {
      longPollConnectionsRejectedTotal.inc({ reason: 'per_key_limit' });
      return {
        ok: false,
        reason: 'per_key_limit',
        message: 'Too many active long-polling connections for this API key',
        limits,
        retryAfterSeconds: limits.retryAfterSeconds,
        activeConnections,
        activeConnectionsForIp,
      };
    }
  }

  if (activeConnections >= limits.maxGlobalConnections) {
    longPollConnectionsRejectedTotal.inc({ reason: 'global_limit' });
    return {
      ok: false,
      reason: 'global_limit',
      message: 'Too many active long-polling connections',
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
  longPollActiveConnectionsGauge.set(activeConnections);

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

        if (normalizedKey !== undefined) {
          const currentForKey = activeConnectionsByApiKey.get(normalizedKey) ?? 0;
          if (currentForKey <= 1) {
            activeConnectionsByApiKey.delete(normalizedKey);
          } else {
            activeConnectionsByApiKey.set(normalizedKey, currentForKey - 1);
          }
        }

        activeConnections = Math.max(0, activeConnections - 1);
        longPollActiveConnectionsGauge.set(activeConnections);
      },
    },
  };
}

export function getActiveLongPollConnectionCount(): number {
  return activeConnections;
}

export function getActiveLongPollConnectionCountForIp(ip: string): number {
  return activeConnectionsByIp.get(normalizeIp(ip)) ?? 0;
}

/** Reset limiter state between tests. */
export function _resetLongPollConnectionLimiter(): void {
  activeConnectionsByIp.clear();
  activeConnectionsByApiKey.clear();
  activeConnections = 0;
  longPollActiveConnectionsGauge.set(0);
}
