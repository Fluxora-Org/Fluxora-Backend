/**
 * WebhookRateLimiter unit and regression tests.
 *
 * Covers:
 *   - Config validation (limit, windowMs)
 *   - Normal sliding-window rate limiting using FakeRedisClient
 *   - Consumer config management (set, resolve, remove)
 *   - Fail-open behavior on Redis failure:
 *       - Returns canAttempt: true
 *       - Increments fluxora_webhook_rate_limiter_fail_open_total Prometheus counter
 *       - Logs via structured logger.error (NOT console.error)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  WebhookRateLimiter,
  webhookRateLimiterFailOpenTotal,
  createWebhookRateLimiter,
  RateLimitConfigError,
  validateRateLimitConfig,
} from '../../src/redis/webhookRateLimit.js';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import { logger } from '../../src/lib/logger.js';

const consumerUrl = 'https://consumer.example/webhook';
const defaultConfig = { limit: 5, windowMs: 1000 };

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

describe('WebhookRateLimiter', () => {
  let redis: FakeRedisClient;
  let limiter: WebhookRateLimiter;

  beforeEach(() => {
    redis = new FakeRedisClient();
    limiter = createWebhookRateLimiter(redis);
    webhookRateLimiterFailOpenTotal.reset();
  });

  afterEach(() => {
    redis.reset();
    vi.restoreAllMocks();
  });

  describe('Config validation', () => {
    it('throws RateLimitConfigError on invalid limit', () => {
      expect(() => validateRateLimitConfig({ limit: 0, windowMs: 1000 })).toThrow(
        RateLimitConfigError,
      );
      expect(() => validateRateLimitConfig({ limit: -5, windowMs: 1000 })).toThrow(
        RateLimitConfigError,
      );
      expect(() => validateRateLimitConfig({ limit: 200_000, windowMs: 1000 })).toThrow(
        RateLimitConfigError,
      );
    });

    it('throws RateLimitConfigError on invalid windowMs', () => {
      expect(() => validateRateLimitConfig({ limit: 10, windowMs: 50 })).toThrow(
        RateLimitConfigError,
      );
      expect(() => validateRateLimitConfig({ limit: 10, windowMs: 10_000_000 })).toThrow(
        RateLimitConfigError,
      );
    });

    it('validates config successfully for valid inputs', () => {
      expect(() => validateRateLimitConfig({ limit: 100, windowMs: 5000 })).not.toThrow();
    });
  });

  describe('Consumer config management', () => {
    it('allows setting, resolving, and removing custom consumer configs', () => {
      const customConfig = { limit: 20, windowMs: 2000 };
      limiter.setConsumerConfig(consumerUrl, customConfig);

      expect(limiter.resolveConfig(consumerUrl, defaultConfig)).toEqual(customConfig);

      limiter.removeConsumerConfig(consumerUrl);
      expect(limiter.resolveConfig(consumerUrl, defaultConfig)).toEqual(defaultConfig);
    });
  });

  describe('Sliding-window rate limiting under normal operation', () => {
    it('allows attempts up to the configured limit', async () => {
      for (let i = 0; i < 5; i++) {
        const result = await limiter.checkLimit(consumerUrl, defaultConfig);
        expect(result.canAttempt).toBe(true);
        expect(result.retryAfterMs).toBeNull();
      }
    });

    it('rejects attempt when limit is exceeded', async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.checkLimit(consumerUrl, defaultConfig);
      }

      const rejected = await limiter.checkLimit(consumerUrl, defaultConfig);
      expect(rejected.canAttempt).toBe(false);
      expect(rejected.retryAfterMs).toBe(defaultConfig.windowMs);
    });

    it('recordFailure is a no-op promise', async () => {
      await expect(limiter.recordFailure(consumerUrl, defaultConfig)).resolves.toBeUndefined();
    });
  });

  describe('Fail-open behavior on Redis failure', () => {
    it('fails open, logs via structured logger, and increments counter on exec failure', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

      // Simulate a pipeline exec failure
      redis.throwOnNext('exec', 'Redis cluster unreachable');

      const result = await limiter.checkLimit(consumerUrl, defaultConfig);

      // Must fail open
      expect(result.canAttempt).toBe(true);
      expect(result.retryAfterMs).toBeNull();

      // Must NOT use console.error
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      // Must use structured logger.error
      const expectedHash = hashUrl(consumerUrl);
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'WebhookRateLimiter Redis error — failing open',
        undefined,
        expect.objectContaining({
          operation: 'checkLimit',
          consumerKey: expectedHash,
          error: 'Redis cluster unreachable',
        }),
      );

      // Must increment Prometheus fail-open counter
      const metricVal = await webhookRateLimiterFailOpenTotal.get();
      const match = metricVal.values.find((v) => v.labels.consumer_hash === expectedHash);
      expect(match).toBeDefined();
      expect(match?.value).toBe(1);
    });

    it('fails open, logs via structured logger, and increments counter on zcount failure', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

      // Simulate a zcount failure
      redis.throwOnNext('zcount', 'Redis connection timeout');

      const result = await limiter.checkLimit(consumerUrl, defaultConfig);

      expect(result.canAttempt).toBe(true);
      expect(result.retryAfterMs).toBeNull();

      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);

      const expectedHash = hashUrl(consumerUrl);
      const metricVal = await webhookRateLimiterFailOpenTotal.get();
      const match = metricVal.values.find((v) => v.labels.consumer_hash === expectedHash);
      expect(match).toBeDefined();
      expect(match?.value).toBe(1);
    });
  });
});
