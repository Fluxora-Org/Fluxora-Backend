import { beforeEach, describe, expect, it } from 'vitest';
import { registry } from '../../src/metrics.js';
import {
  authApiKeyLookupDurationSeconds,
  authJwtVerifyDurationSeconds,
  recordApiKeyLookupDuration,
  recordJwtVerifyDuration,
} from '../../src/metrics/businessMetrics.js';

beforeEach(() => {
  authJwtVerifyDurationSeconds.reset();
  authApiKeyLookupDurationSeconds.reset();
});

describe('auth latency metrics', () => {
  it('registers bounded histograms with outcome-only application labels', () => {
    const jwtMetric = registry.getSingleMetric('fluxora_auth_jwt_verify_duration_seconds');
    const apiKeyMetric = registry.getSingleMetric('fluxora_auth_apikey_lookup_duration_seconds');

    expect(jwtMetric).toBe(authJwtVerifyDurationSeconds);
    expect(apiKeyMetric).toBe(authApiKeyLookupDurationSeconds);
    // @ts-expect-error prom-client exposes labelNames on the metric instance.
    expect(jwtMetric?.labelNames).toEqual(['outcome']);
    // @ts-expect-error prom-client exposes labelNames on the metric instance.
    expect(apiKeyMetric?.labelNames).toEqual(['outcome']);
  });

  it('records JWT verification success and failure observations', async () => {
    recordJwtVerifyDuration(0.004, 'success');
    recordJwtVerifyDuration(0.012, 'failure');

    const value = await authJwtVerifyDurationSeconds.get();
    const successCount = value.values.find(
      (metric) =>
        metric.metricName === 'fluxora_auth_jwt_verify_duration_seconds_count' &&
        metric.labels.outcome === 'success',
    );
    const failureCount = value.values.find(
      (metric) =>
        metric.metricName === 'fluxora_auth_jwt_verify_duration_seconds_count' &&
        metric.labels.outcome === 'failure',
    );

    expect(successCount?.value).toBe(1);
    expect(failureCount?.value).toBe(1);
  });

  it('records API-key lookup success and failure observations', async () => {
    recordApiKeyLookupDuration(0.003, 'success');
    recordApiKeyLookupDuration(0.009, 'failure');

    const value = await authApiKeyLookupDurationSeconds.get();
    const successCount = value.values.find(
      (metric) =>
        metric.metricName === 'fluxora_auth_apikey_lookup_duration_seconds_count' &&
        metric.labels.outcome === 'success',
    );
    const failureCount = value.values.find(
      (metric) =>
        metric.metricName === 'fluxora_auth_apikey_lookup_duration_seconds_count' &&
        metric.labels.outcome === 'failure',
    );

    expect(successCount?.value).toBe(1);
    expect(failureCount?.value).toBe(1);
  });
});