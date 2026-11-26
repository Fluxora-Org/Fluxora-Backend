/**
 * Tests for the requestProtectionMetrics module.
 *
 * The module exposes prom-client collectors and a single mutation function,
 * `updateWebhookBucketFill`. The acceptance criteria require that malformed,
 * empty and oversized inputs are rejected with a typed error before any state
 * is written, and that the caller can tell why the input was rejected.
 */

import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  updateWebhookBucketFill,
  webhookRateLimiterBucketFill,
} from './requestProtectionMetrics.js';

vi.mock('../metrics.js', async () => {
  const { Registry } = await import('prom-client');
  return { registry: new Registry() };
});

async function readGaugeValue(consumerHash: string): Promise<number | undefined> {
  const gauge = await webhookRateLimiterBucketFill.get();
  return gauge.values.find((sample) => sample.labels.consumer_hash === consumerHash)?.value;
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
      assert.strictEqual(await readGaugeValue(hash), undefined);
    });

    it('accepts a valid consumer hash and fill level', async () => {
      const hash = '0123456789abcdef';
      updateWebhookBucketFill(hash, 42);
      assert.strictEqual(await readGaugeValue(hash), 42);
    });

    it('accepts a fractional fill level', async () => {
      const hash = 'fedcba987654321';
      updateWebhookBucketFill(hash, 0.5);
      assert.strictEqual(await readGaugeValue(hash), 0.5);
    });
  });
});
