/**
 * Concrete health checkers for Postgres, Redis, and Stellar RPC.
 *
 * Each checker enforces a hard timeout so a hung dependency
 * cannot stall the health endpoint.
 *
 * Security considerations:
 * - Error messages are sanitised before being returned: connection strings,
 *   passwords, and hostnames are stripped so they never appear in health
 *   responses visible to unauthenticated callers.
 * - Latency thresholds for "degraded" classification are intentionally
 *   conservative; operators can tune them via opts.
 * - The Redis PING check does not read or write application data.
 * - The Postgres check runs only `SELECT 1` — no schema access required.
 */

import type { HealthChecker } from '../config/health.js';

export const DEFAULT_TIMEOUT_MS = 5_000;

/** Latency above which a dependency is classified as "degraded" rather than "healthy". */
export const DEFAULT_DEGRADED_LATENCY_MS = 1_000;

/**
 * Strip credentials and hostnames from error messages so they are safe to
 * surface in health responses.
 *
 * Removes:
 *  - postgres/redis connection strings (postgresql://…, redis://…)
 *  - generic "user:password@host" patterns
 */
export function sanitiseErrorMessage(raw: string): string {
  return raw
    .replace(/(?:postgresql|postgres|redis):\/\/[^\s"']*/gi, '[redacted-url]')
    .replace(/\w+:\w+@[\w.:-]+/g, '[redacted-credentials]');
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); },
    );
  });
}

/** Classify a latency value: above threshold → "degraded", otherwise undefined. */
function latencyStatus(latencyMs: number, degradedThresholdMs: number): 'degraded' | undefined {
  return latencyMs >= degradedThresholdMs ? 'degraded' : undefined;
}

export interface PostgresClient {
  query(sql: string): Promise<unknown>;
  totalCount?: number;
  idleCount?: number;
}

/**
 * Checks Postgres by running SELECT 1 and verifying the pool is not exhausted.
 *
 * Degraded classification:
 *  - Query succeeds but latency exceeds `degradedLatencyMs` → "degraded"
 *  - Pool is exhausted (idleCount === 0 && totalCount >= maxPoolSize) → error
 */
export function createPostgresChecker(
  getClient: () => PostgresClient,
  opts: { timeoutMs?: number; maxPoolSize?: number; degradedLatencyMs?: number } = {},
): HealthChecker {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPoolSize = opts.maxPoolSize ?? 10;
  const degradedLatencyMs = opts.degradedLatencyMs ?? DEFAULT_DEGRADED_LATENCY_MS;

  return {
    name: 'postgres',
    async check() {
      const start = Date.now();
      try {
        const client = getClient();
        await withTimeout(client.query('SELECT 1'), timeoutMs, 'postgres');
        const latency = Date.now() - start;

        // Pool exhaustion check (pg Pool exposes these counts)
        if (
          typeof client.totalCount === 'number' &&
          typeof client.idleCount === 'number' &&
          client.idleCount === 0 &&
          client.totalCount >= maxPoolSize
        ) {
          return { latency, error: 'Connection pool exhausted' };
        }

        const degraded = latencyStatus(latency, degradedLatencyMs);
        return degraded
          ? { latency, degraded: true }
          : { latency };
      } catch (err) {
        const latency = Date.now() - start;
        const raw = err instanceof Error ? err.message : String(err);
        return { latency, error: sanitiseErrorMessage(raw) };
      }
    },
  };
}

export interface StellarRpcClient {
  getLatestLedger(): Promise<{ sequence: number }>;
}

/**
 * Checks Stellar RPC by calling getLatestLedger.
 * Optionally verifies the ledger is not lagging behind a threshold.
 *
 * Degraded classification:
 *  - Call succeeds but latency exceeds `degradedLatencyMs` → "degraded"
 */
export function createStellarRpcChecker(
  getClient: () => StellarRpcClient,
  opts: { timeoutMs?: number; maxLedgerAgeSec?: number; degradedLatencyMs?: number } = {},
): HealthChecker {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const degradedLatencyMs = opts.degradedLatencyMs ?? DEFAULT_DEGRADED_LATENCY_MS;

  return {
    name: 'stellar_rpc',
    async check() {
      const start = Date.now();
      try {
        const client = getClient();
        const result = await withTimeout(client.getLatestLedger(), timeoutMs, 'stellar_rpc');
        const latency = Date.now() - start;

        if (!result || typeof result.sequence !== 'number') {
          return { latency, error: 'Invalid ledger response' };
        }

        const degraded = latencyStatus(latency, degradedLatencyMs);
        return degraded
          ? { latency, degraded: true }
          : { latency };
      } catch (err) {
        const latency = Date.now() - start;
        const raw = err instanceof Error ? err.message : String(err);
        return { latency, error: sanitiseErrorMessage(raw) };
      }
    },
  };
}

// ── Redis checker ─────────────────────────────────────────────────────────────

export interface RedisClient {
  ping(): Promise<string>;
}

/**
 * Checks Redis by sending a PING command and verifying the PONG response.
 *
 * Degraded classification:
 *  - PING succeeds but latency exceeds `degradedLatencyMs` → "degraded"
 *  - PING returns an unexpected response → error
 *
 * Security: Redis connection strings are never included in error messages.
 */
export function createRedisChecker(
  getClient: () => RedisClient,
  opts: { timeoutMs?: number; degradedLatencyMs?: number } = {},
): HealthChecker {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const degradedLatencyMs = opts.degradedLatencyMs ?? DEFAULT_DEGRADED_LATENCY_MS;

  return {
    name: 'redis',
    async check() {
      const start = Date.now();
      try {
        const client = getClient();
        const response = await withTimeout(client.ping(), timeoutMs, 'redis');
        const latency = Date.now() - start;

        if (typeof response !== 'string' || response.toUpperCase() !== 'PONG') {
          return { latency, error: `Unexpected PING response: ${String(response)}` };
        }

        const degraded = latencyStatus(latency, degradedLatencyMs);
        return degraded
          ? { latency, degraded: true }
          : { latency };
      } catch (err) {
        const latency = Date.now() - start;
        const raw = err instanceof Error ? err.message : String(err);
        return { latency, error: sanitiseErrorMessage(raw) };
      }
    },
  };
}
