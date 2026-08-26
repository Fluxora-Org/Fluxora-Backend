/**
 * Aggregated system diagnostics service.
 *
 * Runs several sub-checks concurrently, each individually timeout-bounded,
 * and returns a structured snapshot suitable for operator triage via
 * `GET /api/admin/diagnostics`.
 *
 * ## Security
 *
 * - Error messages from failed sub-checks are sanitised (connection strings,
 *   passwords, hostnames stripped) before being returned in the response.
 * - No authentication tokens, API keys, or session identifiers are ever
 *   included in diagnostics output.
 * - Each sub-check runs with its own timeout so a single hung dependency
 *   cannot stall the entire endpoint (DoS protection).
 */

import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { getPool, getPoolMetrics } from '../db/pool.js';
import { getStellarRpcService, type CircuitState } from './stellar-rpc.js';
import { indexerService } from '../indexer/service.js';
import { indexerLagSeconds } from '../metrics/businessMetrics.js';
import { sanitiseErrorMessage } from '../health/checkers.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubCheckResult<T = unknown> {
  status: 'ok' | 'error' | 'timeout';
  latencyMs: number;
  value?: T;
  error?: string;
}

export interface DbPoolSnapshot {
  active: number;
  idle: number;
  waiting: number;
}

export interface RedisSnapshot {
  pingMs: number;
}

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  /** Epoch ms when the breaker last tripped to OPEN, or null if never opened. */
  transitionedAt: number | null;
  failureCount: number;
  degraded: boolean;
}

export interface IndexerSnapshot {
  lagSeconds: number;
  isReplaying: boolean;
  rowsReplayed?: number;
  totalRows?: number;
}

export interface DiagnosticsReport {
  timestamp: string;
  dbPool: SubCheckResult<DbPoolSnapshot>;
  redis: SubCheckResult<RedisSnapshot>;
  circuitBreaker: SubCheckResult<CircuitBreakerSnapshot>;
  indexer: SubCheckResult<IndexerSnapshot>;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

/**
 * Race a promise against a timeout. If the timeout fires first the promise
 * is abandoned (but not cancelled — it still runs to completion or rejection
 * in the background) and the returned promise rejects with `TimeoutError`.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── Diagnostics Service ────────────────────────────────────────────────────────

export interface DiagnosticsServiceDependencies {
  /** Returns the Postgres connection pool. */
  getDbPool: () => pg.Pool;
  /** Pings Redis and returns the round-trip latency in ms. Returns `null` when Redis is unavailable/disabled. */
  pingRedis: () => Promise<number | null>;
  /** Returns the circuit breaker state snapshot. */
  getCircuitBreakerState: () => CircuitBreakerSnapshot;
  /** Returns the current indexer lag in seconds. */
  getIndexerLagSeconds: () => number;
  /** Returns the current indexer replay progress. */
  getIndexerReplayProgress: () => { isReplaying: boolean; rowsReplayed: number; totalRows: number };
  /** Per-sub-check timeout in ms. */
  checkTimeoutMs: number;
}

/**
 * Default dependency implementations wired to the running service singletons.
 */
function defaultPingRedis(): Promise<number | null> {
  // If Redis is explicitly disabled, skip the ping check.
  if (process.env.REDIS_ENABLED === 'false') {
    return Promise.resolve(null);
  }

  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const connectTimeout = 5_000;

  // Dynamically import ioredis and create a temporary connection for the PING.
  // We use ioredis directly rather than createRedisClient because the
  // RedisClient interface does not expose a ping() method, and opening a
  // disposable connection avoids coupling diagnostics to the application's
  // long-lived Redis client lifecycle.
  return (async () => {
    const { default: Redis } = await import('ioredis');
    const parsedUrl = new URL(url);
    const port = parseInt(parsedUrl.port || '6379', 10);
    const host = parsedUrl.hostname || 'localhost';
    const password = parsedUrl.password || undefined;

    const client = new Redis(port, host, {
      password,
      lazyConnect: true,
      connectTimeout,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null, // no retry for diagnostics
      enableReadyCheck: true,
    });

    try {
      await client.connect();
      const pingStart = Date.now();
      await client.ping();
      const latency = Date.now() - pingStart;
      return latency;
    } finally {
      // Best-effort cleanup; errors are swallowed.
      await client.quit().catch(() => {});
    }
  })();
}

function defaultGetCircuitBreakerState(): CircuitBreakerSnapshot {
  try {
    const svc = getStellarRpcService();
    const deg = svc.getDegradationSnapshot();
    return {
      state: deg.circuitState,
      transitionedAt: deg.openedAt,
      failureCount: deg.failureCount,
      degraded: deg.degraded,
    };
  } catch {
    return { state: 'CLOSED', transitionedAt: null, failureCount: 0, degraded: false };
  }
}

function defaultGetIndexerLagSeconds(): number {
  try {
    // prom-client Gauge.get() resolves to { values: [{ value }] }; for an
    // unlabeled gauge the current reading is the first entry.
    const result = indexerLagSeconds.get() as unknown as {
      values?: Array<{ value?: number }>;
    };
    const first = result?.values?.[0]?.value;
    return typeof first === 'number' ? first : 0;
  } catch {
    return 0;
  }
}

function defaultGetIndexerReplayProgress(): { isReplaying: boolean; rowsReplayed: number; totalRows: number } {
  try {
    const progress = indexerService.getReplayProgress();
    return {
      isReplaying: progress.isReplaying,
      rowsReplayed: progress.rowsReplayed ?? 0,
      totalRows: progress.totalRows ?? 0,
    };
  } catch {
    return { isReplaying: false, rowsReplayed: 0, totalRows: 0 };
  }
}

