/**
 * PostgreSQL connection pool for Fluxora Backend.
 *
 * Reads pool config from environment variables:
 *   DB_POOL_MIN              minimum idle connections (default 2)
 *   DB_POOL_MAX              maximum connections (default 10)
 *   DB_CONNECTION_TIMEOUT    ms to wait for a connection (default 5000)
 *   DB_IDLE_TIMEOUT          ms before closing an idle connection (default 30000)
 *   DATABASE_URL             postgres connection string
 *
 * Pool exhaustion → throws PoolExhaustedError (caller maps to 503).
 * Unique constraint violation → throws DuplicateEntryError (caller maps to 409).
 */

import pg from 'pg';
import crypto from 'crypto';
import { logger } from '../lib/logger.js';
import { traceSpan } from '../tracing/hooks.js';
import { getCorrelationId } from '../tracing/middleware.js';
import { dbSlowQueriesTotal } from '../metrics/dbMetrics.js';

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
}

export function resolvePoolConfig(): PoolConfig {
  return {
    connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost/fluxora',
    min: envInt('DB_POOL_MIN', 2),
    max: envInt('DB_POOL_MAX', 10),
    connectionTimeoutMillis: envInt('DB_CONNECTION_TIMEOUT', 5_000),
    idleTimeoutMillis: envInt('DB_IDLE_TIMEOUT', 30_000),
  };
}

// ── Singleton pool ────────────────────────────────────────────────────────────

let _pool: pg.Pool | null = null;

export function createPool(config?: PoolConfig): pg.Pool {
  const cfg = config ?? resolvePoolConfig();
  const pool = new Pool(cfg);

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
 * - Throws PoolExhaustedError when all connections are busy.
 * - Throws DuplicateEntryError on unique constraint violations.
 * - Logs pool exhaustion and high-latency queries.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  pool: pg.Pool,
  sql: string,
  params?: unknown[],
  thresholdMs: number = parseInt(process.env['SLOW_QUERY_THRESHOLD_MS'] ?? '1000', 10),
): Promise<pg.QueryResult<T>> {
  // Pool exhaustion check before acquiring
  if (pool.totalCount >= pool.options.max! && pool.idleCount === 0 && pool.waitingCount > 0) {
    logger.warn('Postgres pool exhausted', undefined, {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
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
        logger.warn('Slow postgres query', correlationId, {
          query_hash: queryHash,
          duration_ms: latency,
          table_hint: tableHint,
          correlation_id: correlationId,
        });
        dbSlowQueriesTotal.inc({ table_hint: tableHint });
      }
      return result;
    } catch (err) {
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
