/**
 * tests/webhooks/retry.rateLimit.test.ts
 *
 * Integration tests for the per-consumer-URL sliding-window rate limiter
 * wired into `attemptWebhookDeliveryWithRateLimit`.
 *
 * All tests use FakeRedisClient — no real Redis required.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import { WebhookRateLimiter } from '../../src/redis/webhookRateLimit.js';
import {
  attemptWebhookDeliveryWithRateLimit,
  scheduleWebhookOutboxRetry,
  type WebhookOutboxRetryInput,
} from '../../src/webhooks/retry.js';
import type { RateLimitConfig } from '../../src/redis/webhookRateLimit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<WebhookOutboxRetryInput> = {}): WebhookOutboxRetryInput {
  return {
    consumerUrl: 'https://consumer.example.com/webhook',
    streamId: 'stream-1',
    eventType: 'stream.created',
    payload: { data: 'test' },
    attemptNumber: 0,
    now: 1_000_000,
    ...overrides,
  };
}

const TIGHT_CONFIG: RateLimitConfig = { limit: 3, windowMs: 10_000 };

// ---------------------------------------------------------------------------
// WebhookRateLimiter unit tests
// ---------------------------------------------------------------------------

describe('WebhookRateLimiter', () => {
  let redis: FakeRedisClient;
  let limiter: WebhookRateLimiter;

  beforeEach(() => {
    redis = new FakeRedisClient();
    limiter = new WebhookRateLimiter(redis);
  });

  it('allows the first attempt when no prior attempts exist', async () => {
    const result = await limiter.checkLimit('https://a.example.com', TIGHT_CONFIG);
    expect(result.canAttempt).toBe(true);
    expect(result.retryAfterMs).toBeNull();
  });

  it('allows attempts up to the limit', async () => {
    const url = 'https://b.example.com';
    for (let i = 0; i < TIGHT_CONFIG.limit; i++) {
      const r = await limiter.checkLimit(url, TIGHT_CONFIG);
      expect(r.canAttempt).toBe(true);
    }
  });

  it('denies the attempt that exceeds the limit', async () => {
    const url = 'https://c.example.com';
    for (let i = 0; i < TIGHT_CONFIG.limit; i++) {
      await limiter.checkLimit(url, TIGHT_CONFIG);
    }
    const result = await limiter.checkLimit(url, TIGHT_CONFIG);
    expect(result.canAttempt).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('returns retryAfterMs equal to windowMs when denied', async () => {
    const url = 'https://d.example.com';
    for (let i = 0; i < TIGHT_CONFIG.limit; i++) {
      await limiter.checkLimit(url, TIGHT_CONFIG);
    }
    const result = await limiter.checkLimit(url, TIGHT_CONFIG);
    expect(result.retryAfterMs).toBe(TIGHT_CONFIG.windowMs);
  });

  it('isolates rate limits per consumer URL', async () => {
    const urlA = 'https://a.example.com/hook';
    const urlB = 'https://b.example.com/hook';

    // Exhaust urlA
    for (let i = 0; i < TIGHT_CONFIG.limit; i++) {
      await limiter.checkLimit(urlA, TIGHT_CONFIG);
    }
    expect((await limiter.checkLimit(urlA, TIGHT_CONFIG)).canAttempt).toBe(false);

    // urlB should still be allowed
    expect((await limiter.checkLimit(urlB, TIGHT_CONFIG)).canAttempt).toBe(true);
  });

  it('fails open when Redis is unavailable (zcount throws)', async () => {
    redis.throwOnNext('zcount', 'Simulated Redis failure');
    const result = await limiter.checkLimit('https://e.example.com', TIGHT_CONFIG);
    // Fail-open: attempt is allowed so deliveries are not silently dropped.
    expect(result.canAttempt).toBe(true);
  });

  it('fails open when Redis pipeline exec throws', async () => {
    redis.throwOnNext('exec', 'Simulated pipeline failure');
    const result = await limiter.checkLimit('https://f.example.com', TIGHT_CONFIG);
    expect(result.canAttempt).toBe(true);
  });

  it('recordFailure is a no-op and does not throw', async () => {
    await expect(
      limiter.recordFailure('https://g.example.com', TIGHT_CONFIG),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// attemptWebhookDeliveryWithRateLimit integration tests
// ---------------------------------------------------------------------------

describe('attemptWebhookDeliveryWithRateLimit', () => {
  let redis: FakeRedisClient;
  let limiter: WebhookRateLimiter;

  beforeEach(() => {
    redis = new FakeRedisClient();
    limiter = new WebhookRateLimiter(redis);
  });

  it('returns a normal retry plan when under the limit', async () => {
    const input = makeInput({ attemptNumber: 0 });
    const plan = await attemptWebhookDeliveryWithRateLimit(input, limiter, TIGHT_CONFIG);

    expect(plan.shouldRetry).toBe(true);
    expect(plan.rateLimited).toBeFalsy();
    expect(plan.retryAt).toBeInstanceOf(Date);
    expect(plan.attemptNumber).toBe(1);
  });

  it('defers (re-enqueues) when the rate limit is exceeded', async () => {
    const input = makeInput({ attemptNumber: 0 });

    // Exhaust the limit first.
    for (let i = 0; i < TIGHT_CONFIG.limit; i++) {
      await limiter.checkLimit(input.consumerUrl, TIGHT_CONFIG);
    }

    const plan = await attemptWebhookDeliveryWithRateLimit(input, limiter, TIGHT_CONFIG);

    expect(plan.shouldRetry).toBe(true);
    expect(plan.rateLimited).toBe(true);
    // retryAt must be in the future relative to input.now
    expect(plan.retryAt!.getTime()).toBeGreaterThan(input.now!);
  });

  it('deferral retryAt is now + windowMs', async () => {
    const now = 5_000_000;
    const input = makeInput({ now });

    for (let i = 0; i < TIGHT_CONFIG.limit; i++) {
      await limiter.checkLimit(input.consumerUrl, TIGHT_CONFIG);
    }

    const plan = await attemptWebhookDeliveryWithRateLimit(input, limiter, TIGHT_CONFIG);
    expect(plan.retryAt!.getTime()).toBe(now + TIGHT_CONFIG.windowMs);
  });

  it('does not increment attemptNumber on a rate-limited deferral', async () => {
    const input = makeInput({ attemptNumber: 2 });

    for (let i = 0; i < TIGHT_CONFIG.limit; i++) {
      await limiter.checkLimit(input.consumerUrl, TIGHT_CONFIG);
    }

    const plan = await attemptWebhookDeliveryWithRateLimit(input, limiter, TIGHT_CONFIG);
    // Attempt number must stay the same — the attempt did not actually fire.
    expect(plan.attemptNumber).toBe(2);
  });

  it('preserves the original payload on deferral', async () => {
    const payload = { streamId: 'abc', amount: '100.0000000' };
    const input = makeInput({ payload });

    for (let i = 0; i < TIGHT_CONFIG.limit; i++) {
      await limiter.checkLimit(input.consumerUrl, TIGHT_CONFIG);
    }

    const plan = await attemptWebhookDeliveryWithRateLimit(input, limiter, TIGHT_CONFIG);
    expect(plan.payload).toEqual(payload);
  });

  it('proceeds normally when Redis is unavailable (fail-open)', async () => {
    redis.throwOnNext('exec', 'Redis down');
    const input = makeInput({ attemptNumber: 0 });
    const plan = await attemptWebhookDeliveryWithRateLimit(input, limiter, TIGHT_CONFIG);

    // Should not be rate-limited — fail-open means we allow the attempt.
    expect(plan.rateLimited).toBeFalsy();
    expect(plan.shouldRetry).toBe(true);
  });

  it('returns shouldRetry=false when maxAttempts is reached (not rate-limited)', async () => {
    const input = makeInput({ attemptNumber: 5 }); // DEFAULT_RETRY_POLICY.maxAttempts = 5
    const plan = await attemptWebhookDeliveryWithRateLimit(input, limiter, TIGHT_CONFIG);

    expect(plan.shouldRetry).toBe(false);
    expect(plan.rateLimited).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// scheduleWebhookOutboxRetry — verify outbox deferral persistence contract
// ---------------------------------------------------------------------------

describe('scheduleWebhookOutboxRetry', () => {
  it('embeds _webhookRetry metadata in the payload', () => {
    const input = makeInput({ attemptNumber: 1 });
    const plan = scheduleWebhookOutboxRetry(input);

    expect(plan.payload).toMatchObject({
      _webhookRetry: {
        attemptNumber: 2,
        previousAttemptAt: expect.any(String),
      },
    });
  });

  it('retryAt is a future Date', () => {
    const now = 1_000_000;
    const input = makeInput({ attemptNumber: 0, now });
    const plan = scheduleWebhookOutboxRetry(input);

    expect(plan.retryAt).toBeInstanceOf(Date);
    expect(plan.retryAt!.getTime()).toBeGreaterThan(now);
  });

  it('returns shouldRetry=false after maxAttempts', () => {
    const input = makeInput({ attemptNumber: 5 });
    const plan = scheduleWebhookOutboxRetry(input);
    expect(plan.shouldRetry).toBe(false);
    expect(plan.retryAt).toBeNull();
  });
});
