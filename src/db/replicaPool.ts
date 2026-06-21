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

const READ_REPLICA_POOL_NAME = 'read-replica';

// ── Internal state ────────────────────────────────────────────────────────────

let _replicaPool: pg.Pool | null = null;
let _replicaHealthy = false;
let _healthCheckDone = false;

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

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
    queueLimit: envInt('DATABASE_REPLICA_POOL_QUEUE_LIMIT', primaryCfg.queueLimit),
    statementTimeoutMs: envInt(
      'DATABASE_REPLICA_STATEMENT_TIMEOUT_MS',
      primaryCfg.statementTimeoutMs,
    ),
    poolName: READ_REPLICA_POOL_NAME,
  };
}

/**
 * Create a pg.Pool for the read replica.
 *
 * Reuses the primary pool factory so replica reads get the same queue-limit,
 * statement_timeout, slow-query, and labeled pool telemetry protections as the
 * primary pool. It then adds `default_transaction_read_only = on` on every new
 * connection so accidental INSERT/UPDATE/DELETE statements are rejected by
 * PostgreSQL.
 */
export function createReplicaPool(config?: PoolConfig): pg.Pool {
  const cfg = config ?? resolveReplicaPoolConfig()!;
  const pool = createPool({
    ...cfg,
    poolName: cfg.poolName ?? READ_REPLICA_POOL_NAME,
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
}

/** Replace the singleton replica pool (for tests only). */
export function setReplicaPool(pool: pg.Pool | null, healthy = true): void {
  _replicaPool = pool;
  _replicaHealthy = healthy;
  _healthCheckDone = true;
}
