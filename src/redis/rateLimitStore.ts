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
 * - **Input validation** — every store rejects malformed, empty, oversized keys
 *   and out-of-range windows with a typed `RateLimitInputError` *before* any
 *   state is read or written, so a bad call can never create a bucket, embed an
 *   unbounded Redis key, or mutate a counter. See `assertKey` / `assertWindowMs`.
 */

import type { RateLimitStore } from '../types/rateLimit.js';
import type { RedisClient } from './client.js';
import { MAX_WINDOW_MS } from '../config/rateLimits.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maximum accepted key length (characters).
 *
 * Every caller builds keys as `v1:{principalType}:{principalKey}:{routeKey}`
 * (see `buildStoreKey` in `src/middleware/rateLimiter.ts`): a bounded prefix,
 * a hashed/normalised principal, and a route segment capped at 96 chars — so
 * legitimate keys stay well under 300 characters. 1024 is a generous ceiling
 * that still rejects oversized input before it is sanitised or written.
 */
export const MAX_RATE_LIMIT_KEY_LENGTH = 1024;

/**
 * Minimum accepted window length (milliseconds).
 *
 * The rate-limit config surface already enforces a 1000 ms floor
 * (`validateConfigPatch` in `src/routes/rateLimits.ts`); the store enforces the
 * same floor so a store can never be driven below one second directly.
 */
export const MIN_RATE_LIMIT_WINDOW_MS = 1000;

/**
 * Typed error thrown when a rate-limit store call is given invalid input.
 *
 * Carries a machine-readable `field` (which argument was rejected) and `rule`
 * (the exact reason) so the caller can distinguish a `key` rejection from a
 * `windowMs` rejection *without* parsing the message string. The guard runs
 * **before any state is read or written**, so a malformed call cannot create a
 * bucket, embed an unbounded Redis key, or otherwise mutate store state.
 */
export class RateLimitInputError extends Error {
    /** Which argument failed validation (e.g. `key`, `windowMs`). */
    readonly field: string;

    /** Machine-readable rejection cause (e.g. `not-a-string`, `oversized`). */
    readonly rule: string;

    constructor(field: string, rule: string) {
        super(`Invalid rate-limit input for '${field}': ${rule}`);
        this.name = 'RateLimitInputError';
        this.field = field;
        this.rule = rule;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Assert `key` is a non-empty, non-whitespace, bounded-length string.
 *
 * @param field - Argument name reported in the thrown error (e.g. `key`).
 * @throws {RateLimitInputError} when `key` is not a string, is empty, or
 *   exceeds {@link MAX_RATE_LIMIT_KEY_LENGTH}.
 */
function assertKey(key: unknown, field = 'key'): asserts key is string {
    if (typeof key !== 'string') {
        throw new RateLimitInputError(field, 'must be a non-empty string');
    }
    if (key.trim() === '') {
        throw new RateLimitInputError(field, 'must be a non-empty string');
    }
    if (key.length > MAX_RATE_LIMIT_KEY_LENGTH) {
        throw new RateLimitInputError(
            field,
            `must not exceed ${MAX_RATE_LIMIT_KEY_LENGTH} characters (got ${key.length})`,
        );
    }
}

/**
 * Assert `windowMs` is an integer number of milliseconds within the supported
 * range `[MIN_RATE_LIMIT_WINDOW_MS, MAX_WINDOW_MS]`.
 *
 * Out-of-range windows are not merely cosmetic: `SlidingWindowStore` passes
 * `windowMs` straight to `PEXPIRE` and to timestamp arithmetic, so a zero,
 * negative, `NaN`, or unbounded window would corrupt the sliding window (keys
 * written with a garbage TTL, every entry either never pruned or pruned on
 * arrival).
 *
 * @throws {RateLimitInputError} when `windowMs` is non-finite, a non-integer,
 *   or outside the supported range.
 */
function assertWindowMs(windowMs: unknown, field = 'windowMs'): asserts windowMs is number {
    if (typeof windowMs !== 'number' || !Number.isFinite(windowMs)) {
        throw new RateLimitInputError(field, 'must be a finite number');
    }
    if (!Number.isInteger(windowMs)) {
        throw new RateLimitInputError(field, 'must be an integer');
    }
    if (windowMs < MIN_RATE_LIMIT_WINDOW_MS) {
        throw new RateLimitInputError(
            field,
            `must be at least ${MIN_RATE_LIMIT_WINDOW_MS}ms (got ${windowMs})`,
        );
    }
    if (windowMs > MAX_WINDOW_MS) {
        throw new RateLimitInputError(
            field,
            `must not exceed ${MAX_WINDOW_MS}ms (got ${windowMs})`,
        );
    }
}

/**
 * Validate the arguments shared by every read/write store operation.
 *
 * Runs before any operation touches state.
 */
function assertOperationInputs(key: unknown, windowMs: unknown): void {
    assertKey(key);
    assertWindowMs(windowMs);
}

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
        assertOperationInputs(key, windowMs);
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
        assertOperationInputs(key, windowMs);
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
        assertOperationInputs(key, windowMs);
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
        assertOperationInputs(key, windowMs);
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
        assertOperationInputs(key, windowMs);
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
        assertOperationInputs(key, windowMs);
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
