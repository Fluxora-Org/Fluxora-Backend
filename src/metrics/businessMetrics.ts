import { Counter, Histogram, Gauge } from 'prom-client';
import { registry } from '../metrics.js';

interface WebhookStoreMetricsSnapshot {
  dlqItems: number;
  outboxItems: number;
}

let webhookStoreMetricsSource: (() => WebhookStoreMetricsSnapshot) | null = null;
let webhookCircuitBreakerOpenEndpointCount = 0;

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

/**
 * Current count of webhook deliveries in the dead-letter queue.
 *
 * This gauge intentionally has no endpoint labels so consumer URLs, secrets, or
 * other high-cardinality values cannot leak through Prometheus.
 */
export const webhookDlqItemsGauge =
  (registry.getSingleMetric('fluxora_webhook_dlq_items') as Gauge) ||
  new Gauge({
    name: 'fluxora_webhook_dlq_items',
    help: 'Current number of webhook deliveries in the dead-letter queue',
    registers: [registry],
    collect() {
      refreshWebhookStoreGauges();
    },
  });

/**
 * Current count of pending webhook outbox items waiting for delivery.
 *
 * No per-URL labels are exposed; alerting should be based on aggregate backlog.
 */
export const webhookOutboxPendingItemsGauge =
  (registry.getSingleMetric('fluxora_webhook_outbox_pending_items') as Gauge) ||
  new Gauge({
    name: 'fluxora_webhook_outbox_pending_items',
    help: 'Current number of pending webhook outbox items waiting for delivery',
    registers: [registry],
    collect() {
      refreshWebhookStoreGauges();
    },
  });

/**
 * Current process-local count of webhook consumer endpoints whose circuit
 * breaker is open.
 *
 * The count is aggregate-only to avoid URL label cardinality and PII leakage.
 */
export const webhookCircuitBreakerOpenEndpointsGauge =
  (registry.getSingleMetric('fluxora_webhook_circuit_breaker_open_endpoints') as Gauge) ||
  new Gauge({
    name: 'fluxora_webhook_circuit_breaker_open_endpoints',
    help: 'Current number of webhook consumer endpoints with an open circuit breaker',
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

function clampGaugeValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function refreshWebhookStoreGauges(): void {
  if (!webhookStoreMetricsSource) return;

  try {
    const snapshot = webhookStoreMetricsSource();
    webhookDlqItemsGauge.set(clampGaugeValue(snapshot.dlqItems));
    webhookOutboxPendingItemsGauge.set(clampGaugeValue(snapshot.outboxItems));
  } catch {
    // Never let a transient store read failure break /metrics scraping.
  }
}

/** Register or clear the source used to refresh webhook store gauges on scrape. */
export function registerWebhookStoreMetricsSource(source: (() => WebhookStoreMetricsSnapshot) | null): void {
  webhookStoreMetricsSource = source;
  if (source) refreshWebhookStoreGauges();
}

/** Explicitly synchronize webhook DLQ/outbox gauges from a known snapshot. */
export function syncWebhookStoreMetrics(snapshot: WebhookStoreMetricsSnapshot): void {
  webhookDlqItemsGauge.set(clampGaugeValue(snapshot.dlqItems));
  webhookOutboxPendingItemsGauge.set(clampGaugeValue(snapshot.outboxItems));
}

/**
 * Update the aggregate open-circuit gauge when a webhook endpoint changes
 * circuit-breaker phase.
 */
export function recordWebhookCircuitBreakerTransition(fromState: string, toState: string): void {
  if (fromState !== 'open' && toState === 'open') {
    webhookCircuitBreakerOpenEndpointCount += 1;
  } else if (fromState === 'open' && toState !== 'open') {
    webhookCircuitBreakerOpenEndpointCount = Math.max(0, webhookCircuitBreakerOpenEndpointCount - 1);
  }

  webhookCircuitBreakerOpenEndpointsGauge.set(webhookCircuitBreakerOpenEndpointCount);
}

/** Clean helper to de-register metrics between test runs. */
export function deRegisterBusinessMetrics(): void {
  webhookStoreMetricsSource = null;
  webhookCircuitBreakerOpenEndpointCount = 0;

  registry.removeSingleMetric('fluxora_streams_created_total');
  registry.removeSingleMetric('fluxora_sse_active_connections');
  registry.removeSingleMetric('fluxora_sse_connections_rejected_total');
  registry.removeSingleMetric('fluxora_webhook_deliveries_total');
  registry.removeSingleMetric('fluxora_webhook_delivery_duration_seconds');
  registry.removeSingleMetric('fluxora_webhook_dlq_items');
  registry.removeSingleMetric('fluxora_webhook_outbox_pending_items');
  registry.removeSingleMetric('fluxora_webhook_circuit_breaker_open_endpoints');
  registry.removeSingleMetric('fluxora_indexer_events_ingested_total');
  registry.removeSingleMetric('fluxora_indexer_lag_seconds');
}