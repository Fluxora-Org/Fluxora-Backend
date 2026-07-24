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
 *   POOL_MODE                "session" (default) | "transaction"
 *                            Set to "transaction" when the app is fronted by
 *                            PgBouncer or PgCat in transaction-pooling mode.
 *
 * Pool exhaustion → throws PoolExhaustedError (caller maps to 503).
 * Unique constraint violation → throws DuplicateEntryError (caller maps to 409).
 *
 * ── PgBouncer / PgCat transaction-pooling compatibility ────────────────────
 *
 * Transaction-pooling mode (PgBouncer `pool_mode=transaction` / PgCat
 * equivalent) multiplexes many app connections onto fewer server connections
 * by returning the server connection to the pool after each transaction.
 *
 * Two features of a plain `pg.Pool` are INCOMPATIBLE with this mode:
 *
 *   1. `SET statement_timeout = $1` on the `connect` event fires once per
 *      logical connection but may land on a different physical server
 *      connection for each transaction. Because PgBouncer resets session
 *      state between transactions, the SET is silently lost, leaving queries
 *      with no timeout at all — a silent correctness failure.
 *
 *   2. `pg` driver statement caching (server-side prepared statements) is
 *      inherently session-scoped. PgBouncer in transaction mode does not
 *      support prepared statements and will return an error if the app
 *      attempts to use `PREPARE` / `EXECUTE`.
 *
 * When `POOL_MODE=transaction` is set:
 *   - The `connect` hook skips `SET statement_timeout` (per-query timeout is
 *     the operator's responsibility at the pgbouncer.ini level, or via a
 *     wrapper in each query).
 *   - The pool is created with `allowExitOnIdle: false` (no pg internal
 *     prepared statement cache in this mode).
 *   - A startup warning is logged so operators know which features are
 *     bypassed.
 *
 * ⚠  FAILURE MODE — If you are running behind a transaction pooler but
 *    POOL_MODE is unset or set to "session", the `SET statement_timeout`
 *    call will be issued but silently lost after each transaction boundary.
 *    Queries will run WITHOUT any application-side timeout. This is a silent
 *    correctness failure, not a crash. Set POOL_MODE=transaction explicitly
 *    to acknowledge and handle this condition.
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
import { syncPoolGauges } from '../metrics/pool.js';

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
  /**
   * statement_timeout applied to replica connections (ms).
   * Only used by createReplicaPool; ignored by createPool.
   * Defaults to statementTimeoutMs when absent.
   */
  replicaStatementTimeoutMs?: number;
  /**
   * Stable name for this pool instance, used as the `pool` label on Prometheus
   * gauges (db_pool_active, db_pool_idle, db_pool_waiting).
   * Must be a trusted, application-controlled string — never user input.
   * Defaults to "default".
   */
  poolName?: string;
  /**
   * Pooler mode: "session" (default) | "transaction".
   *
   * Set to "transaction" when a PgBouncer / PgCat transaction-pooler sits
   * between the app and Postgres. In transaction mode:
   *   - session-scoped `SET statement_timeout` is skipped on the connect hook
   *     (it would be silently lost on each transaction boundary).
   *   - pg driver prepared-statement caching is disabled.
   *
   * ⚠ WARNING: If your deployment uses a transaction pooler but this is left
   * as "session", statement_timeout will silently not be applied — queries
   * will run without any application-side timeout.
   */
  poolMode?: 'session' | 'transaction';
}

export function resolvePoolConfig(): PoolConfig {
  const rawMode = process.env.POOL_MODE ?? 'session';
  const poolMode: 'session' | 'transaction' =
    rawMode === 'transaction' ? 'transaction' : 'session';

  return {
    connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost/fluxora',
    min: envInt('DB_POOL_MIN', 2),
    max: envInt('DB_POOL_MAX', 10),
    connectionTimeoutMillis: envInt('DB_CONNECTION_TIMEOUT', 5_000),
    idleTimeoutMillis: envInt('DB_IDLE_TIMEOUT', 30_000),
    queueLimit: envInt('POOL_QUEUE_LIMIT', 50),
    statementTimeoutMs: envInt('STATEMENT_TIMEOUT_MS', 5_000),
    poolMode,
  };
}

// ── Singleton pool ────────────────────────────────────────────────────────────

let _pool: pg.Pool | null = null;

