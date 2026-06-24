import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from '../metrics.js';

/**
 * Histogram for PostgreSQL query duration.
 * Labels: repository (e.g. "streamRepository"), operation (e.g. "upsertStream")
 */
export const dbQueryDurationSeconds =
  (registry.getSingleMetric('fluxora_db_query_duration_seconds') as Histogram<
    'repository' | 'operation'
  >) ||
  new Histogram({
    name: 'fluxora_db_query_duration_seconds',
    help: 'Duration of PostgreSQL queries in seconds, partitioned by repository and operation',
    labelNames: ['repository', 'operation'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

/** Counter incremented for every slow query (duration ≥ SLOW_QUERY_THRESHOLD_MS). */
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
  registry.removeSingleMetric('fluxora_db_query_duration_seconds');
  registry.removeSingleMetric('fluxora_db_slow_queries_total');
  registry.removeSingleMetric('fluxora_db_pool_active_connections');
  registry.removeSingleMetric('fluxora_db_pool_idle_connections');
  registry.removeSingleMetric('fluxora_db_pool_waiting_requests');
  registry.removeSingleMetric('fluxora_db_pool_exhausted_total');
}
