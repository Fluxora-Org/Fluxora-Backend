/**
 * Rate-limit store implementations.
 *
 * Three implementations of the `RateLimitStore` interface:
 *   - `InMemoryStore`: In-process counter map, used as fallback when Redis is unavailable.
 *   - `SlidingWindowStore`: Redis sorted-set pipeline implementation for cluster-wide limits.
 *   - `HybridStore`: Wraps a primary and fallback store; delegates to fallback on primary errors.
 */

import type { RateLimitStore } from '../types/rateLimit.js';
import type { RedisClient } from './client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitise an identifier for use as a Redis key segment.
 * Replaces any character outside [A-Za-z0-9._-] with `_` and truncates to 256 chars.
 */
export function sanitiseIdentifier(id: string): string {
    const sanitised = id.replace(/[^A-Za-z0-9._-]/g, '_');
    return sanitised.slice(0, 256) || 'unknown';
}

function randomHex(bytes: number): string {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < bytes * 2; i++) {
        result += chars[Math.floor(Math.random() * 16)];
    }
    return result;
}

// ---------------------------------------------------------------------------
// InMemoryStore (Task 2.1)
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of `RateLimitStore`.
 *
 * Extracted from the counter logic in `src/middleware/rateLimiter.ts`.
 * Used as the fallback backend when Redis is unavailable.
 */
export class InMemoryStore implements RateLimitStore {
    private readonly counters = new Map<string, { count: number; resetAt: number }>();

    private getOrInit(key: string, windowMs: number): { count: number; resetAt: number } {
        const now = Date.now();
        let entry = this.counters.get(key);
        if (!entry || now >= entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs };
            this.counters.set(key, entry);
        }
        return entry;
    }

    async increment(
        key: string,
        windowMs: number,
        _limit: number,
    ): Promise<{ count: number; resetAt: number }> {
        const entry = this.getOrInit(key, windowMs);
        entry.count += 1;
        return { count: entry.count, resetAt: entry.resetAt };
    }

    async getCount(
        key: string,
        windowMs: number,
    ): Promise<{ count: number; resetAt: number }> {
        const now = Date.now();
        const entry = this.counters.get(key);
        if (!entry || now >= entry.resetAt) {
            return { count: 0, resetAt: now + windowMs };
        }
        return { count: entry.count, resetAt: entry.resetAt };
    }

    async close(): Promise<void> {
        // No-op — nothing to clean up for an in-memory store.
    }
}

// ---------------------------------------------------------------------------
// SlidingWindowStore (Task 2.3)
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'fluxora:rl:';

/**
 * Redis sliding-window implementation of `RateLimitStore`.
 *
 * Uses a sorted-set pipeline (ZADD NX + ZREMRANGEBYSCORE + ZCARD + PEXPIRE)
 * executed in a single `multi()` round-trip per `increment` call.
 *
 * Key format: `fluxora:rl:{sanitisedKey}`
 * Member format: `{timestampMs}-{6-char random hex}`
 */
export class SlidingWindowStore implements RateLimitStore {
    private closed = false;

    constructor(private readonly client: RedisClient) {}

    private buildKey(key: string): string {
        return `${KEY_PREFIX}${sanitiseIdentifier(key)}`;
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new Error('SlidingWindowStore is closed');
        }
    }

    async increment(
        key: string,
        windowMs: number,
        _limit: number,
    ): Promise<{ count: number; resetAt: number }> {
        this.assertOpen();

        const now = Date.now();
        const redisKey = this.buildKey(key);
        const member = `${now}-${randomHex(3)}`; // 3 bytes = 6 hex chars

        const results = await this.client
            .multi()
            .zadd(redisKey, 'NX', now, member)
            .zremrangebyscore(redisKey, '-inf', now - windowMs)
            .zcard(redisKey)
            .pexpire(redisKey, windowMs)
            .exec();

        if (!results) {
            throw new Error('Redis sliding-window pipeline failed to execute');
        }

        for (let i = 0; i < results.length; i++) {
            const [err] = results[i] as [Error | null, unknown];
            if (err) {
                /**
                 * Failure semantics:
                 * On any partial pipeline failure, we immediately throw an error.
                 * This surfaces a clear error, preventing us from silently reading an undefined ZCARD.
                 * The HybridStore wrapper catches this error and delegates to the fallback InMemoryStore,
                 * thereby maintaining availability while properly enforcing a degraded local limit.
                 */
                throw new Error(`Redis pipeline command at index ${i} failed: ${err.message}`);
            }
        }

        // ZCARD result is at index 2
        const zcardResult = results[2];
        const count = zcardResult && zcardResult[1] != null ? (zcardResult[1] as number) : 0;

        return { count, resetAt: now + windowMs };
    }

    async getCount(
        key: string,
        windowMs: number,
    ): Promise<{ count: number; resetAt: number }> {
        this.assertOpen();

        const now = Date.now();
        const redisKey = this.buildKey(key);
        const count = await this.client.zcount(redisKey, now - windowMs, '+inf');

        return { count, resetAt: now + windowMs };
    }

    async close(): Promise<void> {
        this.closed = true;
        await this.client.close();
    }
}

// ---------------------------------------------------------------------------
// HybridStore (Task 2.5)
// ---------------------------------------------------------------------------

/**
 * Hybrid implementation of `RateLimitStore`.
 *
 * Delegates to `primary` (typically `SlidingWindowStore`) and falls back to
 * `fallback` (typically `InMemoryStore`) on any error from the primary.
 *
 * The `usingFallback` property is set to `true` the first time the primary
 * fails, allowing callers to detect degraded operation.
 */
export class HybridStore implements RateLimitStore {
    usingFallback = false;

    constructor(
        private readonly primary: RateLimitStore,
        private readonly fallback: RateLimitStore,
        private readonly onError: (err: unknown, op: string) => void,
    ) {}

    async increment(
        key: string,
        windowMs: number,
        limit: number,
    ): Promise<{ count: number; resetAt: number }> {
        try {
            return await this.primary.increment(key, windowMs, limit);
        } catch (err) {
            this.onError(err, 'increment');
            this.usingFallback = true;
            return this.fallback.increment(key, windowMs, limit);
        }
    }

    async getCount(
        key: string,
        windowMs: number,
    ): Promise<{ count: number; resetAt: number }> {
        try {
            return await this.primary.getCount(key, windowMs);
        } catch (err) {
            this.onError(err, 'getCount');
            this.usingFallback = true;
            return this.fallback.getCount(key, windowMs);
        }
    }

    async close(): Promise<void> {
        await Promise.all([this.primary.close(), this.fallback.close()]);
    }
}
