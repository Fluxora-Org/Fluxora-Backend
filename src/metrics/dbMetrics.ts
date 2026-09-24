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

/** Bounded set of DB query failure classes recorded by dbQueryErrorsTotal. */
export const DB_ERROR_TYPES = ['pool_exhausted', 'query_timeout', 'duplicate_entry', 'other'] as const;

export type DbErrorType = (typeof DB_ERROR_TYPES)[number];

/**
 * Counter of PostgreSQL query failures, partitioned by error_type.
 *
 * Emitted on EVERY query failure path — pool exhaustion (fast-fail before
 * execution), statement_timeout (PG 57014), unique-violation (PG 23505), and
 * any other driver/connection error. Without it the metrics that only fire on
 * the success path (e.g. dbSlowQueriesTotal) go quiet exactly when queries
 * start failing, so the dashboard flatlines instead of spiking at the moment
 * of an incident.
 *
 * Labels: error_type — must take one of the DB_ERROR_TYPES values so label
 * cardinality is bounded at 4 series regardless of how many queries fail.
 */
export const dbQueryErrorsTotal =
  (registry.getSingleMetric('fluxora_db_query_errors_total') as Counter<'error_type'>) ||
  new Counter({
    name: 'fluxora_db_query_errors_total',
    help: `Total number of PostgreSQL query failures, partitioned by error_type (${DB_ERROR_TYPES.join(', ')})`,
    labelNames: ['error_type'] as const,
    registers: [registry],
  });

/**
 * Gauge for PostgreSQL replication lag in seconds.
 * Reports null if replication lag is not measurable (e.g., no replica configured or lag check failed).
 */
export const dbReplicationLagSeconds =
  (registry.getSingleMetric('fluxora_db_replication_lag_seconds') as Gauge) ||
  new Gauge({
    name: 'fluxora_db_replication_lag_seconds',
    help: 'PostgreSQL replication lag in seconds',
    registers: [registry],
  });

export function deRegisterDbMetrics(): void {
  registry.removeSingleMetric('fluxora_db_query_duration_seconds');
  registry.removeSingleMetric('fluxora_db_slow_queries_total');
  registry.removeSingleMetric('fluxora_db_pool_active_connections');
  registry.removeSingleMetric('fluxora_db_pool_idle_connections');
  registry.removeSingleMetric('fluxora_db_pool_waiting_requests');
  registry.removeSingleMetric('fluxora_db_pool_exhausted_total');
  registry.removeSingleMetric('fluxora_db_query_errors_total');
  registry.removeSingleMetric('fluxora_db_replication_lag_seconds');
}
