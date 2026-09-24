/**
 * src/metrics/pool.ts
 *
 * Isolated prom-client Gauge definitions for pg.Pool telemetry.
 *
 * Each gauge carries a `pool` label so multiple named pools
 * (e.g. "default", "read-replica") are distinguishable in Prometheus.
 *
 * Metric names follow the Prometheus naming convention:
 *   db_pool_active                  – connections currently checked out
 *   db_pool_idle                    – connections sitting idle in the pool
 *   db_pool_waiting                 – client requests queued waiting for a connection
 *   db_pool_saturation_ratio        – checked-out connections / configured capacity (0..1)
 *   db_pool_queue_saturation_ratio  – queued requests / configured queue limit (0..1)
 *
 * Why the ratio gauges exist: `db_pool_waiting` only leaves 0 once the pool is
 * already exhausted, so an alert on it fires too late to be actionable. The two
 * `*_saturation_ratio` gauges start moving while there is still headroom, which
 * gives operators lead time to scale the pool or shed load.
 *
 * Intended alert thresholds (see docs/observability/database-metrics.md):
 *   db_pool_saturation_ratio        warn ≥ 0.80, page ≥ 0.95
 *   db_pool_queue_saturation_ratio  warn ≥ 0.50, page ≥ 0.90
 *
 * Security note: label values are set only from the `poolName` parameter
 * passed by the application; they are never derived from user input or
 * query parameters, preventing label-injection attacks. Every gauge exposes a
 * single bounded `pool` label, so cardinality is O(number of pools) — a
 * constant chosen by the application, not by callers.
 */

import { Gauge, Counter } from 'prom-client';
import { registry } from '../metrics.js';
import { logger } from '../lib/logger.js';

/**
 * Minimal snapshot of a `pg.Pool` used to publish gauges.
 *
 * `capacity` and `queueLimit` are optional so callers that only have the live
 * counters (e.g. lightweight fakes in tests) can still update the base gauges.
 */
export interface PoolStateSnapshot {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  /** Configured maximum connections (`pg.Pool.options.max`), when known. */
  capacity?: number;
  /** Max queued requests before the pool fast-fails (`POOL_QUEUE_LIMIT`), when known. */
  queueLimit?: number;
}

/** Clamp a ratio to the inclusive [0, 1] range, guarding against bad inputs. */
function clampRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  const value = numerator / denominator;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/** Number of connections currently checked out (active). */
export const dbPoolActive =
  (registry.getSingleMetric('db_pool_active') as Gauge<'pool'>) ||
  new Gauge<'pool'>({
    name: 'db_pool_active',
    help: 'Number of active (checked-out) pg.Pool connections',
    labelNames: ['pool'],
    registers: [registry],
  });

/** Number of connections sitting idle in the pool. */
export const dbPoolIdle =
  (registry.getSingleMetric('db_pool_idle') as Gauge<'pool'>) ||
  new Gauge<'pool'>({
    name: 'db_pool_idle',
    help: 'Number of idle pg.Pool connections',
    labelNames: ['pool'],
    registers: [registry],
  });

/** Number of client requests queued waiting for a connection. */
export const dbPoolWaiting =
  (registry.getSingleMetric('db_pool_waiting') as Gauge<'pool'>) ||
  new Gauge<'pool'>({
    name: 'db_pool_waiting',
    help: 'Number of requests waiting for a pg.Pool connection',
    labelNames: ['pool'],
    registers: [registry],
  });

/**
 * Fraction of the configured connection capacity currently in use
 * (`active / capacity`, clamped to 0..1).
 *
 * This is the lead-time signal: it climbs as connections are checked out and
 * crosses the warning threshold while `db_pool_waiting` is still 0.
 *
 * Alert thresholds: warn ≥ 0.80, page ≥ 0.95.
 */
export const dbPoolSaturationRatio =
  (registry.getSingleMetric('db_pool_saturation_ratio') as Gauge<'pool'>) ||
  new Gauge<'pool'>({
    name: 'db_pool_saturation_ratio',
    help: 'Fraction of configured pg.Pool capacity in use (active / max); alert at 0.8, page at 0.95',
    labelNames: ['pool'],
    registers: [registry],
  });

/**
 * Fraction of the wait queue currently occupied
 * (`waiting / queueLimit`, clamped to 0..1).
 *
 * Reaches 1 on the exact request path that refuses work: `query()` in
 * `src/db/pool.ts` fast-fails with `PoolExhaustedError` once
 * `waitingCount >= queueLimit`.
 *
 * Alert thresholds: warn ≥ 0.50, page ≥ 0.90.
 */
export const dbPoolQueueSaturationRatio =
  (registry.getSingleMetric('db_pool_queue_saturation_ratio') as Gauge<'pool'>) ||
  new Gauge<'pool'>({
    name: 'db_pool_queue_saturation_ratio',
    help: 'Fraction of the pg.Pool wait queue in use (waiting / queueLimit); alert at 0.5, page at 0.9',
    labelNames: ['pool'],
    registers: [registry],
  });

/** Counter incremented when totalCount < idleCount (should never happen for a healthy pg.Pool). */
export const dbPoolNegativeActive =
  (registry.getSingleMetric('fluxora_db_pool_negative_active_total') as Counter<'pool'>) ||
  new Counter<'pool'>({
    name: 'fluxora_db_pool_negative_active_total',
    help: 'Total count of times db_pool_active was clamped to 0 due to totalCount < idleCount',
    labelNames: ['pool'],
    registers: [registry],
  });

/**
 * Sync all gauges from the current pool state.
 *
 * @param pool     - pg.Pool snapshot (or a structurally compatible fake) to read counts from
 * @param poolName - stable identifier for the pool label (e.g. "default", "read-replica")
 *                   Must be a trusted, application-controlled string — never user input.
 */
export function syncPoolGauges(pool: PoolStateSnapshot, poolName: string): void {
  const rawActive = pool.totalCount - pool.idleCount;
  const active = rawActive < 0 ? 0 : rawActive;

  if (rawActive < 0) {
    dbPoolNegativeActive.inc({ pool: poolName });
    logger.warn('pg.Pool accounting inconsistency: totalCount < idleCount', undefined, {
      pool: poolName,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      clampedActive: 0,
    });
  }

  dbPoolActive.set({ pool: poolName }, active);
  dbPoolIdle.set({ pool: poolName }, pool.idleCount);
  dbPoolWaiting.set({ pool: poolName }, pool.waitingCount);

  // Lead-time ratios. Only published when the denominator is a known positive
  // number so an unconfigured pool never reports a misleading 0.
  if (typeof pool.capacity === 'number' && pool.capacity > 0) {
    dbPoolSaturationRatio.set({ pool: poolName }, clampRatio(active, pool.capacity));
  }

  if (typeof pool.queueLimit === 'number' && pool.queueLimit > 0) {
    dbPoolQueueSaturationRatio.set({ pool: poolName }, clampRatio(pool.waitingCount, pool.queueLimit));
  }
}

/** Remove every pool gauge and the negative-active counter from the registry (useful between test runs). */
export function deRegisterPoolMetrics(): void {
  registry.removeSingleMetric('db_pool_active');
  registry.removeSingleMetric('db_pool_idle');
  registry.removeSingleMetric('db_pool_waiting');
  registry.removeSingleMetric('db_pool_saturation_ratio');
  registry.removeSingleMetric('db_pool_queue_saturation_ratio');
  registry.removeSingleMetric('fluxora_db_pool_negative_active_total');
}
