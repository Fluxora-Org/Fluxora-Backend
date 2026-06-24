import { Counter, Histogram, Gauge } from 'prom-client';
import { registry } from '../metrics.js';

export const streamsCreatedTotal =
  (registry.getSingleMetric('fluxora_streams_created_total') as Counter<'status'>) ||
  new Counter({
    name: 'fluxora_streams_created_total',
    help: 'Total number of treasury streams created',
    labelNames: ['status'] as const,
    registers: [registry],
  });

export const webhookDeliveriesTotal =
  (registry.getSingleMetric('fluxora_webhook_deliveries_total') as Counter<'outcome'>) ||
  new Counter({
    name: 'fluxora_webhook_deliveries_total',
    help: 'Total number of webhook deliveries',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });

export const webhookDeliveryDurationSeconds =
  (registry.getSingleMetric('fluxora_webhook_delivery_duration_seconds') as Histogram) ||
  new Histogram({
    name: 'fluxora_webhook_delivery_duration_seconds',
    help: 'Duration of webhook delivery attempts in seconds',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

export const indexerEventsIngestedTotal =
  (registry.getSingleMetric('fluxora_indexer_events_ingested_total') as Counter) ||
  new Counter({
    name: 'fluxora_indexer_events_ingested_total',
    help: 'Total number of contract events ingested by the indexer',
    registers: [registry],
  });

export const indexerLagSeconds =
  (registry.getSingleMetric('fluxora_indexer_lag_seconds') as Gauge) ||
  new Gauge({
    name: 'fluxora_indexer_lag_seconds',
    help: 'Ingestion lag of the indexer in seconds',
    registers: [registry],
  });

export const replicaLagMs =
  (registry.getSingleMetric('fluxora_replica_lag_ms') as Gauge) ||
  new Gauge({
    name: 'fluxora_replica_lag_ms',
    help: 'Replication lag of the read replica in milliseconds (-1 when unavailable)',
    registers: [registry],
  });

export const replicaFailoversTotal =
  (registry.getSingleMetric('fluxora_replica_failovers_total') as Counter) ||
  new Counter({
    name: 'fluxora_replica_failovers_total',
    help: 'Total number of read-replica failovers to primary due to lag exceeding threshold',
    registers: [registry],
  });

export const webhookBatchFailuresTotal =
  (registry.getSingleMetric('fluxora_webhook_batch_failures_total') as Counter) ||
  new Counter({
    name: 'fluxora_webhook_batch_failures_total',
    help: 'Total number of webhook processBatch failures',
    registers: [registry],
  });

export const webhookBatchBackoffMs =
  (registry.getSingleMetric('fluxora_webhook_batch_backoff_ms') as Gauge) ||
  new Gauge({
    name: 'fluxora_webhook_batch_backoff_ms',
    help: 'Current exponential backoff delay before the next webhook batch poll in milliseconds',
    registers: [registry],
  });

/** Clean helper to de-register metrics between test runs. */
export function deRegisterBusinessMetrics(): void {
  registry.removeSingleMetric('fluxora_streams_created_total');
  registry.removeSingleMetric('fluxora_webhook_deliveries_total');
  registry.removeSingleMetric('fluxora_webhook_delivery_duration_seconds');
  registry.removeSingleMetric('fluxora_indexer_events_ingested_total');
  registry.removeSingleMetric('fluxora_indexer_lag_seconds');
  registry.removeSingleMetric('fluxora_replica_lag_ms');
  registry.removeSingleMetric('fluxora_replica_failovers_total');
  registry.removeSingleMetric('fluxora_webhook_batch_failures_total');
  registry.removeSingleMetric('fluxora_webhook_batch_backoff_ms');
}
