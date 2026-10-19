/**
 * Tests for the requestProtectionMetrics module.
 *
 * The module exposes prom-client collectors and a single mutation function,
 * `updateWebhookBucketFill`. The acceptance criteria require that malformed,
 * empty and oversized inputs are rejected with a typed error before any state
 * is written, and that the caller can tell why the input was rejected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registry } from '../metrics.js';
import {
  updateWebhookBucketFill,
  webhookRateLimiterBucketFill,
} from './requestProtectionMetrics.js';

const GAUGE_NAME = 'fluxora_webhook_rate_limiter_bucket_fill';

async function readGaugeValue(consumerHash: string): Promise<number | undefined> {
  const metrics = await registry.getMetricsAsJSON();
  const gauge = metrics.find((m) => m.name === GAUGE_NAME);
  if (!gauge) return undefined;
  const sample = gauge.values.find((v) => v.labels.consumer_hash === consumerHash);
  return sample?.value;
}

describe('requestProtectionMetrics', () => {
  describe('updateWebhookBucketFill', () => {
    it('rejects an empty consumer hash with a typed error', () => {
      assert.throws(
        () => updateWebhookBucketFill('', 1),
        (err) => {
          assert.ok(err instanceof Error);
          assert.strictEqual((err as Error).name, 'InvalidMetricInputError');
          assert.match((err as Error).message, /consumerHash/);
          return true;
        },
      );
    });

    it('rejects a whitespace-only consumer hash', () => {
      assert.throws(
        () => updateWebhookBucketFill('   ', 1),
        (err) => {
          assert.ok(err instanceof Error);
          assert.strictEqual((err as Error).name, 'InvalidMetricInputError');
          return true;
        },
      );
    });

    it('rejects a non-string consumer hash', () => {
      assert.throws(
        // @ts-expect-error -- deliberately passing the wrong type.
        () => updateWebhookBucketFill(123 as unknown as string, 1),
        (err) => {
          assert.ok(err instanceof Error);
          assert.strictEqual((err as Error).name, 'InvalidMetricInputError');
          return true;
        },
      );
    });

    it('rejects an oversized consumer hash', () => {
      const huge = 'a'.repeat(1024);
      assert.throws(
        () => updateWebhookBucketFill(huge, 1),
        (err) => {
          assert.ok(err instanceof Error);
          assert.strictEqual((err as Error).name, 'InvalidMetricInputError');
          assert.match((err as Error).message, /consumerHash/);
          return true;
        },
      );
    });

    it('rejects a non-finite fill level', () => {
      for (const bad of [NaN, Infinity, -Infinity]) {
        assert.throws(
          () => updateWebhookBucketFill('abcdef0123456789', bad),
          (err) => {
            assert.ok(err instanceof Error);
            assert.strictEqual((err as Error).name, 'InvalidMetricInputError');
            assert.match((err as Error).message, /fillLevel/);
            return true;
          },
        );
      }
    });

    it('rejects a negative fill level', () => {
      assert.throws(
        () => updateWebhookBucketFill('abcdef0123456789', -1),
        (err) => {
          assert.ok(err instanceof Error);
          assert.strictEqual((err as Error).name, 'InvalidMetricInputError');
          return true;
        },
      );
    });

    it('rejects a non-numeric fill level', () => {
      assert.throws(
        // @ts-expect-error -- deliberately passing the wrong type.
        () => updateWebhookBucketFill('abcdef0123456789', '1' as unknown as number),
        (err) => {
          assert.ok(err instanceof Error);
          assert.strictEqual((err as Error).name, 'InvalidMetricInputError');
          return true;
        },
      );
    });

    it('does not write state when the input is rejected', async () => {
      const hash = 'deadbeef01234567';
      assert.throws(() => updateWebhookBucketFill(hash, NaN));
      const value = registry.getSingleMetric(GAUGE_NAME);
      // The gauge may not have a sample for this label at all; if it does,
      // it must not reflect the rejected write.
      if (value) {
        const snapshot = await (
          value as unknown as {
            get: () => Promise<{
              values: Array<{ labels: Record<string, string>; value: number }>;
            }>;
          }
        ).get();
        const sample = snapshot.values.find((v) => v.labels.consumer_hash === hash);
        assert.strictEqual(sample, undefined);
      }
    });

    it('accepts a valid consumer hash and fill level', async () => {
      const hash = '0123456789abcdef';
      updateWebhookBucketFill(hash, 42);
      const metric = registry.getSingleMetric(GAUGE_NAME);
      assert.ok(metric);
      const snapshot = await (
        metric as unknown as {
          get: () => Promise<{
            values: Array<{ labels: Record<string, string>; value: number }>;
          }>;
        }
      ).get();
      const sample = snapshot.values.find((v) => v.labels.consumer_hash === hash);
      assert.ok(sample);
      assert.strictEqual(sample.value, 42);
    });

    it('accepts a fractional fill level', async () => {
      const hash = 'fedcba987654321';
      updateWebhookBucketFill(hash, 0.5);
      const metric = registry.getSingleMetric(GAUGE_NAME);
      assert.ok(metric);
      const snapshot = await (
        metric as unknown as {
          get: () => Promise<{
            values: Array<{ labels: Record<string, string>; value: number }>;
          }>;
        }
      ).get();
      const sample = snapshot.values.find((v) => v.labels.consumer_hash === hash);
      assert.ok(sample);
      assert.strictEqual(sample.value, 0.5);
    });
  });
});
