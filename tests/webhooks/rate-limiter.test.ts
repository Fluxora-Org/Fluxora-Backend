import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TokenBucketRateLimiter } from '../../src/webhooks/rate-limiter.js';
import {
  webhookRateLimiterBucketFill,
  deRegisterRequestProtectionMetrics,
} from '../../src/metrics/requestProtectionMetrics.js';
import { validateRateLimitConfig, RateLimitConfigError } from '../../src/redis/webhookRateLimit.js';

const dimensions = { tenant: 't1', endpoint: 'https://consumer.example/webhook', outcome: 'first_attempt' };

describe('TokenBucketRateLimiter', () => {
  let limiter: TokenBucketRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new TokenBucketRateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
    limiter.dispose();
    deRegisterRequestProtectionMetrics();
  });

  describe('burst > 0', () => {
    const config = { limit: 5, windowMs: 1000, burst: 10 };

    it('allows up to burst requests in immediate succession', async () => {
      for (let i = 0; i < 10; i++) {
        const result = await limiter.checkLimit(dimensions, config);
        expect(result.canAttempt).toBe(true);
        expect(result.retryAfterMs).toBeNull();
      }
    });

    it('rejects the (burst + 1)th request', async () => {
      for (let i = 0; i < 10; i++) {
        await limiter.checkLimit(dimensions, config);
      }
      const rejected = await limiter.checkLimit(dimensions, config);
      expect(rejected.canAttempt).toBe(false);
      expect(rejected.retryAfterMs).toBeGreaterThan(0);
    });

    it('refills tokens over time after burst exhaustion', async () => {
      for (let i = 0; i < 10; i++) {
        await limiter.checkLimit(dimensions, config);
      }
      vi.advanceTimersByTime(200);
      const allowed = await limiter.checkLimit(dimensions, config);
      expect(allowed.canAttempt).toBe(true);
    });

    it('returns a nonzero retryAfterMs that allows scheduling a deferral', async () => {
      for (let i = 0; i < 10; i++) {
        await limiter.checkLimit(dimensions, config);
      }
      const rejected = await limiter.checkLimit(dimensions, config);
      expect(rejected.canAttempt).toBe(false);
      expect(rejected.retryAfterMs).toBeGreaterThanOrEqual(1);
    });

    it('getBucketLevel reflects the consumed burst', async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.checkLimit(dimensions, config);
      }
      const level = limiter.getBucketLevel(dimensions);
      expect(level).toBeCloseTo(5.0, 0);
    });

    it('steady-state rate matches limit over a full window', async () => {
      for (let i = 0; i < 10; i++) {
        await limiter.checkLimit(dimensions, config);
      }
      vi.advanceTimersByTime(1000);
      const level = limiter.getBucketLevel(dimensions, config);
      expect(level).toBeCloseTo(5.0, 0);
    });

    it('drains to steady-state rate under sustained load above the limit', async () => {
      for (let i = 0; i < 10; i++) {
        await limiter.checkLimit(dimensions, config);
      }
      let allowedCount = 0;
      for (let i = 0; i < 40; i++) {
        vi.advanceTimersByTime(150);
        const result = await limiter.checkLimit(dimensions, config);
        if (result.canAttempt) allowedCount++;
      }
      const totalTimeMs = 40 * 150;
      const maxSteadyAllowed = Math.floor(totalTimeMs * (config.limit / config.windowMs));
      expect(allowedCount).toBeLessThanOrEqual(maxSteadyAllowed + config.burst);
      expect(allowedCount).toBeGreaterThan(0);
    });
  });

  describe('burst = 0 (backward compatibility)', () => {
    const config = { limit: 5, windowMs: 1000, burst: 0 };

    it('allows up to limit requests immediately', async () => {
      for (let i = 0; i < 5; i++) {
        const result = await limiter.checkLimit(dimensions, config);
        expect(result.canAttempt).toBe(true);
      }
    });

    it('rejects the (limit + 1)th request', async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.checkLimit(dimensions, config);
      }
      const rejected = await limiter.checkLimit(dimensions, config);
      expect(rejected.canAttempt).toBe(false);
      expect(rejected.retryAfterMs).toBeGreaterThan(0);
    });

    it('refills tokens over time', async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.checkLimit(dimensions, config);
      }
      vi.advanceTimersByTime(200);
      const allowed = await limiter.checkLimit(dimensions, config);
      expect(allowed.canAttempt).toBe(true);
    });
  });

  describe('recordFailure', () => {
    it('is a no-op that resolves to undefined', async () => {
      const config = { limit: 5, windowMs: 1000, burst: 0 };
      await expect(limiter.recordFailure(dimensions, config)).resolves.toBeUndefined();
    });
  });

  describe('multiple consumers', () => {
    const config = { limit: 5, windowMs: 1000, burst: 3 };

    it('maintains independent buckets per consumer URL', async () => {
      const dimA = { tenant: 't1', endpoint: 'urlA', outcome: 'first_attempt' };
      const dimB = { tenant: 't2', endpoint: 'urlB', outcome: 'first_attempt' };

      for (let i = 0; i < 3; i++) {
        await limiter.checkLimit(dimA, config);
      }
      const resultA = await limiter.checkLimit(dimA, config);
      expect(resultA.canAttempt).toBe(false);

      const resultB = await limiter.checkLimit(dimB, config);
      expect(resultB.canAttempt).toBe(true);
    });
  });

  describe('config validation', () => {
    it('validates rate limit config including burst', () => {
      expect(() => validateRateLimitConfig({ limit: 10, windowMs: 1000, burst: 5 })).not.toThrow();
      expect(() => validateRateLimitConfig({ limit: 10, windowMs: 1000, burst: 0 })).not.toThrow();
    });

    it('rejects negative burst', () => {
      expect(() =>
        validateRateLimitConfig({ limit: 10, windowMs: 1000, burst: -1 }),
      ).toThrow(RateLimitConfigError);
    });
  });

  describe('partial refill', () => {
    const config = { limit: 10, windowMs: 1000, burst: 5 };

    it('accumulates fractional tokens over a partial window', async () => {
      await limiter.checkLimit(dimensions, config);
      const afterBurst = limiter.getBucketLevel(dimensions, config);
      expect(afterBurst).toBeCloseTo(4.0, 0);

      vi.advanceTimersByTime(100);
      const level = limiter.getBucketLevel(dimensions, config);
      expect(level).toBeCloseTo(5.0, 0);
    });
  });

  describe('metric integration', () => {
    const config = { limit: 5, windowMs: 1000, burst: 10 };

    it('updates the bucket fill gauge on each checkLimit call', async () => {
      await limiter.checkLimit(dimensions, config);
      const snapshot = await webhookRateLimiterBucketFill.get();
      expect(snapshot.values.length).toBeGreaterThan(0);
    });
  });
});

