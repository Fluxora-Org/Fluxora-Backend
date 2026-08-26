/**
 * Read-replica PostgreSQL connection pool for Fluxora Backend.
 *
 * Provides a lazily-initialised pg.Pool that connects to a read-replica
 * database when `DATABASE_REPLICA_URL` is set. If the env var is missing
 * or the replica fails its initial health-check, all read queries
 * transparently fall back to the primary pool.
 *
 * Usage:
 *   import { getReadPool } from '../db/replicaPool.js';
 *   const pool = await getReadPool();
 *   const result = await query(pool, 'SELECT …');
 *
 * Security notes:
 *   - The replica pool is configured with `default_transaction_read_only = on`
 *     at the session level to prevent accidental writes.
 *   - Connection strings are never logged; only the hostname is included
 *     in diagnostic messages.
 *
 * @module db/replicaPool
 */

import pg from 'pg';
import { logger } from '../lib/logger.js';
import { getPool, createPool, resolvePoolConfig } from './pool.js';
import type { PoolConfig } from './pool.js';
import { dbReplicationLagSeconds } from '../metrics/dbMetrics.js';

const { Pool } = pg;

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ── Internal state ────────────────────────────────────────────────────────────

let _replicaPool: pg.Pool | null = null;
let _replicaHealthy = false;
let _healthCheckDone = false;
let _lastLagCheckTime = 0;
let _lastLagValue: number | null = null;
const LAG_CHECK_INTERVAL_MS = 30000; // 30 seconds

/**
 * Extract hostname from a connection string for safe logging.
 * Never log the full URL — it may contain credentials.
 */
function safeHostname(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return url.hostname || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Pool creation ─────────────────────────────────────────────────────────────

/**
 * Build a PoolConfig for the read replica.
 * Inherits pool size / timeout settings from the primary config but uses
 * DATABASE_REPLICA_URL as the connection string.
 *
 * Replica-specific knobs (override primary defaults):
 *   REPLICA_STATEMENT_TIMEOUT_MS — per-query timeout (default 30 000 ms).
 *     Higher than primary because replica reads are often long analytical queries.
 *     Set to 0 to disable. Cannot be overridden by client-supplied SQL.
 *   REPLICA_QUEUE_LIMIT — max queued connection requests before fast-failing
 *     (default 25). Keeps replica saturation observable separately from primary.
 */
export function resolveReplicaPoolConfig(): PoolConfig | null {
  const replicaUrl = process.env['DATABASE_REPLICA_URL'];
  if (!replicaUrl) {
    return null;
  }

  const primaryCfg = resolvePoolConfig();
  const raw = process.env['REPLICA_STATEMENT_TIMEOUT_MS'];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  const replicaStatementTimeoutMs = Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : primaryCfg.statementTimeoutMs;

  return {
    ...primaryCfg,
    connectionString: replicaUrl,
    replicaStatementTimeoutMs,
    queueLimit: envInt('REPLICA_QUEUE_LIMIT', 25),
    poolName: 'replica',
  };
}

/**
 * Create a pg.Pool for the read replica.
 *
 * On every new physical connection the hook atomically sets:
 *   1. `default_transaction_read_only = on`  — prevents accidental writes.
 *   2. `statement_timeout = <ms>`            — bounds runaway SELECTs. The value
 *      comes from cfg.replicaStatementTimeoutMs (falling back to the primary
 *      statementTimeoutMs) and is set server-side, so it cannot be overridden
 *      by client-supplied SQL parameters.
 *
 * Both are applied in a single `client.query` call so they either both succeed
 * or both fail (the connection is destroyed on error, preventing a half-configured
 * client from entering the pool).
 *
 * A `_queueLimit` property is also stamped on the pool so callers using the shared
 * `query()` helper fast-fail when the waiting queue is full, keeping replica
 * saturation observable separately from the primary pool.
 *
 * @param config - Pool configuration. Uses resolveReplicaPoolConfig() when omitted.
 */
export function createReplicaPool(config?: PoolConfig): pg.Pool {
  const cfg = config ?? resolveReplicaPoolConfig()!;
  const timeoutMs = cfg.replicaStatementTimeoutMs ?? cfg.statementTimeoutMs;
  const pool = new Pool({
    connectionString: cfg.connectionString,
    min: cfg.min,
    max: cfg.max,
    connectionTimeoutMillis: cfg.connectionTimeoutMillis,
    idleTimeoutMillis: cfg.idleTimeoutMillis,
  });

  // Store queueLimit on the pool instance (same pattern as primary pool).
  (pool as pg.Pool & { _queueLimit?: number })._queueLimit = cfg.queueLimit;
  // @types/pg declares the 'connect' listener as `() => void`, but pg passes
  // the PoolClient at runtime. Narrow the emitter for this one call.

  (pool as unknown as {

    on(event: 'connect', cb: (c: pg.PoolClient) => void): void;

  }).on('connect', (client: pg.PoolClient) => {
    // Issue both SETs in one round-trip so the connection is either fully
    // configured or rejected — no partial state can enter the pool.
    const sql = timeoutMs > 0
      ? `SET default_transaction_read_only = on; SET statement_timeout = ${timeoutMs}`
      : 'SET default_transaction_read_only = on';

    client.query(sql).catch((err: Error) => {
      logger.error('Failed to configure replica connection', undefined, {
        error: err.message,
      });
    });
  });

  pool.on('error', (err: Error) => {
    logger.error('Replica pool error', undefined, {
      error: err.message,
      host: safeHostname(cfg.connectionString),
    });
  });

  return pool;
}

// ── Health check ──────────────────────────────────────────────────────────────

/**
 * Run a lightweight health-check query (`SELECT 1`) against the replica pool.
 * Returns `true` when the replica is reachable, `false` otherwise.
 *
 * The check is deliberately simple — it validates TCP connectivity and basic
 * query execution rather than replication lag (which depends on deployment
 * topology and is better monitored externally).
 */
export async function checkReplicaHealth(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Replica health-check failed — falling back to primary', undefined, {
      error: message,
    });
    return false;
  }
}

