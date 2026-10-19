import { describe, it, expect, beforeEach } from 'vitest';
import {
  requestRefusedTotal,
  requestBodyTooLargeTotal,
  requestBodyTooDeepTotal,
  webhookRateLimiterBucketFill,
  updateWebhookBucketFill,
  deRegisterRequestProtectionMetrics,
} from '../../../src/metrics/requestProtectionMetrics.js';
import { registry } from '../../../src/metrics.js';

async function sampleFor(
  metric: { get(): Promise<{ values: Array<{ value: number; labels: Record<string, unknown> }> }> },
  labels: Record<string, unknown>,
): Promise<number | undefined> {
  const { values } = await metric.get();
  return values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value;
}

describe('requestRefusedTotal', () => {
  beforeEach(() => {
    requestRefusedTotal.reset();
  });

  it('increments independently per (path, reason) label combination', async () => {
    requestRefusedTotal.inc({ path: '/api/streams', reason: 'body_too_large' });
    requestRefusedTotal.inc({ path: '/api/streams', reason: 'body_too_large' });
    requestRefusedTotal.inc({ path: '/api/streams', reason: 'json_depth_exceeded' });
    requestRefusedTotal.inc({ path: '/api/webhooks', reason: 'rate_limit_exceeded' });

    expect(await sampleFor(requestRefusedTotal, { path: '/api/streams', reason: 'body_too_large' })).toBe(2);
    expect(await sampleFor(requestRefusedTotal, { path: '/api/streams', reason: 'json_depth_exceeded' })).toBe(1);
    expect(await sampleFor(requestRefusedTotal, { path: '/api/webhooks', reason: 'rate_limit_exceeded' })).toBe(1);
  });

  it('starts a fresh label combination at zero observations (no series until first inc)', async () => {
    expect(await sampleFor(requestRefusedTotal, { path: '/unused', reason: 'body_too_large' })).toBeUndefined();
  });
});

describe('deprecated per-reason counters', () => {
  beforeEach(() => {
    requestBodyTooLargeTotal.reset();
    requestBodyTooDeepTotal.reset();
  });

  it('requestBodyTooLargeTotal increments by path', async () => {
    requestBodyTooLargeTotal.inc({ path: '/api/streams' });
    expect(await sampleFor(requestBodyTooLargeTotal, { path: '/api/streams' })).toBe(1);
  });

  it('requestBodyTooDeepTotal increments by path', async () => {
    requestBodyTooDeepTotal.inc({ path: '/api/streams' });
    expect(await sampleFor(requestBodyTooDeepTotal, { path: '/api/streams' })).toBe(1);
  });
});

describe('updateWebhookBucketFill', () => {
  beforeEach(() => {
    webhookRateLimiterBucketFill.reset();
  });

  it('sets the gauge to the given fill level for a consumer', async () => {
    updateWebhookBucketFill('abc123', 7.5);
    expect(await sampleFor(webhookRateLimiterBucketFill, { consumer_hash: 'abc123' })).toBe(7.5);
  });

  it('accepts a zero fill level (bucket fully drained)', async () => {
    updateWebhookBucketFill('abc123', 0);
    expect(await sampleFor(webhookRateLimiterBucketFill, { consumer_hash: 'abc123' })).toBe(0);
  });

  it('tracks each consumer independently', async () => {
    updateWebhookBucketFill('consumer-a', 3);
    updateWebhookBucketFill('consumer-b', 9);

    expect(await sampleFor(webhookRateLimiterBucketFill, { consumer_hash: 'consumer-a' })).toBe(3);
    expect(await sampleFor(webhookRateLimiterBucketFill, { consumer_hash: 'consumer-b' })).toBe(9);
  });

  it('overwrites a previous reading for the same consumer rather than accumulating', async () => {
    updateWebhookBucketFill('consumer-a', 3);
    updateWebhookBucketFill('consumer-a', 10);

    expect(await sampleFor(webhookRateLimiterBucketFill, { consumer_hash: 'consumer-a' })).toBe(10);
  });
});

describe('deRegisterRequestProtectionMetrics', () => {
  it('removes all four request-protection metrics from the registry', () => {
    expect(registry.getSingleMetric('fluxora_request_refused_total')).toBeDefined();
    expect(registry.getSingleMetric('fluxora_request_body_too_large_total')).toBeDefined();
    expect(registry.getSingleMetric('fluxora_request_body_too_deep_total')).toBeDefined();
    expect(registry.getSingleMetric('fluxora_webhook_rate_limiter_bucket_fill')).toBeDefined();

    deRegisterRequestProtectionMetrics();

    expect(registry.getSingleMetric('fluxora_request_refused_total')).toBeUndefined();
    expect(registry.getSingleMetric('fluxora_request_body_too_large_total')).toBeUndefined();
    expect(registry.getSingleMetric('fluxora_request_body_too_deep_total')).toBeUndefined();
    expect(registry.getSingleMetric('fluxora_webhook_rate_limiter_bucket_fill')).toBeUndefined();
  });
});
