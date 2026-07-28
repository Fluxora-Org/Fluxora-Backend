/**
 * FakeRedisClient — in-process test double for RedisClient.
 *
 * Backed by plain Maps to simulate Redis sorted-set and string operations
 * without requiring a real Redis instance. Designed for use in property-based
 * and unit tests for SlidingWindowStore and HybridStore.
 */

import type { RedisClient, RedisPipeline } from '../client.js';

// ---------------------------------------------------------------------------
// Internal sorted-set representation
// ---------------------------------------------------------------------------

/** A single sorted-set entry: member → score */
type SortedSetEntry = Map<string, number>;

// ---------------------------------------------------------------------------
// Score range helpers
// ---------------------------------------------------------------------------

function parseScore(value: string | number): number {
    if (value === '-inf') return -Infinity;
    if (value === '+inf') return Infinity;
    return Number(value);
}

function membersInRange(set: SortedSetEntry, min: string | number, max: string | number): string[] {
    const lo = parseScore(min);
    const hi = parseScore(max);
    const result: string[] = [];
    for (const [member, score] of set) {
        if (score >= lo && score <= hi) {
            result.push(member);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// FakeRedisClient
// ---------------------------------------------------------------------------

export class FakeRedisClient implements RedisClient {
    /** String key → value store */
    private readonly strings = new Map<string, string>();

    /** Sorted-set key → (member → score) */
    private readonly sortedSets = new Map<string, SortedSetEntry>();

    /** TTL store — pexpire values (ms). Stored but not enforced; tests control time. */
    private readonly ttls = new Map<string, number>();

    /** Operations that should throw on the next call: op name → error message */
    private readonly pendingThrows = new Map<string, string>();

    // -----------------------------------------------------------------------
    // Test helpers
    // -----------------------------------------------------------------------

    /**
     * Cause the next call to the named operation to throw an error.
     * The operation name matches the method name (e.g. 'zadd', 'zcard', 'exec').
     */
    throwOnNext(op: string, message = `Simulated Redis error on ${op}`): void {
        this.pendingThrows.set(op, message);
    }

    /**
     * Clear all stored data, TTLs, and pending throw flags.
     * Call between test cases to ensure isolation.
     */
    reset(): void {
        this.strings.clear();
        this.sortedSets.clear();
        this.ttls.clear();
        this.pendingThrows.clear();
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    private maybeThrow(op: string): void {
        const msg = this.pendingThrows.get(op);
        if (msg !== undefined) {
            this.pendingThrows.delete(op);
            throw new Error(msg);
        }
    }

    private getOrCreateSet(key: string): SortedSetEntry {
        let set = this.sortedSets.get(key);
        if (!set) {
            set = new Map<string, number>();
            this.sortedSets.set(key, set);
        }
        return set;
    }

    // -----------------------------------------------------------------------
    // Sorted-set operations (used directly, not via pipeline)
    // -----------------------------------------------------------------------

    /** ZADD key [NX] score member */
    private _zadd(key: string, nx: 'NX', score: number, member: string): number {
        this.maybeThrow('zadd');
        const set = this.getOrCreateSet(key);
        if (nx === 'NX' && set.has(member)) {
            return 0; // NX: do not update existing member
        }
        set.set(member, score);
        return 1;
    }

    /** ZREMRANGEBYSCORE key min max */
    private _zremrangebyscore(key: string, min: string | number, max: string | number): number {
        this.maybeThrow('zremrangebyscore');
        const set = this.sortedSets.get(key);
        if (!set) return 0;
        const toRemove = membersInRange(set, min, max);
        for (const member of toRemove) {
            set.delete(member);
        }
        return toRemove.length;
    }

    /** ZCARD key */
    private _zcard(key: string): number {
        this.maybeThrow('zcard');
        return this.sortedSets.get(key)?.size ?? 0;
    }

    /** PEXPIRE key ms */
    private _pexpire(key: string, ms: number): number {
        this.maybeThrow('pexpire');
        this.ttls.set(key, ms);
        return 1;
    }

    /** ZCOUNT key min max */
    async zcount(key: string, min: string | number, max: string | number): Promise<number> {
        this.maybeThrow('zcount');
        const set = this.sortedSets.get(key);
        if (!set) return 0;
        return membersInRange(set, min, max).length;
    }

    // -----------------------------------------------------------------------
    // String operations
    // -----------------------------------------------------------------------

    async get(key: string): Promise<string | null> {
        this.maybeThrow('get');
        return this.strings.get(key) ?? null;
    }

    async set(key: string, value: string, _options?: { ex?: number }): Promise<void> {
        this.maybeThrow('set');
        this.strings.set(key, value);
    }

    async setNx(key: string, value: string, _pxMs: number): Promise<boolean> {
        this.maybeThrow('setNx');
        if (this.strings.has(key)) return false;
        this.strings.set(key, value);
        return true;
    }

    async del(key: string): Promise<void> {
        this.maybeThrow('del');
        this.strings.delete(key);
        this.sortedSets.delete(key);
        this.ttls.delete(key);
    }

    async exists(key: string): Promise<boolean> {
        this.maybeThrow('exists');
        return this.strings.has(key) || this.sortedSets.has(key);
    }

    async close(): Promise<void> {
        this.maybeThrow('close');
        // No-op — nothing to tear down for an in-process fake.
    }

    // -----------------------------------------------------------------------
    // Pipeline (multi)
    // -----------------------------------------------------------------------

    /**
     * Returns a RedisPipeline that queues operations and executes them all
     * synchronously on `.exec()`, returning `Array<[Error | null, unknown]>`.
     *
     * If `throwOnNext('exec')` has been set, `.exec()` throws instead of
     * returning results.
     */
    multi(): RedisPipeline {
        type QueuedOp = () => [Error | null, unknown];
        const queue: QueuedOp[] = [];

        // Capture `this` for use inside the pipeline methods.
        const self = this;

        const pipeline: RedisPipeline = {
            zadd(key: string, nx: 'NX', score: number, member: string): RedisPipeline {
                queue.push(() => {
                    try {
                        return [null, self._zadd(key, nx, score, member)];
                    } catch (err) {
                        return [err instanceof Error ? err : new Error(String(err)), null];
                    }
                });
                return pipeline;
            },

            zremrangebyscore(key: string, min: string | number, max: string | number): RedisPipeline {
                queue.push(() => {
                    try {
                        return [null, self._zremrangebyscore(key, min, max)];
                    } catch (err) {
                        return [err instanceof Error ? err : new Error(String(err)), null];
                    }
                });
                return pipeline;
            },

            zcard(key: string): RedisPipeline {
                queue.push(() => {
                    try {
                        return [null, self._zcard(key)];
                    } catch (err) {
                        return [err instanceof Error ? err : new Error(String(err)), null];
                    }
                });
                return pipeline;
            },

            pexpire(key: string, ms: number): RedisPipeline {
                queue.push(() => {
                    try {
                        return [null, self._pexpire(key, ms)];
                    } catch (err) {
                        return [err instanceof Error ? err : new Error(String(err)), null];
                    }
                });
                return pipeline;
            },

            async exec(): Promise<Array<[Error | null, unknown]>> {
                self.maybeThrow('exec');
                return queue.map((op) => op());
            },
        };

        return pipeline;
    }
}
