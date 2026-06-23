import { Counter, Histogram, Gauge } from 'prom-client';
import { registry } from '../metrics.js';

/**
 * Histogram tracking JWT verification latency in seconds.
 *
 * Auth runs on every protected request path. When the JWT verifier or the
 * revocation-store lookup becomes a bottleneck, this histogram exposes the
 * p50/p95/p99 distribution. Buckets are tuned for an in-process cryptographic
 * verify plus an optional Redis revocation check — sub-millisecond through
 * 1s — so the typical tail is visible without overcounting microseconds.
 *
 * @security
 * - Label set is intentionally limited to `outcome` (`success` | `failure`)
 *   to avoid emitting high-cardinality or credential-bearing labels
 *   (no `jti`, `address`, `subject`, `kid`, etc.).
 */
export const authJwtVerifyDurationSeconds =
  (registry.getSingleMetric('fluxora_auth_jwt_verify_duration_seconds') as Histogram<
    'outcome'
  >) ||
  new Histogram({
    name: 'fluxora_auth_jwt_verify_duration_seconds',
    help: 'Duration of JWT signature verification in seconds, labeled by outcome',
    labelNames: ['outcome'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  });

/**
 * Histogram tracking API-key lookup latency in seconds.
 *
 * Records every API-key auth attempt that resolves a raw key against the
 * key store (per-service keys via {@link isValidApiKey}) or against the
 * admin env-var key ({@link requireAdminAuth}). The store is currently
 * in-memory, so buckets are skewed to sub-millisecond values to expose
 * regressions if a future DB-backed store is introduced.
 *
 * @security
 * - Label set is intentionally limited to `outcome` (`success` | `failure`)
 *   to avoid emitting high-cardinality or credential-bearing labels
 *   (no key id, key prefix, hash, or raw key material).
 */
export const authApiKeyLookupDurationSeconds =
  (registry.getSingleMetric('fluxora_auth_apikey_lookup_duration_seconds') as Histogram<
    'outcome'
  >) ||
  new Histogram({
    name: 'fluxora_auth_apikey_lookup_duration_seconds',
    help: 'Duration of API key lookup in seconds, labeled by outcome',
    labelNames: ['outcome'] as const,
    buckets: [0.0001, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05],
    registers: [registry],
  });

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

/**
 * Total live SSE subscribers across all stream IDs.
 * Updated on every subscribe/unsubscribe call.
 */
export const sseLiveSubscribersGauge =
  (registry.getSingleMetric('fluxora_sse_live_subscribers') as Gauge) ||
  new Gauge({
    name: 'fluxora_sse_live_subscribers',
    help: 'Total number of live SSE subscriber callbacks registered across all streams',
    registers: [registry],
  });

/**
 * Webhook Dead-Letter Queue (DLQ) depth gauge.
 *
 * Tracks the number of webhook deliveries that have failed permanently and are queued for
 * manual review/processing. High values indicate delivery failures are accumulating.
 *
 * Suggested alert threshold: > 100 items (or adjusted based on your SLA)
 *
 * @see https://github.com/Fluxora-Org/Fluxora-Backend/docs/webhooks.md for DLQ documentation
 */
export const webhookDlqItemsGauge =
  (registry.getSingleMetric('fluxora_webhook_dlq_items') as Gauge) ||
  new Gauge({
    name: 'fluxora_webhook_dlq_items',
    help: 'Number of webhook deliveries in the dead-letter queue (permanently failed)',
    registers: [registry],
  });

/**
 * Current EventEmitter listener count on SSE_STREAM_UPDATE_EVENT.
 * Should be 0 (idle) or 1 (dispatcher attached). Spikes above 1 indicate a
 * regression that reintroduces per-connection listeners.
 */
export const sseEventListenersGauge =
  (registry.getSingleMetric('fluxora_sse_event_listeners') as Gauge) ||
  new Gauge({
    name: 'fluxora_sse_event_listeners',
    help: 'Number of EventEmitter listeners on SSE_STREAM_UPDATE_EVENT (expected 0 or 1)',
    registers: [registry],
  });

/**
 * Webhook outbox backlog gauge.
 *
 * Tracks the number of webhook deliveries pending in the outbox (waiting to be sent or retried).
 * This gauge helps detect when the delivery pipeline is stalled or backed up.
 *
 * High values may indicate:
 * - External endpoint is slow or unresponsive
 * - Network issues or connectivity problems
 * - The delivery processor is not running or is stuck
 *
 * Suggested alert threshold: > 1000 items (or adjusted based on your expected throughput)
 *
 * @see https://github.com/Fluxora-Org/Fluxora-Backend/docs/webhooks.md for outbox documentation
 */
export const webhookOutboxPendingItemsGauge =
  (registry.getSingleMetric('fluxora_webhook_outbox_pending_items') as Gauge) ||
  new Gauge({
    name: 'fluxora_webhook_outbox_pending_items',
    help: 'Number of webhook deliveries pending in the outbox (awaiting delivery or retry)',
    registers: [registry],
  });

/**
 * Sync webhook metrics (DLQ depth and outbox backlog) from the store into Prometheus gauges.
 *
 * This function should be called periodically (via scheduled task) or on each `/metrics` scrape.
 * It reads the current state from the webhook delivery store and updates the gauges.
 *
 * @param store - WebhookDeliveryStore instance to read metrics from
 *
 * @example
 * // Call on each metrics scrape
 * app.get('/metrics', (req, res) => {
 *   syncWebhookMetrics(webhookDeliveryStore);
 *   // ... return metrics
 * });
 *
 * @see webhookDlqItemsGauge
 * @see webhookOutboxPendingItemsGauge
 */
export function syncWebhookMetrics(store: {
  getMetrics(): {
    totalDeliveries: number;
    successfulDeliveries: number;
    failedDeliveries: number;
    dlqItems: number;
    outboxItems: number;
  };
}): void {
  const metrics = store.getMetrics();
  webhookDlqItemsGauge.set(Math.max(0, metrics.dlqItems));
  webhookOutboxPendingItemsGauge.set(Math.max(0, metrics.outboxItems));
}

/** Clean helper to de-register metrics between test runs. */
export function deRegisterBusinessMetrics(): void {
  registry.removeSingleMetric('fluxora_auth_jwt_verify_duration_seconds');
  registry.removeSingleMetric('fluxora_auth_apikey_lookup_duration_seconds');
  registry.removeSingleMetric('fluxora_streams_created_total');
  registry.removeSingleMetric('fluxora_sse_active_connections');
  registry.removeSingleMetric('fluxora_sse_connections_rejected_total');
  registry.removeSingleMetric('fluxora_webhook_deliveries_total');
  registry.removeSingleMetric('fluxora_webhook_delivery_duration_seconds');
  registry.removeSingleMetric('fluxora_webhook_dlq_items');
  registry.removeSingleMetric('fluxora_webhook_outbox_pending_items');
  registry.removeSingleMetric('fluxora_indexer_events_ingested_total');
  registry.removeSingleMetric('fluxora_indexer_lag_seconds');
  registry.removeSingleMetric('fluxora_sse_live_subscribers');
  registry.removeSingleMetric('fluxora_sse_event_listeners');
}
