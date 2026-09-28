/**
 * Rate-limit store implementations backing `src/middleware/rateLimiter.ts`.
 *
 * Three implementations of the `RateLimitStore` interface:
 *   - `InMemoryStore`: process-local sliding-window counter map. Used as the
 *     fallback when Redis is unavailable, and as the sole backend when
 *     `REDIS_ENABLED=false`.
 *   - `SlidingWindowStore`: Redis sorted-set pipeline implementation for
 *     cluster-wide limits.
 *   - `HybridStore`: Wraps a primary and fallback store; delegates to fallback
 *     on primary errors.
 *
 * ## Shared contract
 *
 * All three stores implement the same sliding-window semantics and the same
 * key scope:
 *
 * - **Key scope** — `key` is the fully-qualified storage key supplied by the
 *   caller (the middleware builds `{principalType}:{identifier}:{route}`).
 *   Stores never broaden or merge keys; two distinct callers always get two
 *   distinct counters. `SlidingWindowStore` additionally sanitises the key
 *   before embedding it in a Redis key (`fluxora:rl:{sanitisedKey}`).
 * - **Expiry/lifetime** — a request counted by the store is only counted while
 *   it is inside `windowMs`. Both implementations prune anything older than
 *   `windowMs`, so entries cannot outlive the window they were recorded in.
 * - **Sliding, not fixed** — the window slides with each request. Unlike a
 *   fixed window, the stores cannot admit up to twice the configured limit
 *   across a window boundary.
 * - **Unavailable** — see `SlidingWindowStore` and `HybridStore`. A failed or
 *   closed Redis store throws; `HybridStore` catches that and delegates to its
 *   (always-available) in-memory fallback so requests keep being limited.
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
// InMemoryStore
// ---------------------------------------------------------------------------

/**
 * One sliding-window bucket: the ascending timestamps of requests that are
 * still inside the window, plus the window length used to prune them.
 */
interface SlidingBucket {
    /** Ascending request timestamps (ms) within the current window. */
    timestamps: number[];
    /** Window duration (ms). Re-stamped on every access. */
    windowMs: number;
}

/**
 * In-memory implementation of `RateLimitStore`.
 *
 * Contract:
 * - **Key scope**: keys are stored verbatim (process-local, never used as a
 *   Redis key), so no sanitisation is performed here.
 * - **Window**: a genuine **sliding window**. Each `increment` records the
 *   request timestamp; every read prunes timestamps that have left the window.
 *   This is deliberate: the previous fixed-window implementation admitted up to
 *   twice the configured rate across a window boundary (a burst at the end of
 *   one window plus a burst at the start of the next).
 * - **Expiry / boundedness**: timestamps are pruned once they are older than
 *   `windowMs`, a fully-elapsed bucket is dropped on access, and a periodic
 *   sweep evicts buckets whose window has passed. An entry therefore never
 *   outlives `windowMs` of inactivity.
 * - **Unavailable**: never — this is the fallback used when Redis is down and
 *   the sole backend when `REDIS_ENABLED=false`. `close()` releases all state.
 */
export class InMemoryStore implements RateLimitStore {
    private readonly buckets = new Map<string, SlidingBucket>();

    /**
     * Operations performed since the last full sweep. Expired buckets are
     * evicted periodically rather than on every call so a store with many live
     * keys does not pay an O(n) scan per request.
     */
    private operationsSinceSweep = 0;

    private static readonly SWEEP_INTERVAL = 256;

    /** Drop timestamps that have left the bucket's window. */
    private prune(bucket: SlidingBucket, now: number): void {
        const cutoff = now - bucket.windowMs;
        let firstAlive = 0;
        while (firstAlive < bucket.timestamps.length && bucket.timestamps[firstAlive] <= cutoff) {
            firstAlive++;
        }
        if (firstAlive > 0) {
            bucket.timestamps.splice(0, firstAlive);
        }
    }

