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

export const sseActiveConnectionsGauge =
  (registry.getSingleMetric('fluxora_sse_active_connections') as Gauge) ||
  new Gauge({
    name: 'fluxora_sse_active_connections',
    help: 'Current number of active Server-Sent Events stream connections',
    registers: [registry],
  });

export const sseConnectionsRejectedTotal =
  (registry.getSingleMetric('fluxora_sse_connections_rejected_total') as Counter<'reason'>) ||
  new Counter({
    name: 'fluxora_sse_connections_rejected_total',
    help: 'Total number of rejected Server-Sent Events stream connection attempts',
    labelNames: ['reason'] as const,
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

export const authJwtVerifyDurationSeconds =
  (registry.getSingleMetric('fluxora_auth_jwt_verify_duration_seconds') as Histogram<'outcome'>) ||
  new Histogram({
    name: 'fluxora_auth_jwt_verify_duration_seconds',
    help: 'Duration of JWT signature and expiry verification in seconds',
    labelNames: ['outcome'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  });

export const authApiKeyLookupDurationSeconds =
  (registry.getSingleMetric('fluxora_auth_apikey_lookup_duration_seconds') as Histogram<'outcome'>) ||
  new Histogram({
    name: 'fluxora_auth_apikey_lookup_duration_seconds',
    help: 'Duration of API key hash lookup in seconds',
    labelNames: ['outcome'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
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

/** Clean helper to de-register metrics between test runs. */
export function deRegisterBusinessMetrics(): void {
  registry.removeSingleMetric('fluxora_streams_created_total');
  registry.removeSingleMetric('fluxora_sse_active_connections');
  registry.removeSingleMetric('fluxora_sse_connections_rejected_total');
  registry.removeSingleMetric('fluxora_webhook_deliveries_total');
  registry.removeSingleMetric('fluxora_webhook_delivery_duration_seconds');
  registry.removeSingleMetric('fluxora_auth_jwt_verify_duration_seconds');
  registry.removeSingleMetric('fluxora_auth_apikey_lookup_duration_seconds');
  registry.removeSingleMetric('fluxora_indexer_events_ingested_total');
  registry.removeSingleMetric('fluxora_indexer_lag_seconds');
}