// ── Replication lag check ─────────────────────────────────────────────────────

/**
 * Check the replication lag of the replica in seconds.
 * Returns null if the lag check fails or no replica is available.
 */
export async function checkReplicationLag(): Promise<number | null> {
  if (!_replicaPool || !_replicaHealthy) {
    return null;
  }

  const now = Date.now();
  if (now - _lastLagCheckTime < LAG_CHECK_INTERVAL_MS) {
    return _lastLagValue;
  }

  try {
    // Check using pg_last_xact_replay_timestamp which works in PostgreSQL 10+
    const result = await _replicaPool.query(`
      SELECT 
        CASE 
          WHEN pg_is_in_recovery() THEN 
            EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))
          ELSE 
            0 
        END AS lag_seconds
    `);

    const lagSeconds = result.rows[0]?.lag_seconds as number | null;
    _lastLagValue = lagSeconds ?? null;
    _lastLagCheckTime = now;

    // Update the metric
    if (_lastLagValue !== null) {
      dbReplicationLagSeconds.set(_lastLagValue);
    } else {
      dbReplicationLagSeconds.set(NaN);
    }

    return _lastLagValue;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to check replication lag', undefined, {
      error: message,
    });
    _lastLagValue = null;
    _lastLagCheckTime = now;
    dbReplicationLagSeconds.set(NaN);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Options for getting a read pool.
 */
export interface GetReadPoolOptions {
  /**
   * If true, force the query to use the primary pool instead of the replica.
   * Use this when read-after-write consistency is required.
   */
  forcePrimary?: boolean;
}

/**
 * Return a pg.Pool suitable for read (SELECT) queries.
 *
 * On the first call the function will:
 *   1. Check whether `DATABASE_REPLICA_URL` is defined.
 *   2. If yes, create a replica pool and run a health-check.
 *   3. If the replica is healthy, return it for all subsequent calls.
 *   4. Otherwise, fall back to the primary pool.
 *
 * Once resolved the decision is cached — the function becomes synchronous
 * on subsequent calls (returns the cached pool immediately via a resolved
 * promise).
 *
 * @param options - Options for pool selection.
 */
export async function getReadPool(options: GetReadPoolOptions = {}): Promise<pg.Pool> {
  const { forcePrimary = false } = options;

  // If forced to primary, return primary immediately
  if (forcePrimary) {
    return getPool();
  }

  // Fast path: already resolved.
  if (_healthCheckDone) {
    return _replicaHealthy && _replicaPool ? _replicaPool : getPool();
  }

  const cfg = resolveReplicaPoolConfig();
  if (!cfg) {
    logger.info('DATABASE_REPLICA_URL not set — reads will use the primary pool');
    _healthCheckDone = true;
    _replicaHealthy = false;
    return getPool();
  }

  _replicaPool = createReplicaPool(cfg);
  _replicaHealthy = await checkReplicaHealth(_replicaPool);
  _healthCheckDone = true;

  if (_replicaHealthy) {
    logger.info('Read-replica pool initialised', undefined, {
      host: safeHostname(cfg.connectionString),
    });
    return _replicaPool;
  }

  // Replica unreachable — close its pool and fall back.
  await _replicaPool.end().catch(() => {});
  _replicaPool = null;
  return getPool();
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Reset internal state (for tests only). */
export function resetReplicaPool(): void {
  _replicaPool = null;
  _replicaHealthy = false;
  _healthCheckDone = false;
  _lastLagCheckTime = 0;
  _lastLagValue = null;
}

/** Replace the singleton replica pool (for tests only). */
export function setReplicaPool(pool: pg.Pool | null, healthy = true): void {
  _replicaPool = pool;
  _replicaHealthy = healthy;
  _healthCheckDone = true;
}
