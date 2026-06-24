/**
 * src/metrics/pool.ts
 *
 * Isolated prom-client Gauge definitions for pg.Pool telemetry.
 *
 * Each gauge carries a `pool` label so multiple named pools
 * (e.g. "default", "read-replica") are distinguishable in Prometheus.
 *
 * Metric names follow the Prometheus naming convention:
 *   db_pool_active   – connections currently checked out
 *   db_pool_idle     – connections sitting idle in the pool
 *   db_pool_waiting  – client requests queued waiting for a connection
 *
 * Security note: label values are set only from the `poolName` parameter
 * passed by the application; they are never derived from user input or
 * query parameters, preventing label-injection attacks.
 */

import { Gauge } from 'prom-client';
import { registry } from '../metrics.js';

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
 * Sync all three gauges from the current pool state.
 *
 * @param pool     - pg.Pool instance to read counts from
 * @param poolName - stable identifier for the pool label (e.g. "default", "read-replica")
 *                   Must be a trusted, application-controlled string — never user input.
 */
export function syncPoolGauges(
  pool: { totalCount: number; idleCount: number; waitingCount: number },
  poolName: string,
): void {
  const active = pool.totalCount - pool.idleCount;
  dbPoolActive.set({ pool: poolName }, active < 0 ? 0 : active);
  dbPoolIdle.set({ pool: poolName }, pool.idleCount);
  dbPoolWaiting.set({ pool: poolName }, pool.waitingCount);
}

/** Remove all three gauges from the registry (useful between test runs). */
export function deRegisterPoolMetrics(): void {
  registry.removeSingleMetric('db_pool_active');
  registry.removeSingleMetric('db_pool_idle');
  registry.removeSingleMetric('db_pool_waiting');
}