    /**
     * Evict every bucket whose window has fully elapsed. Runs at most once per
     * `SWEEP_INTERVAL` operations to keep the per-request cost amortised.
     */
    private maybeSweep(now: number): void {
        if (++this.operationsSinceSweep < InMemoryStore.SWEEP_INTERVAL) return;
        this.operationsSinceSweep = 0;
        for (const [key, bucket] of this.buckets) {
            this.prune(bucket, now);
            if (bucket.timestamps.length === 0) {
                this.buckets.delete(key);
            }
        }
    }

    async increment(
        key: string,
        windowMs: number,
        _limit: number,
    ): Promise<{ count: number; resetAt: number }> {
        const now = Date.now();
        this.maybeSweep(now);

        const bucket = this.buckets.get(key);
        if (bucket) {
            bucket.windowMs = windowMs;
            this.prune(bucket, now);
        }

        const timestamps = bucket && bucket.timestamps.length > 0 ? bucket.timestamps : [];
        timestamps.push(now);
        this.buckets.set(key, { timestamps, windowMs });

        return { count: timestamps.length, resetAt: timestamps[0] + windowMs };
    }

    async getCount(
        key: string,
        windowMs: number,
    ): Promise<{ count: number; resetAt: number }> {
        const now = Date.now();
        this.maybeSweep(now);

        const bucket = this.buckets.get(key);
        if (!bucket) {
            return { count: 0, resetAt: now + windowMs };
        }

        bucket.windowMs = windowMs;
        this.prune(bucket, now);
        if (bucket.timestamps.length === 0) {
            // The window has fully elapsed — drop the entry so it cannot
            // outlive its documented lifetime.
            this.buckets.delete(key);
            return { count: 0, resetAt: now + windowMs };
        }

        return { count: bucket.timestamps.length, resetAt: bucket.timestamps[0] + windowMs };
    }

    async close(): Promise<void> {
        this.buckets.clear();
        this.operationsSinceSweep = 0;
    }
}

// ---------------------------------------------------------------------------
// SlidingWindowStore
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'fluxora:rl:';

/**
 * Redis sliding-window implementation of `RateLimitStore`.
 *
 * Contract:
 * - **Key scope**: one Redis sorted set per caller key, named
 *   `fluxora:rl:{sanitiseIdentifier(key)}`. Sanitisation replaces characters
 *   outside `[A-Za-z0-9._-]` with `_` and truncates to 256 chars, so the Redis
 *   key (prefix + 256) stays bounded regardless of caller input and can never
 *   collide across namespaces. Distinct caller keys always map to distinct
 *   Redis keys.
 * - **Window / expiry**: a genuine **sliding window**, not a fixed one. Every
 *   member carries the request timestamp as its score; `increment` removes
 *   members whose score is `<= now - windowMs` (`ZREMRANGEBYSCORE`) before
 *   counting, so only requests inside the trailing window count. A burst at the
 *   end of one window plus a burst at the start of the next cannot exceed the
 *   configured limit. `PEXPIRE {windowMs}` is refreshed on every increment, so
 *   the Redis key — and every member in it — expires one window after the last
 *   recorded request and cannot outlive its lifetime.
 * - **Unavailable**: throws if the pipeline returns no result, if any pipelined
 *   command fails, or after `close()`. Errors propagate to `HybridStore`, which
 *   falls back to an in-memory sliding window (`InMemoryStore`).
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
// HybridStore
// ---------------------------------------------------------------------------

/**
 * Hybrid implementation of `RateLimitStore`.
 *
 * Delegates to `primary` (typically `SlidingWindowStore`) and falls back to
 * `fallback` (typically `InMemoryStore`) on any error from the primary.
 *
 * Contract:
 * - **Unavailable behaviour**: if the primary throws for any reason — Redis
 *   connection loss, a partial pipeline failure, or a closed store — the error
 *   is reported through `onError`, `usingFallback` is set permanently to `true`,
 *   and the request is answered by the fallback store. Requests are therefore
 *   always limited, even during a Redis outage; the fallback enforces the same
 *   sliding-window semantics per process.
 * - `usingFallback` is sticky: once the primary has failed, callers can report
 *   degraded operation (`GET /api/rate-limits` returns `degraded: true`) even
 *   after Redis recovers.
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
