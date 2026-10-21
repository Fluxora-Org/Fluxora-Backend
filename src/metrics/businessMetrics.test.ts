import { Histogram } from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isValidDeliveryOutcome,
  isValidRejectionReason,
  isValidStreamStatus,
  safeObserveDuration,
  syncWebhookMetrics,
  webhookDlqItemsGauge,
  webhookMetricsSyncTotal,
  webhookOutboxPendingItemsGauge,
} from './businessMetrics.js';
import type { WebhookMetricsProvider } from './businessMetrics.js';

async function gaugeValue(gauge: {
  get: () => Promise<{ values: Array<{ value: number }> }>;
}): Promise<number> {
  const snapshot = await gauge.get();
  return snapshot.values[0]?.value ?? 0;
}

async function syncOutcome(outcome: string): Promise<number> {
  const snapshot = await webhookMetricsSyncTotal.get();
  return snapshot.values.find((value) => value.labels.outcome === outcome)?.value ?? 0;
}

function providerReturning(metrics: unknown): WebhookMetricsProvider {
  return {
    getMetrics: () => metrics as ReturnType<WebhookMetricsProvider['getMetrics']>,
  };
}

describe('businessMetrics input helpers', () => {
  describe('isValidDeliveryOutcome', () => {
    it.each(['success', 'failed'])('accepts the known outcome %s', (outcome) => {
      expect(isValidDeliveryOutcome(outcome)).toBe(true);
    });

    it('rejects empty, unsupported, non-string, and oversized values', () => {
      expect(isValidDeliveryOutcome('')).toBe(false);
      expect(isValidDeliveryOutcome('unknown')).toBe(false);
      expect(isValidDeliveryOutcome(null as unknown as string)).toBe(false);
      expect(isValidDeliveryOutcome('x'.repeat(10_000))).toBe(false);
    });
  });

  describe('isValidRejectionReason', () => {
    it.each(['per_ip_limit', 'per_key_limit', 'global_limit'])(
      'accepts the known rejection reason %s',
      (reason) => {
        expect(isValidRejectionReason(reason)).toBe(true);
      },
    );

    it('rejects empty, unsupported, non-string, and oversized values', () => {
      expect(isValidRejectionReason('')).toBe(false);
      expect(isValidRejectionReason('unknown')).toBe(false);
      expect(isValidRejectionReason(null as unknown as string)).toBe(false);
      expect(isValidRejectionReason('x'.repeat(10_000))).toBe(false);
    });
  });

  describe('isValidStreamStatus', () => {
    it('accepts known API stream statuses and rejects malformed values', () => {
      expect(isValidStreamStatus('active')).toBe(true);
      expect(isValidStreamStatus('')).toBe(false);
      expect(isValidStreamStatus(null)).toBe(false);
      expect(isValidStreamStatus('x'.repeat(10_000))).toBe(false);
    });
  });

  describe('safeObserveDuration', () => {
    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
      'observes zero instead of the invalid duration %s',
      (duration) => {
        const histogram = new Histogram({
          name: 'test_safe_observe_duration',
          help: 'Test histogram',
          registers: [],
        });
        const observe = vi.spyOn(histogram, 'observe');

        safeObserveDuration(histogram, duration);

        expect(observe).toHaveBeenCalledTimes(1);
        expect(observe).toHaveBeenCalledWith(0);
      },
    );

    it('preserves a valid duration', () => {
      const histogram = new Histogram({
        name: 'test_safe_observe_duration_valid',
        help: 'Test histogram',
        registers: [],
      });
      const observe = vi.spyOn(histogram, 'observe');

      safeObserveDuration(histogram, 1.25);

      expect(observe).toHaveBeenCalledTimes(1);
      expect(observe).toHaveBeenCalledWith(1.25);
    });
  });
});

describe('syncWebhookMetrics', () => {
  beforeEach(() => {
    webhookDlqItemsGauge.set(0);
    webhookOutboxPendingItemsGauge.set(0);
    webhookMetricsSyncTotal.reset();
  });

  it('clears both gauges when the provider is missing or malformed', async () => {
    webhookDlqItemsGauge.set(4);
    webhookOutboxPendingItemsGauge.set(8);

    syncWebhookMetrics();
    syncWebhookMetrics(null);
    syncWebhookMetrics({} as WebhookMetricsProvider);

    expect(await gaugeValue(webhookDlqItemsGauge)).toBe(0);
    expect(await gaugeValue(webhookOutboxPendingItemsGauge)).toBe(0);
    expect(await syncOutcome('provider_unavailable')).toBe(3);
  });

  it.each([null, undefined, 'not metrics'])(
    'clears both gauges when the provider returns an empty or malformed snapshot',
    async (snapshot) => {
      webhookDlqItemsGauge.set(4);
      webhookOutboxPendingItemsGauge.set(8);

      syncWebhookMetrics(providerReturning(snapshot));

      expect(await gaugeValue(webhookDlqItemsGauge)).toBe(0);
      expect(await gaugeValue(webhookOutboxPendingItemsGauge)).toBe(0);
      expect(await syncOutcome('success_empty')).toBe(1);
    },
  );

  it('uses zero for missing values and preserves valid queue depths', async () => {
    syncWebhookMetrics(providerReturning({ dlqItems: 7, outboxItems: 12 }));

    expect(await gaugeValue(webhookDlqItemsGauge)).toBe(7);
    expect(await gaugeValue(webhookOutboxPendingItemsGauge)).toBe(12);
    expect(await syncOutcome('success')).toBe(1);

    syncWebhookMetrics(providerReturning({ dlqItems: 3 }));

    expect(await gaugeValue(webhookDlqItemsGauge)).toBe(3);
    expect(await gaugeValue(webhookOutboxPendingItemsGauge)).toBe(0);
  });

  it('sanitizes malformed, negative, fractional, and oversized queue depths', async () => {
    syncWebhookMetrics(
      providerReturning({
        dlqItems: '7',
        outboxItems: Number.MAX_SAFE_INTEGER + 1,
      }),
    );

    expect(await gaugeValue(webhookDlqItemsGauge)).toBe(0);
    expect(await gaugeValue(webhookOutboxPendingItemsGauge)).toBe(Number.MAX_SAFE_INTEGER);

    syncWebhookMetrics(
      providerReturning({
        dlqItems: -2,
        outboxItems: 4.9,
      }),
    );

    expect(await gaugeValue(webhookDlqItemsGauge)).toBe(0);
    expect(await gaugeValue(webhookOutboxPendingItemsGauge)).toBe(4);
  });

  it('clears both gauges when reading the provider throws', async () => {
    webhookDlqItemsGauge.set(4);
    webhookOutboxPendingItemsGauge.set(8);

    syncWebhookMetrics({
      getMetrics: () => {
        throw new Error('provider failure');
      },
    });

    expect(await gaugeValue(webhookDlqItemsGauge)).toBe(0);
    expect(await gaugeValue(webhookOutboxPendingItemsGauge)).toBe(0);
    expect(await syncOutcome('provider_error')).toBe(1);
  });
});
