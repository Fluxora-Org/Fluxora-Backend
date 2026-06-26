import { vi, type Mocked } from 'vitest';
import { RedisClient } from '../redis/client.js';
import { WebhookRateLimiter, RateLimitConfig } from '../redis/webhookRateLimit.js';

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
    const mockRateLimiter = {
        checkLimit: vi.fn(),
        recordFailure: vi.fn(),
    } as unknown as WebhookRateLimiter;

    mockRateLimiter.checkLimit.mockResolvedValue({ canAttempt: true, retryAfterMs: null });
    return mockRateLimiter;
}