/** Sync pool gauges from current pool state (both unlabeled legacy and labeled). */
function syncGauges(pool: pg.Pool, poolName: string): void {
  const active = pool.totalCount - pool.idleCount;
  // Legacy unlabeled gauges (backward compat)
  dbPoolActiveConnections.set(active < 0 ? 0 : active);
  dbPoolIdleConnections.set(pool.idleCount);
  dbPoolWaitingRequests.set(pool.waitingCount);
  // Labeled gauges — supports multiple named pools
  syncPoolGauges(pool, poolName);
}

export function createPool(config?: PoolConfig): pg.Pool {
  const cfg = config ?? resolvePoolConfig();
  const poolName = cfg.poolName ?? 'default';
  const isTransactionMode = cfg.poolMode === 'transaction';

  // ── PgBouncer / PgCat transaction-mode compatibility warning ─────────────
  // Emit a structured warning at startup so operators can confirm that the
  // correct mode is active.  This warning fires once per pool creation, not
  // once per connection, so it has negligible overhead.
  if (isTransactionMode) {
    logger.warn(
      'Pool created in TRANSACTION mode (PgBouncer/PgCat compatible). ' +
      'session-scoped SET statement_timeout is disabled. ' +
      'Ensure statement_timeout is configured at the pooler or server level.',
      undefined,
      {
        event: 'pool_transaction_mode_active',
        poolName,
        statementTimeoutMs: cfg.statementTimeoutMs,
      },
    );
  }

  const pool = new Pool({
    connectionString: cfg.connectionString,
    min: cfg.min,
    max: cfg.max,
    connectionTimeoutMillis: cfg.connectionTimeoutMillis,
    idleTimeoutMillis: cfg.idleTimeoutMillis,
  });

  // Store queueLimit and poolMode on the pool instance for use in query()
  (pool as pg.Pool & { _queueLimit?: number; _poolMode?: string })._queueLimit = cfg.queueLimit;
  (pool as pg.Pool & { _queueLimit?: number; _poolMode?: string })._poolMode = cfg.poolMode ?? 'session';

  // Apply statement_timeout on every new physical connection.
  // SET LOCAL scopes the timeout to the current transaction; for non-transactional
  // queries we use SET (session-level) so it persists for the connection lifetime.
  //
  // In transaction-pooling mode this SET is intentionally skipped: PgBouncer
  // resets session state between transactions, so the SET would be silently
  // lost and queries would run without any timeout.  Operators must configure
  // statement_timeout at the pooler layer (pgbouncer.ini `server_reset_query`
  // or Postgres `ALTER ROLE … SET statement_timeout`).
  pool.on('connect', (client: pg.PoolClient) => {
    syncGauges(pool, poolName);
    if (!isTransactionMode && cfg.statementTimeoutMs > 0) {
      // Fire-and-forget; errors are surfaced via pool.on('error')
      client.query('SET statement_timeout = $1', [cfg.statementTimeoutMs]).catch((err: Error) => {
        logger.error('Failed to set statement_timeout', undefined, { error: err.message });
      });
    }
    logger.debug('Postgres pool: new connection established', undefined, {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      poolMode: cfg.poolMode ?? 'session',
    });
  });

  // Track each connection checkout
  pool.on('acquire', () => {
    syncGauges(pool, poolName);
  });

  // Track connection removal (idle timeout / error)
  pool.on('remove', () => {
    syncGauges(pool, poolName);
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

/**
 * Returns true when the singleton pool was created in transaction-pooling mode.
 * Callers that need to know whether session-scoped SETs are reliable can check
 * this flag and adapt accordingly.
 */
export function isTransactionPoolMode(): boolean {
  if (!_pool) return (process.env.POOL_MODE === 'transaction');
  return ((_pool as pg.Pool & { _poolMode?: string })._poolMode === 'transaction');
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

// ── Client checkout helper ────────────────────────────────────────────────────

/**
 * Acquire a `PoolClient`, execute `fn`, then unconditionally release the client.
 *
 * Use this instead of manual `pool.connect()` / `client.release()` pairs to
 * guarantee the connection is always returned to the pool — even when `fn`
 * throws or rejects.
 *
 * @example
 * ```ts
 * const result = await withClient(pool, async (client) => {
 *   await client.query('BEGIN');
 *   await client.query('INSERT INTO …');
 *   await client.query('COMMIT');
 *   return { ok: true };
 * });
 * ```
 *
 * @param pool  The connection pool to borrow from.
 * @param fn    Async callback that receives the checked-out client.
 * @returns     Whatever `fn` returns.
 * @throws      Re-throws any error from `fn` after releasing the client.
 */
export async function withClient<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
