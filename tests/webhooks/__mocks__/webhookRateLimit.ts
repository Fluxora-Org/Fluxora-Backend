import { vi, type Mocked } from 'vitest';
import { RedisClient } from '../../../src/redis/client.js';
import { WebhookRateLimiter, RateLimitConfig } from '../../../src/redis/webhookRateLimit.js';

/**
 * @param {RedisClient} mockRedisClient - Mock Redis client for testing.
 * @param {number} rateLimit - Maximum allowed retries per window.
 * @param {number} windowMs - Size of the sliding window in ms.
 * @returns {WebhookRateLimiter}
 */
export function setupRateLimiter(
    mockRedisClient: Mocked<RedisClient>, 
    rateLimit: number, 
    windowMs: number
): WebhookRateLimiter {
    const checkLimit = vi.fn();
    checkLimit.mockResolvedValue({ canAttempt: true, retryAfterMs: null });

    return {
        checkLimit,
        recordFailure: vi.fn(),
    } as unknown as WebhookRateLimiter;
}