export class DiagnosticsService {
  private readonly deps: DiagnosticsServiceDependencies;

  constructor(deps?: Partial<DiagnosticsServiceDependencies>) {
    this.deps = {
      getDbPool: deps?.getDbPool ?? getPool,
      pingRedis: deps?.pingRedis ?? defaultPingRedis,
      getCircuitBreakerState: deps?.getCircuitBreakerState ?? defaultGetCircuitBreakerState,
      getIndexerLagSeconds: deps?.getIndexerLagSeconds ?? defaultGetIndexerLagSeconds,
      getIndexerReplayProgress: deps?.getIndexerReplayProgress ?? defaultGetIndexerReplayProgress,
      checkTimeoutMs: deps?.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
    };
  }

  /** Replace the singleton check timeout (useful in tests). */
  setCheckTimeoutMs(ms: number): void {
    (this.deps as DiagnosticsServiceDependencies).checkTimeoutMs = ms;
  }

  /**
   * Run all diagnostics sub-checks concurrently with individual timeouts.
   */
  async runDiagnostics(): Promise<DiagnosticsReport> {
    const timestamp = new Date().toISOString();

    const [dbPool, redis, circuitBreaker, indexer] = await Promise.all([
      this.checkDbPool(),
      this.checkRedis(),
      this.checkCircuitBreaker(),
      this.checkIndexer(),
    ]);

    return { timestamp, dbPool, redis, circuitBreaker, indexer };
  }

  // ── DB pool check ──────────────────────────────────────────────────────────

  private async checkDbPool(): Promise<SubCheckResult<DbPoolSnapshot>> {
    const start = Date.now();
    try {
      const pool = this.deps.getDbPool();
      const conn = await withTimeout(
        pool.connect(),
        this.deps.checkTimeoutMs,
        'dbPool',
      );
      try {
        await withTimeout(
          conn.query('SELECT 1'),
          this.deps.checkTimeoutMs,
          'dbPool_query',
        );
        const metrics = getPoolMetrics(pool);
        return {
          status: 'ok',
          latencyMs: Date.now() - start,
          value: {
            active: metrics.total - metrics.idle,
            idle: metrics.idle,
            waiting: metrics.waiting,
          },
        };
      } finally {
        conn.release();
      }
    } catch (err) {
      const latencyMs = Date.now() - start;
      const raw = err instanceof Error ? err.message : String(err);
      return {
        status: raw.includes('timed out') ? 'timeout' : 'error',
        latencyMs,
        error: sanitiseErrorMessage(raw),
      };
    }
  }

  // ── Redis check ─────────────────────────────────────────────────────────────

  private async checkRedis(): Promise<SubCheckResult<RedisSnapshot>> {
    const start = Date.now();
    try {
      const pingMs = await withTimeout(
        this.deps.pingRedis(),
        this.deps.checkTimeoutMs,
        'redis',
      );

      if (pingMs === null) {
        return {
          status: 'ok',
          latencyMs: Date.now() - start,
          value: { pingMs: 0 },
          error: 'Redis is disabled; no check performed',
        };
      }

      return {
        status: 'ok',
        latencyMs: Date.now() - start,
        value: { pingMs },
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const raw = err instanceof Error ? err.message : String(err);
      return {
        status: raw.includes('timed out') ? 'timeout' : 'error',
        latencyMs,
        error: sanitiseErrorMessage(raw),
      };
    }
  }

  // ── Circuit breaker check ───────────────────────────────────────────────────

  private async checkCircuitBreaker(): Promise<SubCheckResult<CircuitBreakerSnapshot>> {
    const start = Date.now();
    try {
      // This is purely in-memory — no I/O — so it should never time out,
      // but we still wrap it for uniformity and future-proofing.
      const state = await withTimeout(
        Promise.resolve(this.deps.getCircuitBreakerState()),
        this.deps.checkTimeoutMs,
        'circuitBreaker',
      );

      return {
        status: 'ok',
        latencyMs: Date.now() - start,
        value: state,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const raw = err instanceof Error ? err.message : String(err);
      return {
        status: raw.includes('timed out') ? 'timeout' : 'error',
        latencyMs,
        error: sanitiseErrorMessage(raw),
      };
    }
  }

  // ── Indexer check ───────────────────────────────────────────────────────────

  private async checkIndexer(): Promise<SubCheckResult<IndexerSnapshot>> {
    const start = Date.now();
    try {
      const [lagSeconds, replayProgress] = await Promise.all([
        withTimeout(
          Promise.resolve(this.deps.getIndexerLagSeconds()),
          this.deps.checkTimeoutMs,
          'indexer_lag',
        ),
        withTimeout(
          Promise.resolve(this.deps.getIndexerReplayProgress()),
          this.deps.checkTimeoutMs,
          'indexer_replay',
        ),
      ]);

      return {
        status: 'ok',
        latencyMs: Date.now() - start,
        value: {
          lagSeconds,
          isReplaying: replayProgress.isReplaying,
          rowsReplayed: replayProgress.rowsReplayed,
          totalRows: replayProgress.totalRows,
        },
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const raw = err instanceof Error ? err.message : String(err);
      return {
        status: raw.includes('timed out') ? 'timeout' : 'error',
        latencyMs,
        error: sanitiseErrorMessage(raw),
      };
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let _instance: DiagnosticsService | null = null;

export function getDiagnosticsService(): DiagnosticsService {
  if (!_instance) {
    _instance = new DiagnosticsService();
  }
  return _instance;
}

/** Replace the singleton (for testing). */
export function setDiagnosticsService(svc: DiagnosticsService | null): void {
  _instance = svc;
}
