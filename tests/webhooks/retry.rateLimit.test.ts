import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SlidingWindowStore, InMemoryStore } from '../../src/redis/rateLimitStore.js';
import type { RateLimitStore } from '../../src/types/rateLimit.js';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import { RedisWebhookCircuitBreakerStore } from '../../src/redis/webhookCircuitBreakerStore.js';
import {
  checkWebhookDeliveryGate,
  attemptWebhookDeliveryWithRateLimit,
  type EnhancedRetryPolicy,
} from '../../src/webhooks/retry.js';
import { WebhookRateLimiter } from '../../src/redis/webhookRateLimit.js';

const mockRedisClient = {
  multi: vi.fn().mockReturnThis(),
  zadd: vi.fn(),
  zremrangebyscore: vi.fn(),
  zcard: vi.fn(),
  pexpire: vi.fn(),
  exec: vi.fn(),
  close: vi.fn().mockResolvedValue(null),
  get: vi.fn(),
  set: vi.fn(),
  setNx: vi.fn(),
  del: vi.fn(),
  exists: vi.fn(),
  zcount: vi.fn(),
};

describe('Webhook Retry Rate Limiting (RateLimitStore & Retry Logic)', () => {
  let primaryStore: RateLimitStore;
  let fallbackStore: RateLimitStore;
  let mockRateLimitStore: RateLimitStore;

  beforeEach(() => {
    mockRedisClient.multi.mockClear();
    mockRedisClient.zadd.mockClear();
    mockRedisClient.zremrangebyscore.mockClear();
    mockRedisClient.zcard.mockClear();
    mockRedisClient.pexpire.mockClear();
    mockRedisClient.exec.mockClear();
    mockRedisClient.multi.mockReturnThis();
    mockRedisClient.zadd.mockReturnThis();
    mockRedisClient.zremrangebyscore.mockReturnThis();
    mockRedisClient.zcard.mockReturnThis();
    mockRedisClient.pexpire.mockReturnThis();
    mockRedisClient.exec.mockResolvedValue([null, 'member', [1, 1]]);

    primaryStore = new SlidingWindowStore(mockRedisClient);
    fallbackStore = new InMemoryStore();

    mockRateLimitStore = {
      async increment(key: string, windowMs: number, limit: number) {
        return primaryStore.increment(key, windowMs, limit);
      },
      async getCount(key: string, windowMs: number) {
        return primaryStore.getCount(key, windowMs);
      },
      async close() {
        await primaryStore.close();
        await fallbackStore.close();
      },
    };
  });

  afterEach(async () => {
    await mockRateLimitStore.close();
  });

  it('should successfully increment and report correct count under normal operation', async () => {
    const limitKey = 'consumer-abc';
    const windowMs = 60000;
    (mockRedisClient.exec as ReturnType<typeof vi.fn>).mockResolvedValue([null, 'member', [5, 5]]);

    const result = await mockRateLimitStore.increment(limitKey, windowMs, 10);

    expect(mockRedisClient.zadd).toHaveBeenCalledTimes(1);
    expect(result.count).toBe(5);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it('defers attempts when circuit breaker and rate limit both apply', async () => {
    const redis = new FakeRedisClient();
    const breaker = new RedisWebhookCircuitBreakerStore(redis);
    const rateLimiter = new WebhookRateLimiter(redis);
    const policy: EnhancedRetryPolicy = {
      maxAttempts: 5,
      initialBackoffMs: 1000,
      backoffMultiplier: 2,
      maxBackoffMs: 1000,
      jitterPercent: 0,
      timeoutMs: 5000,
      retryableStatusCodes: [500],
      circuitBreakerThreshold: 1,
      circuitBreakerResetMs: 60_000,
    };
    const consumerUrl = 'https://example.com/webhook';

    await breaker.recordFailure(consumerUrl, policy, Date.now());
    const gate = await checkWebhookDeliveryGate(consumerUrl, policy, {
      circuitBreakerStore: breaker,
      rateLimiter,
      rateLimitConfig: { limit: 10, windowMs: 1000 },
    });

    expect(gate.canDeliver).toBe(false);
    expect(gate.circuitBreakerOpen).toBe(true);

    const deliver = vi.fn();
    const result = await attemptWebhookDeliveryWithRateLimit(
      {
        consumerUrl,
        streamId: 's1',
        eventType: 'stream.created',
        payload: {},
        attemptNumber: 1,
        policy,
      },
      deliver,
      { circuitBreakerStore: breaker, rateLimiter, rateLimitConfig: { limit: 10, windowMs: 1000 } },
    );

    expect(deliver).not.toHaveBeenCalled();
    expect(result.shouldRetry).toBe(true);
    await breaker.close();
    redis.reset();
  });
});
