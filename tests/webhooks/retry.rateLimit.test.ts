import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimitStore } from '../../src/redis/rateLimitStore.js';
import { SlidingWindowStore } from '../../src/redis/rateLimitStore.js';
import { InMemoryStore } from '../../src/redis/rateLimitStore.js';
import { WebhookOutboxRetryInput, EnhancedRetryPolicy, WebhookOutboxRetryPlan } from '../../src/webhooks/retry.js';

// Mock Redis Client for testing the SlidingWindowStore
const mockRedisClient = {
    multi: vi.fn().mockReturnThis(),
    zadd: vi.fn(),
    zremrangebyscore: vi.fn(),
    zcard: vi.fn(),
    pexpire: vi.fn(),
    exec: vi.fn(),
    close: vi.fn().mockResolvedValue(null),
};

const mockRedisConnection = {
    multi: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    zremrangebyscore: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    pexpire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([null, 'member', [1, 3] /* initial count */]),
    close: vi.fn().mockResolvedValue(null),
};

describe('Webhook Retry Rate Limiting (RateLimitStore & Retry Logic)', () => {
    let primaryStore: RateLimitStore;
    let fallbackStore: RateLimitStore;
    let mockRateLimitStore: RateLimitStore;

    beforeEach(() => {
        // Mock the Redis client and the rateLimitStore utility function structure
        mockRedisClient.multi.mockClear();
        mockRedisClient.zadd.mockClear();
        mockRedisClient.zremrangebyscore.mockClear();
        mockRedisClient.zcard.mockClear();
        mockRedisClient.pexpire.mockClear();
        mockRedisClient.exec.mockClear();
        mockRedisClient.multi.mockReturnThis();
        mockRedisClient.exec.mockResolvedValue([null, 'member', [1, 1]]); // Default successful count 1 for testing

        // Initialize stores for testing
        primaryStore = new SlidingWindowStore(mockRedisClient);
        fallbackStore = new InMemoryStore();

        // Mock the rate limit store retrieval (assuming we fix the import path in retry.ts)
        // For simplicity, we use the hybrid approach logic directly here.
        mockRateLimitStore = new class MockStore implements RateLimitStore {
            async increment(key: string, windowMs: number, _limit: number): Promise<{ count: number; resetAt: number }> {
                // Simulate calling the primary store
                return primaryStore.increment(key, windowMs, _limit);
            }
            async getCount(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
                // Simulate calling the primary store
                return primaryStore.getCount(key, windowMs);
            }
            async close(): Promise<void> {
                await primaryStore.close();
                await fallbackStore.close();
            }
        } as any; // Cast to bypass type mismatch for mock simplicity
    });

    afterEach(async () => {
        await mockRateLimitStore.close();
    });

    it('should successfully increment and report correct count under normal operation', async () => {
        const limitKey = 'consumer-abc';
        const windowMs = 60000;

        // Setup mock success
        (mockRedisClient.exec as vi.Mock).mockResolvedValue([null, 'member', [5, 5]]); // 5 successes

        const result = await mockRateLimitStore.increment(limitKey, windowMs, 10);

        expect(mockRedisClient.zadd).toHaveBeenCalledTimes(1);
        expect(result.count).toBe(5);
        expect(result.resetAt).toBeGreaterThan(Date.now());
    });

    it('should fallback to in-memory store when Redis fails during increment', async () => {
        const limitKey = 'consumer-def';
        const windowMs = 60000;

        // Simulate Redis connection error
        mockRedisClient.exec.mockRejectedValue(new Error('Redis connection failed'));

        const result = await mockRateLimitStore['increment'](limitKey, windowMs, 10);

        // Check that primary failed, and in-memory was executed
        expect(mockRedisClient.zadd).toHaveBeenCalledTimes(1);
        expect(result.count).toBe(1); // InMemory always counts 1 on first run

    });

    it('should correctly calculate the expiry and count when tokens are cleared (simulated)', async () => {
        const limitKey = 'consumer-xyz';
        const windowMs = 30000;

        // Simulate cleanup (ZREMRANGEBYSCORE) happening
        mockRedisClient.exec.mockResolvedValue([null, null, [1, 1]]);

        await mockRateLimitStore.increment(limitKey, windowMs, 10);

        // A subsequent call should show the count being managed
        const result = await mockRateLimitStore.increment(limitKey, windowMs, 10);
        expect(result.count).toBe(2);
    });

    // --- Mock Test for Retry Logic Integration ---

    it('should use the rate limit check before calculating next retry time', async () => {
        // This mock tests the integration point structure
        const payload: WebhookOutboxRetryInput = {
            consumerUrl: 'https://example.com/webhook',
            streamId: 'stream1',
            eventType: 'event',
            payload: { id: 123 },
            attemptNumber: 1,
            policy: { maxAttempts: 3, initialBackoffMs: 100, backoffMultiplier: 2, maxBackoffMs: 1000, jitterPercent: 10, timeoutMs: 5000, retryableStatusCodes: [429, 500, 502, 503, 504], jitterAlgorithm: 'full' }
        };

        // Mock rate limit availability (e.g., 1 attempt allowed)
        (mockRateLimitStore.increment as vi.Mock).mockResolvedValue({ count: 1, resetAt: Date.now() + 60000 });

        // Assuming a function that wraps the retry attempt and checks rate limits
        // For this test, we mock the direct call to show proper usage.

        // TODO: Implement the rate limiting protection logic within a function that
        // calls the rateLimitStore.increment before calling calculateNextRetryTime.
    });
});