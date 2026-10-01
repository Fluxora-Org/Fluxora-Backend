import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWebhookRateLimiter,
  hashDimensions,
} from '../../src/redis/webhookRateLimit.js';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';

const BASE = 1_700_000_000_000;
const WINDOW_MS = 1_000;
const config = { limit: 1, windowMs: WINDOW_MS, burst: 0 };
const receiverA = {
  tenant: 'tenant-a',
  endpoint: 'https://receiver-a.example/hooks',
  outcome: 'first_attempt',
};

describe('WebhookRateLimiter receiver-scoped sliding window', () => {
  let redis: FakeRedisClient;
  let limiter: ReturnType<typeof createWebhookRateLimiter>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    redis = new FakeRedisClient();
    limiter = createWebhookRateLimiter(redis);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires an attempt at the exact window boundary and bounds the Redis key TTL', async () => {
    const key = `webhook_rl:${hashDimensions(receiverA)}`;

    await expect(limiter.checkLimit(receiverA, config)).resolves.toMatchObject({
      canAttempt: true,
      retryAfterMs: null,
    });
    expect(redis.getTtl(key)).toBe(WINDOW_MS);

    vi.setSystemTime(BASE + WINDOW_MS - 1);
    await expect(limiter.checkLimit(receiverA, config)).resolves.toMatchObject({
      canAttempt: false,
    });

    vi.setSystemTime(BASE + WINDOW_MS);
    await expect(limiter.checkLimit(receiverA, config)).resolves.toMatchObject({
      canAttempt: true,
      retryAfterMs: null,
    });
    expect(redis.getTtl(key)).toBe(WINDOW_MS);
  });

  it('keeps receiver budgets independent while sharing one receiver across tenant and outcome', async () => {
    await limiter.checkLimit(receiverA, config);

    const sameReceiverDifferentTenantAndOutcome = {
      ...receiverA,
      tenant: 'tenant-b',
      outcome: 'retry',
    };
    await expect(
      limiter.checkLimit(sameReceiverDifferentTenantAndOutcome, config),
    ).resolves.toMatchObject({ canAttempt: false });

    const receiverB = {
      ...receiverA,
      endpoint: 'https://receiver-b.example/hooks',
    };
    await expect(limiter.checkLimit(receiverB, config)).resolves.toMatchObject({
      canAttempt: true,
      retryAfterMs: null,
    });
  });

  it('fails open when Redis is unavailable', async () => {
    redis.throwOnNext('exec');

    await expect(limiter.checkLimit(receiverA, config)).resolves.toMatchObject({
      canAttempt: true,
      retryAfterMs: null,
    });
  });
});