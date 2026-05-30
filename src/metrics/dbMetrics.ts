import { Counter, Gauge } from 'prom-client';
import { registry } from '../metrics.js';

export const dbSlowQueriesTotal =
  (registry.getSingleMetric('fluxora_db_slow_queries_total') as Counter<'table_hint'>) ||
  new Counter({
    name: 'fluxora_db_slow_queries_total',
    help: 'Total number of PostgreSQL queries exceeding the slow-query threshold',
    labelNames: ['table_hint'] as const,
    registers: [registry],
  });

export const dbPoolActiveConnections =
  (registry.getSingleMetric('fluxora_db_pool_active_connections') as Gauge) ||
  new Gauge({
    name: 'fluxora_db_pool_active_connections',
    help: 'Number of active (checked-out) pool connections',
    registers: [registry],
  });

export const dbPoolIdleConnections =
  (registry.getSingleMetric('fluxora_db_pool_idle_connections') as Gauge) ||
  new Gauge({
    name: 'fluxora_db_pool_idle_connections',
    help: 'Number of idle pool connections',
    registers: [registry],
  });

export const dbPoolWaitingRequests =
  (registry.getSingleMetric('fluxora_db_pool_waiting_requests') as Gauge) ||
  new Gauge({
    name: 'fluxora_db_pool_waiting_requests',
    help: 'Number of requests waiting for a pool connection',
    registers: [registry],
  });

export const dbPoolExhaustedTotal =
  (registry.getSingleMetric('fluxora_db_pool_exhausted_total') as Counter) ||
  new Counter({
    name: 'fluxora_db_pool_exhausted_total',
    help: 'Total number of times the pool queue limit was exceeded',
    registers: [registry],
  });

export function deRegisterDbMetrics(): void {
  registry.removeSingleMetric('fluxora_db_slow_queries_total');
  registry.removeSingleMetric('fluxora_db_pool_active_connections');
  registry.removeSingleMetric('fluxora_db_pool_idle_connections');
  registry.removeSingleMetric('fluxora_db_pool_waiting_requests');
  registry.removeSingleMetric('fluxora_db_pool_exhausted_total');
}
