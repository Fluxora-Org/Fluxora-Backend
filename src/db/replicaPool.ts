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
import { getPool, resolvePoolConfig } from './pool.js';
import type { PoolConfig } from './pool.js';
import { dbReplicaLagSeconds } from '../metrics/dbMetrics.js';

const { Pool } = pg;
const DEFAULT_REPLICA_MAX_LAG_SECONDS = 30;

// ── Internal state ────────────────────────────────────────────────────────────

let _replicaPool: pg.Pool | null = null;
let _healthCheckDone = false;

export interface ReplicaHealth {
  healthy: boolean;
  lagSeconds: number;
  reason?: 'query_failed' | 'lag_unknown' | 'lag_exceeded';
}

function replicaMaxLagSeconds(): number {
  const raw = process.env['REPLICA_MAX_LAG_SECONDS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_REPLICA_MAX_LAG_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_REPLICA_MAX_LAG_SECONDS;
}

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
 */
export function resolveReplicaPoolConfig(): PoolConfig | null {
  const replicaUrl = process.env['DATABASE_REPLICA_URL'];
  if (!replicaUrl) {
    return null;
  }

  const primaryCfg = resolvePoolConfig();
  return {
    ...primaryCfg,
    connectionString: replicaUrl,
  };
}

/**
 * Create a pg.Pool for the read replica.
 * Sets `default_transaction_read_only = on` on every new connection so that
 * accidental INSERT/UPDATE/DELETE statements are rejected by PostgreSQL.
 */
export function createReplicaPool(config?: PoolConfig): pg.Pool {
  const cfg = config ?? resolveReplicaPoolConfig()!;
  const pool = new Pool({
    connectionString: cfg.connectionString,
    min: cfg.min,
    max: cfg.max,
    connectionTimeoutMillis: cfg.connectionTimeoutMillis,
    idleTimeoutMillis: cfg.idleTimeoutMillis,
  });

  // Enforce read-only mode on every physical connection to prevent
  // writes from accidentally reaching the replica.
  pool.on('connect', (client: pg.PoolClient) => {
    client.query('SET default_transaction_read_only = on').catch((err: Error) => {
      logger.error('Failed to set read-only mode on replica connection', undefined, {
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
 * Check replica connectivity and replay freshness.
 *
 * `pg_last_xact_replay_timestamp()` is NULL on a primary or when the replica has
 * not replayed a transaction yet. For an explicitly configured read-replica,
 * that is treated as unknown freshness and reads fall back to the primary.
 */
export async function checkReplicaHealth(pool: pg.Pool): Promise<ReplicaHealth> {
  const maxLagSeconds = replicaMaxLagSeconds();

  try {
    const result = await pool.query<{ lag_seconds: number | string | null }>(
      `
        SELECT EXTRACT(
          EPOCH FROM now() - pg_last_xact_replay_timestamp()
        ) AS lag_seconds
      `,
    );
    const rawLag = result.rows[0]?.lag_seconds;
    const lagSeconds = rawLag === null || rawLag === undefined ? Number.NaN : Number(rawLag);

    if (!Number.isFinite(lagSeconds)) {
      dbReplicaLagSeconds.set(0);
      logger.warn('Replica health-check could not determine replication lag; falling back to primary');
      return { healthy: false, lagSeconds: 0, reason: 'lag_unknown' };
    }

    const normalizedLag = Math.max(0, lagSeconds);
    dbReplicaLagSeconds.set(normalizedLag);

    if (normalizedLag > maxLagSeconds) {
      logger.warn('Replica lag exceeds threshold; falling back to primary', undefined, {
        lagSeconds: normalizedLag,
        maxLagSeconds,
      });
      return { healthy: false, lagSeconds: normalizedLag, reason: 'lag_exceeded' };
    }

    return { healthy: true, lagSeconds: normalizedLag };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dbReplicaLagSeconds.set(0);
    logger.warn('Replica health-check failed; falling back to primary', undefined, {
      error: message,
    });
    return { healthy: false, lagSeconds: 0, reason: 'query_failed' };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

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
 */
export async function getReadPool(): Promise<pg.Pool> {
  // Fast path: already resolved.
  if (_healthCheckDone && !_replicaPool) {
    return getPool();
  }

  const cfg = resolveReplicaPoolConfig();
  if (!cfg) {
    logger.info('DATABASE_REPLICA_URL not set — reads will use the primary pool');
    _healthCheckDone = true;
    dbReplicaLagSeconds.set(0);
    return getPool();
  }

  _replicaPool ??= createReplicaPool(cfg);
  const health = await checkReplicaHealth(_replicaPool);
  _healthCheckDone = true;

  if (health.healthy) {
    logger.info('Read-replica pool initialised', undefined, {
      host: safeHostname(cfg.connectionString),
      lagSeconds: health.lagSeconds,
    });
    return _replicaPool;
  }

  return getPool();
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Reset internal state (for tests only). */
export function resetReplicaPool(): void {
  _replicaPool = null;
  _healthCheckDone = false;
  dbReplicaLagSeconds.set(0);
}

/** Replace the singleton replica pool (for tests only). */
export function setReplicaPool(pool: pg.Pool | null, healthy = true): void {
  _replicaPool = pool;
  _healthCheckDone = !healthy || pool === null;
}
