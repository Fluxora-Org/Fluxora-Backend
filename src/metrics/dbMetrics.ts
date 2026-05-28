import { Gauge, Counter } from 'prom-client';
import { registry } from '../metrics.js';

/** Active (checked-out) connections in the pg pool. */
export const dbPoolActiveConnections =
  (registry.getSingleMetric('db_pool_active_connections') as Gauge) ||
  new Gauge({
    name: 'db_pool_active_connections',
    help: 'Number of active (checked-out) database connections',
    registers: [registry],
  });

/** Idle connections sitting in the pg pool. */
export const dbPoolIdleConnections =
  (registry.getSingleMetric('db_pool_idle_connections') as Gauge) ||
  new Gauge({
    name: 'db_pool_idle_connections',
    help: 'Number of idle database connections in the pool',
    registers: [registry],
  });

/** Requests waiting for a connection to become available. */
export const dbPoolWaitingRequests =
  (registry.getSingleMetric('db_pool_waiting_requests') as Gauge) ||
  new Gauge({
    name: 'db_pool_waiting_requests',
    help: 'Number of requests waiting for a database connection',
    registers: [registry],
  });

/** Total pool exhaustion events (queue limit exceeded). */
export const dbPoolExhaustedTotal =
  (registry.getSingleMetric('db_pool_exhausted_total') as Counter) ||
  new Counter({
    name: 'db_pool_exhausted_total',
    help: 'Total number of requests rejected due to pool queue limit being exceeded',
    registers: [registry],
  });

/** Remove all db pool metrics from the registry (useful in tests). */
export function deRegisterDbMetrics(): void {
  registry.removeSingleMetric('db_pool_active_connections');
  registry.removeSingleMetric('db_pool_idle_connections');
  registry.removeSingleMetric('db_pool_waiting_requests');
  registry.removeSingleMetric('db_pool_exhausted_total');
}
