/**
 * PostgreSQL connection pool for Fluxora Backend.
 *
 * Reads pool config from environment variables:
 *   DB_POOL_MIN              minimum idle connections (default 2)
 *   DB_POOL_MAX              maximum connections (default 10)
 *   DB_CONNECTION_TIMEOUT    ms to wait for a connection (default 5000)
 *   DB_IDLE_TIMEOUT          ms before closing an idle connection (default 30000)
 *   POOL_QUEUE_LIMIT         max requests allowed to queue before fast-failing (default 50)
 *   DATABASE_URL             postgres connection string
 *
 * Pool exhaustion → throws PoolExhaustedError (caller maps to 503).
 * Unique constraint violation → throws DuplicateEntryError (caller maps to 409).
 *
 * Observability:
 *   - pool.on('connect')  → increments active gauge
 *   - pool.on('acquire')  → updates active/idle/waiting gauges
 *   - pool.on('remove')   → decrements active gauge
 *   - queue-limit guard   → increments exhausted counter, logs pool_exhausted event
 */

import pg from 'pg';
import crypto from 'crypto';
import { logger } from '../lib/logger.js';
import { traceSpan } from '../tracing/hooks.js';
import { getCorrelationId } from '../tracing/middleware.js';
import { dbSlowQueriesTotal, dbPoolActiveConnections, dbPoolIdleConnections, dbPoolWaitingRequests, dbPoolExhaustedTotal } from '../metrics/dbMetrics.js';

const { Pool } = pg;

// ── Error types ───────────────────────────────────────────────────────────────

export class PoolExhaustedError extends Error {
  constructor() {
    super('Database connection pool exhausted');
    this.name = 'PoolExhaustedError';
  }
}

export class DuplicateEntryError extends Error {
  constructor(detail?: string) {
    super(detail ?? 'Duplicate entry');
    this.name = 'DuplicateEntryError';
  }
}

export class QueryTimeoutError extends Error {
  constructor() {
    super('Query exceeded statement_timeout limit');
    this.name = 'QueryTimeoutError';
  }
}

// ── Pool config ───────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface PoolConfig {
  connectionString: string;
  min: number;
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  /** Max requests allowed to queue before fast-failing with PoolExhaustedError. */
  queueLimit: number;
  /** SET LOCAL statement_timeout value in ms. 0 = disabled. */
  statementTimeoutMs: number;
}

export function resolvePoolConfig(): PoolConfig {
  return {
    connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost/fluxora',
    min: envInt('DB_POOL_MIN', 2),
    max: envInt('DB_POOL_MAX', 10),
    connectionTimeoutMillis: envInt('DB_CONNECTION_TIMEOUT', 5_000),
    idleTimeoutMillis: envInt('DB_IDLE_TIMEOUT', 30_000),
    queueLimit: envInt('POOL_QUEUE_LIMIT', 50),
    statementTimeoutMs: envInt('STATEMENT_TIMEOUT_MS', 5_000),
  };
}

// ── Singleton pool ────────────────────────────────────────────────────────────

let _pool: pg.Pool | null = null;

/** Sync pool gauges from current pool state. */
function syncGauges(pool: pg.Pool): void {
  const active = pool.totalCount - pool.idleCount;
  dbPoolActiveConnections.set(active < 0 ? 0 : active);
  dbPoolIdleConnections.set(pool.idleCount);
  dbPoolWaitingRequests.set(pool.waitingCount);
}

