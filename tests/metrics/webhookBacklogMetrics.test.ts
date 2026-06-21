import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registry } from '../../src/metrics.js';
import {
  deRegisterBusinessMetrics,
  recordWebhookCircuitBreakerTransition,
  registerWebhookStoreMetricsSource,
  syncWebhookStoreMetrics,
  webhookCircuitBreakerOpenEndpointsGauge,
  webhookDlqItemsGauge,
  webhookOutboxPendingItemsGauge,
} from '../../src/metrics/businessMetrics.js';

async function gaugeValue(gauge: typeof webhookDlqItemsGauge): Promise<number> {
  const metric = await gauge.get();
  return metric.values[0]?.value ?? 0;
}

describe('webhook backlog business metrics', () => {
  beforeEach(() => {
    registerWebhookStoreMetricsSource(null);
    webhookDlqItemsGauge.reset();
    webhookOutboxPendingItemsGauge.reset();
    webhookCircuitBreakerOpenEndpointsGauge.reset();
  });

  afterEach(() => {
    registerWebhookStoreMetricsSource(null);
  });

  it('syncs DLQ and outbox gauges without labels', async () => {
    syncWebhookStoreMetrics({ dlqItems: 3, outboxItems: 7 });

    expect(await gaugeValue(webhookDlqItemsGauge)).toBe(3);
    expect(await gaugeValue(webhookOutboxPendingItemsGauge)).toBe(7);

    const dlqMetric = await webhookDlqItemsGauge.get();
    expect(dlqMetric.values[0]?.labels).toEqual({});
  });

  it('refreshes DLQ and outbox gauges on Prometheus scrape', async () => {
    let snapshot = { dlqItems: 0, outboxItems: 1 };
    registerWebhookStoreMetricsSource(() => snapshot);

    expect(await registry.metrics()).toMatch(/fluxora_webhook_outbox_pending_items\{[^}]*\} 1/);

    snapshot = { dlqItems: 2, outboxItems: 5 };
    const scrape = await registry.metrics();

    expect(scrape).toMatch(/fluxora_webhook_dlq_items\{[^}]*\} 2/);
    expect(scrape).toMatch(/fluxora_webhook_outbox_pending_items\{[^}]*\} 5/);
  });

  it('keeps metrics scraping healthy if the store metrics source throws', async () => {
    syncWebhookStoreMetrics({ dlqItems: 4, outboxItems: 6 });
    registerWebhookStoreMetricsSource(() => {
      throw new Error('store unavailable');
    });

    const scrape = await registry.metrics();

    expect(scrape).toMatch(/fluxora_webhook_dlq_items\{[^}]*\} 4/);
    expect(scrape).toMatch(/fluxora_webhook_outbox_pending_items\{[^}]*\} 6/);
  });

  it('tracks open circuit-breaker endpoints as an aggregate count', async () => {
    recordWebhookCircuitBreakerTransition('closed', 'open');
    recordWebhookCircuitBreakerTransition('closed', 'open');
    recordWebhookCircuitBreakerTransition('open', 'half-open');

    expect(await gaugeValue(webhookCircuitBreakerOpenEndpointsGauge)).toBe(1);

    const metric = await webhookCircuitBreakerOpenEndpointsGauge.get();
    expect(metric.values[0]?.labels).toEqual({});
  });

  it('de-registers the webhook gauges with the rest of the business metrics', () => {
    deRegisterBusinessMetrics();

    expect(registry.getSingleMetric('fluxora_webhook_dlq_items')).toBeUndefined();
    expect(registry.getSingleMetric('fluxora_webhook_outbox_pending_items')).toBeUndefined();
    expect(registry.getSingleMetric('fluxora_webhook_circuit_breaker_open_endpoints')).toBeUndefined();
  });
});