export function createPool(config?: PoolConfig): pg.Pool {
  const cfg = config ?? resolvePoolConfig();
  const pool = new Pool({
    connectionString: cfg.connectionString,
    min: cfg.min,
    max: cfg.max,
    connectionTimeoutMillis: cfg.connectionTimeoutMillis,
    idleTimeoutMillis: cfg.idleTimeoutMillis,
  });

  // Store queueLimit on the pool instance for use in query()
  (pool as pg.Pool & { _queueLimit?: number })._queueLimit = cfg.queueLimit;

  // Apply statement_timeout on every new physical connection.
  // SET LOCAL scopes the timeout to the current transaction; for non-transactional
  // queries we use SET (session-level) so it persists for the connection lifetime.
  pool.on('connect', (client: pg.PoolClient) => {
    syncGauges(pool);
    if (cfg.statementTimeoutMs > 0) {
      // Fire-and-forget; errors are surfaced via pool.on('error')
      client.query('SET statement_timeout = $1', [cfg.statementTimeoutMs]).catch((err: Error) => {
        logger.error('Failed to set statement_timeout', undefined, { error: err.message });
      });
    }
    logger.debug('Postgres pool: new connection established', undefined, {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    });
  });

  // Track each connection checkout
  pool.on('acquire', () => {
    syncGauges(pool);
  });

  // Track connection removal (idle timeout / error)
  pool.on('remove', () => {
    syncGauges(pool);
    logger.debug('Postgres pool: connection removed', undefined, {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    });
  });

  pool.on('error', (err: Error) => {
    logger.error('Postgres pool error', undefined, { error: err.message });
  });

  return pool;
}

export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = createPool();
  }
  return _pool;
}

/** Replace the singleton (useful in tests). */
export function setPool(pool: pg.Pool | null): void {
  _pool = pool;
}

// ── Query helper ──────────────────────────────────────────────────────────────

const PG_UNIQUE_VIOLATION = '23505';
const PG_QUERY_CANCELED = '57014';

/**
 * Extract a safe table hint from SQL for metric labelling.
 * Returns the first table name found after FROM/INTO/UPDATE/JOIN keywords.
 * Never returns raw SQL or parameter values.
 */
export function extractTableHint(sql: string): string {
  const match = /(?:FROM|INTO|UPDATE|JOIN)\s+["']?(\w+)["']?/i.exec(sql);
  return match?.[1] ?? 'unknown';
}

/**
 * Run a query against the pool.
 * - Throws PoolExhaustedError when waiting queue exceeds POOL_QUEUE_LIMIT.
 * - Throws QueryTimeoutError when the query is canceled by statement_timeout (PG 57014).
 * - Throws DuplicateEntryError on unique constraint violations.
 * - Logs pool_exhausted event and high-latency queries.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  pool: pg.Pool,
  sql: string,
  params?: unknown[],
  thresholdMs: number = parseInt(process.env['SLOW_QUERY_THRESHOLD_MS'] ?? '1000', 10),
): Promise<pg.QueryResult<T>> {
  const limit = (pool as pg.Pool & { _queueLimit?: number })._queueLimit ?? envInt('POOL_QUEUE_LIMIT', 50);

  // Fast-fail when the waiting queue has reached the configured limit.
  // This prevents unbounded queuing and gives callers a deterministic 503.
  if (pool.waitingCount >= limit) {
    dbPoolExhaustedTotal.inc();
    logger.warn('Postgres pool exhausted', undefined, {
      event: 'pool_exhausted',
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      queueLimit: limit,
    });
    throw new PoolExhaustedError();
  }

  const correlationId = getCorrelationId();
  return traceSpan('db.query', correlationId, { 'db.sql': sql }, async () => {
    const start = Date.now();
    try {
      const result = await pool.query<T>(sql, params);
      const latency = Date.now() - start;
      if (thresholdMs > 0 && latency >= thresholdMs) {
        const queryHash = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
        const tableHint = extractTableHint(sql);
        logger.slowQuery({
          query_hash: queryHash,
          duration_ms: latency,
          table_hint: tableHint,
          ...(correlationId ? { correlation_id: correlationId } : {}),
        });
        dbSlowQueriesTotal.inc({ table_hint: tableHint });
      }
      return result;
    } catch (err) {
      if ((err as NodeJS.ErrnoException & { code?: string }).code === PG_QUERY_CANCELED) {
        throw new QueryTimeoutError();
      }
      if ((err as NodeJS.ErrnoException & { code?: string }).code === PG_UNIQUE_VIOLATION) {
        const detail = (err as { detail?: string }).detail;
        throw new DuplicateEntryError(detail);
      }
      throw err;
    }
  });
}

// ── Pool metrics (for health endpoint) ───────────────────────────────────────

export interface PoolMetrics {
  total: number;
  idle: number;
  waiting: number;
}

export function getPoolMetrics(pool: pg.Pool): PoolMetrics {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}
