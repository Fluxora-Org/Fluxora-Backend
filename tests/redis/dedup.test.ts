/**
 * Dedup cache tests.
 *
 * Covers:
 *   - InMemoryDedupCache basic operations
 *   - RedisDedupCache with mocked client
 *   - HybridDedupCache fallback behavior
 *   - Edge cases: empty inputs, max capacity, Redis failure modes
 *   - Metrics emission on Redis failures and fallback activations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    InMemoryDedupCache,
    RedisDedupCache,
    HybridDedupCache,
    __resetDedupForTest,
    DEDUP_CACHE_MAX,
    type DedupCache,
} from '../../src/redis/dedup.js';
import type { RedisClient } from '../../src/redis/client.js';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import { dedupRedisErrorsTotal, dedupRedisFallbackTotal, registry } from '../../src/metrics.js';
import { logger } from '../../src/lib/logger.js';

const mockRedisClient = (overrides: Partial<RedisClient> = {}): RedisClient => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setNx: vi.fn().mockResolvedValue(true),
    del: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    multi: vi.fn(),
    zcount: vi.fn().mockResolvedValue(0),
    ...overrides,
});

describe('InMemoryDedupCache', () => {
    let cache: InMemoryDedupCache;

    beforeEach(() => {
        cache = new InMemoryDedupCache();
    });

    it('returns false for unseen (streamId, eventId)', async () => {
        await expect(cache.has('stream-1', 'evt-1')).resolves.toBe(false);
    });

    it('returns true after adding (streamId, eventId)', async () => {
        await cache.add('stream-1', 'evt-1');
        await expect(cache.has('stream-1', 'evt-1')).resolves.toBe(true);
    });

    it('treats different eventIds as distinct', async () => {
        await cache.add('stream-1', 'evt-1');
        await cache.add('stream-1', 'evt-2');
        await expect(cache.has('stream-1', 'evt-1')).resolves.toBe(true);
        await expect(cache.has('stream-1', 'evt-2')).resolves.toBe(true);
    });

    it('treats different streamIds as distinct', async () => {
        await cache.add('stream-1', 'evt-1');
        await expect(cache.has('stream-2', 'evt-1')).resolves.toBe(false);
    });

    it('clears all entries', async () => {
        await cache.add('stream-1', 'evt-1');
        await cache.add('stream-2', 'evt-2');
        await cache.clear();
        await expect(cache.has('stream-1', 'evt-1')).resolves.toBe(false);
        await expect(cache.has('stream-2', 'evt-2')).resolves.toBe(false);
    });

    it('close is a no-op', async () => {
        await expect(cache.close()).resolves.toBeUndefined();
    });

    it('handles empty strings', async () => {
        await cache.add('', '');
        await expect(cache.has('', '')).resolves.toBe(true);
    });

    it('handles special characters in ids', async () => {
        const streamId = 'stream:with:colons';
        const eventId = 'evt-123:456';
        await cache.add(streamId, eventId);
        await expect(cache.has(streamId, eventId)).resolves.toBe(true);
    });
});

describe('RedisDedupCache', () => {
    let client: RedisClient;
    let cache: RedisDedupCache;

    beforeEach(() => {
        client = mockRedisClient();
        cache = new RedisDedupCache(client);
    });

    it('delegates exists to Redis client', async () => {
        vi.mocked(client.exists).mockResolvedValue(true);
        await expect(cache.has('stream-1', 'evt-1')).resolves.toBe(true);
        expect(client.exists).toHaveBeenCalledWith('fluxora:dedup:stream-1:evt-1');
    });

    it('delegates add to Redis client via setNx with TTL', async () => {
        await cache.add('stream-1', 'evt-1');
        expect(client.setNx).toHaveBeenCalledWith(
            'fluxora:dedup:stream-1:evt-1',
            '1',
            86400 * 1000
        );
    });

    it('uses custom TTL when provided', async () => {
        const cacheWithTTL = new RedisDedupCache(client, 3600);
        await cacheWithTTL.add('stream-1', 'evt-1');
        expect(client.setNx).toHaveBeenCalledWith(
            'fluxora:dedup:stream-1:evt-1',
            '1',
            3600 * 1000
        );
    });

    it('closes the Redis client', async () => {
        await cache.close();
        expect(client.close).toHaveBeenCalled();
    });

    it('rethrows and records metric when Redis exists throws', async () => {
        const incSpy = vi.spyOn(dedupRedisErrorsTotal, 'inc');
        vi.mocked(client.exists).mockRejectedValue(new Error('connection failed'));
        await expect(cache.has('stream-1', 'evt-1')).rejects.toThrow('connection failed');
        expect(incSpy).toHaveBeenCalledWith({ operation: 'has' });
    });

    it('rethrows and records metric when add throws', async () => {
        const incSpy = vi.spyOn(dedupRedisErrorsTotal, 'inc');
        vi.mocked(client.setNx).mockRejectedValue(new Error('write failed'));
        await expect(cache.add('stream-1', 'evt-1')).rejects.toThrow('write failed');
        expect(incSpy).toHaveBeenCalledWith({ operation: 'add' });
    });

    it('clear is a no-op', async () => {
        await expect(cache.clear()).resolves.toBeUndefined();
    });
});

describe('RedisDedupCache – metrics', () => {
    let client: FakeRedisClient;
    let cache: RedisDedupCache;

    beforeEach(() => {
        registry.removeSingleMetric('dedup_redis_errors_total');
        registry.removeSingleMetric('dedup_redis_fallback_total');
        client = new FakeRedisClient();
        cache = new RedisDedupCache(client);
    });

    afterEach(() => {
        client.reset();
    });

    it('increments error counter on has() failure', async () => {
        __resetDedupForTest();
        const incSpy = vi.spyOn(dedupRedisErrorsTotal, 'inc');
        client.throwOnNext('exists');

        await expect(cache.has('s1', 'e1')).rejects.toThrow();

        expect(incSpy).toHaveBeenCalledWith({ operation: 'has' });
    });

    it('increments error counter on add() failure', async () => {
        __resetDedupForTest();
        const incSpy = vi.spyOn(dedupRedisErrorsTotal, 'inc');
        client.throwOnNext('setNx');

        await expect(cache.add('s1', 'e1')).rejects.toThrow();

        expect(incSpy).toHaveBeenCalledWith({ operation: 'add' });
    });
});

describe('HybridDedupCache', () => {
    let primary: DedupCache;
    let fallback: InMemoryDedupCache;
    let hybrid: HybridDedupCache;

    beforeEach(() => {
        fallback = new InMemoryDedupCache();
    });

    describe('when Redis is enabled', () => {
        beforeEach(() => {
            const mockPrimary: DedupCache = {
                has: vi.fn().mockResolvedValue(false),
                add: vi.fn().mockResolvedValue(true),
                clear: vi.fn().mockResolvedValue(undefined),
                close: vi.fn().mockResolvedValue(undefined),
            };
            primary = mockPrimary;
            hybrid = new HybridDedupCache(primary, fallback, true);
        });

        it('returns true if found in Redis', async () => {
            vi.mocked(primary.has).mockResolvedValue(true);
            await expect(hybrid.has('stream-1', 'evt-1')).resolves.toBe(true);
        });

        it('adds to both caches on first encounter', async () => {
            await hybrid.add('stream-1', 'evt-1');
            expect(vi.mocked(primary.add)).toHaveBeenCalledWith('stream-1', 'evt-1');
            await expect(fallback.has('stream-1', 'evt-1')).resolves.toBe(true);
        });

        it('clears both caches', async () => {
            await hybrid.clear();
            await expect(fallback.has('stream-1', 'evt-1')).resolves.toBe(false);
        });

        it('closes the Redis cache', async () => {
            await hybrid.close();
            expect(vi.mocked(primary.close)).toHaveBeenCalled();
        });
    });

    describe('when Redis is disabled', () => {
        beforeEach(() => {
            const mockPrimary: DedupCache = {
                has: vi.fn(),
                add: vi.fn(),
                clear: vi.fn(),
                close: vi.fn(),
            };
            primary = mockPrimary;
            hybrid = new HybridDedupCache(primary, fallback, false);
        });

        it('skips Redis for has checks', async () => {
            await hybrid.has('stream-1', 'evt-1');
            expect(vi.mocked(primary.has)).not.toHaveBeenCalled();
        });

        it('skips Redis for add operations', async () => {
            await hybrid.add('stream-1', 'evt-1');
            expect(vi.mocked(primary.add)).not.toHaveBeenCalled();
        });

        it('still uses fallback cache', async () => {
            await hybrid.add('stream-1', 'evt-1');
            await expect(fallback.has('stream-1', 'evt-1')).resolves.toBe(true);
        });
    });

    describe('Redis failure fallback', () => {
        beforeEach(() => {
            const mockPrimary: DedupCache = {
                has: vi.fn().mockRejectedValue(new Error('Redis down')),
                add: vi.fn().mockRejectedValue(new Error('Redis down')),
                clear: vi.fn(),
                close: vi.fn(),
            };
            primary = mockPrimary;
            hybrid = new HybridDedupCache(primary, fallback, true);
        });

        it('falls back to in-memory when Redis has throws', async () => {
            await expect(hybrid.has('stream-1', 'evt-1')).resolves.toBe(false);
            await expect(fallback.has('stream-1', 'evt-1')).resolves.toBe(false);
        });

        it('falls back to in-memory when Redis add throws', async () => {
            await hybrid.add('stream-1', 'evt-1');
            await expect(fallback.has('stream-1', 'evt-1')).resolves.toBe(true);
        });

        it('increments fallback counter on Redis has failure', async () => {
            __resetDedupForTest();
            registry.removeSingleMetric('dedup_redis_fallback_total');
            const incSpy = vi.spyOn(dedupRedisFallbackTotal, 'inc');
            const debugSpy = vi.spyOn(logger, 'debug');

            await hybrid.has('stream-1', 'evt-1');

            expect(incSpy).toHaveBeenCalledWith({ operation: 'has' });
            expect(debugSpy).toHaveBeenCalledWith('dedup:fallback', undefined, {
                operation: 'has',
                streamId: 'stream-1',
                eventId: 'evt-1',
            });
        });

        it('increments fallback counter on Redis add failure', async () => {
            __resetDedupForTest();
            registry.removeSingleMetric('dedup_redis_fallback_total');
            const incSpy = vi.spyOn(dedupRedisFallbackTotal, 'inc');
            const debugSpy = vi.spyOn(logger, 'debug');

            await hybrid.add('stream-1', 'evt-1');

            expect(incSpy).toHaveBeenCalledWith({ operation: 'add' });
            expect(debugSpy).toHaveBeenCalledWith('dedup:fallback', undefined, {
                operation: 'add',
                streamId: 'stream-1',
                eventId: 'evt-1',
            });
        });
    });
});

describe('DedupCache key format', () => {
    it('uses consistent key format for RedisDedupCache', async () => {
        const client = mockRedisClient();
        const cache = new RedisDedupCache(client);
        await cache.add('stream-abc', 'evt-xyz');
        expect(client.setNx).toHaveBeenCalledWith(
            'fluxora:dedup:stream-abc:evt-xyz',
            '1',
            expect.any(Number)
        );
    });
});

describe('InMemoryDedupCache FIFO eviction', () => {
    it('evicts the oldest-inserted key when exceeding DEDUP_CACHE_MAX', async () => {
        const cache = new InMemoryDedupCache();
        const max = DEDUP_CACHE_MAX;

        for (let i = 0; i < max; i++) {
            await cache.add('stream', 'evt-' + i);
        }

        await expect(cache.has('stream', 'evt-0')).resolves.toBe(true);

        const added = await cache.add('stream', 'evt-' + max);
        expect(added).toBe(true);

        await expect(cache.has('stream', 'evt-0')).resolves.toBe(false);
        await expect(cache.has('stream', 'evt-1')).resolves.toBe(true);
        await expect(cache.has('stream', 'evt-' + max)).resolves.toBe(true);
    });

    it('evicts in strict FIFO order over multiple insertions', async () => {
        const cache = new InMemoryDedupCache();
        const max = DEDUP_CACHE_MAX;

        for (let i = 0; i < max; i++) {
            await cache.add('s', 'e-' + i);
        }

        for (let i = 0; i < 5; i++) {
            await cache.add('s', 'overflow-' + i);
        }

        for (let i = 0; i < 5; i++) {
            await expect(cache.has('s', 'e-' + i)).resolves.toBe(false);
        }

        await expect(cache.has('s', 'e-5')).resolves.toBe(true);
    });
});

describe('HybridDedupCache Redis-outage replay false-negative', () => {
    it('treats replayed event as new after cache overflow during Redis outage', async () => {
        const max = DEDUP_CACHE_MAX;
        const fallback = new InMemoryDedupCache();

        const brokenPrimary: DedupCache = {
            has: vi.fn().mockRejectedValue(new Error('Redis down')),
            add: vi.fn().mockRejectedValue(new Error('Redis down')),
            clear: vi.fn(),
            close: vi.fn(),
        };

        const hybrid = new HybridDedupCache(brokenPrimary, fallback, true);

        for (let i = 0; i < max + 100; i++) {
            await hybrid.add('stream', 'evt-' + i);
        }

        await expect(hybrid.has('stream', 'evt-0')).resolves.toBe(false);

        const readded = await hybrid.add('stream', 'evt-0');
        expect(readded).toBe(true);

        await expect(hybrid.has('stream', 'evt-' + (max + 99))).resolves.toBe(true);
        const duplicate = await hybrid.add('stream', 'evt-' + (max + 99));
        expect(duplicate).toBe(false);
    });
});
// ── Issue #1433: deduplication window and store-unavailable behaviour ────────

const WINDOW_SECONDS = 60;
const WINDOW_MS = WINDOW_SECONDS * 1000;

/** Redis client double whose setNx/exists honour the PX expiry, like real Redis. */
function windowedRedisClient(): RedisClient {
    const expiresAt = new Map<string, number>();
    const live = (key: string): boolean => {
        const deadline = expiresAt.get(key);
        if (deadline === undefined) return false;
        if (Date.now() < deadline) return true;
        expiresAt.delete(key);
        return false;
    };
    return mockRedisClient({
        exists: vi.fn(async (key: string) => live(key)),
        setNx: vi.fn(async (key: string, _value: string, pxMs: number) => {
            if (live(key)) return false;
            expiresAt.set(key, Date.now() + pxMs);
            return true;
        }),
    });
}

function brokenStore(): DedupCache {
    return {
        has: vi.fn().mockRejectedValue(new Error('Redis down')),
        add: vi.fn().mockRejectedValue(new Error('Redis down')),
        clear: vi.fn(),
        close: vi.fn(),
    };
}

/** Submits the same event `times` times and returns how many were accepted as new. */
async function acceptedCount(cache: DedupCache, times: number): Promise<number> {
    let accepted = 0;
    for (let i = 0; i < times; i++) {
        if (await cache.add('stream-1', 'evt-1')) accepted++;
    }
    return accepted;
}

const backends: Array<[string, () => DedupCache]> = [
    ['InMemoryDedupCache', () => new InMemoryDedupCache(WINDOW_SECONDS)],
    ['RedisDedupCache', () => new RedisDedupCache(windowedRedisClient(), WINDOW_SECONDS)],
    [
        'HybridDedupCache (Redis healthy)',
        () =>
            new HybridDedupCache(
                new RedisDedupCache(windowedRedisClient(), WINDOW_SECONDS),
                new InMemoryDedupCache(WINDOW_SECONDS),
                true,
            ),
    ],
    [
        'HybridDedupCache (Redis unavailable)',
        () => new HybridDedupCache(brokenStore(), new InMemoryDedupCache(WINDOW_SECONDS), true),
    ],
];

describe.each(backends)('%s – deduplication window', (_name, makeCache) => {
    beforeEach(() => {
        vi.useFakeTimers();
        __resetDedupForTest();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('processes an event exactly once when duplicates arrive inside the window', async () => {
        const cache = makeCache();

        expect(await acceptedCount(cache, 1)).toBe(1);
        vi.advanceTimersByTime(WINDOW_MS - 1);
        expect(await acceptedCount(cache, 3)).toBe(0);
        await expect(cache.has('stream-1', 'evt-1')).resolves.toBe(true);
    });

    it('processes the event again once the window has elapsed, then suppresses it again', async () => {
        const cache = makeCache();

        expect(await acceptedCount(cache, 1)).toBe(1);
        vi.advanceTimersByTime(WINDOW_MS);
        await expect(cache.has('stream-1', 'evt-1')).resolves.toBe(false);
        expect(await acceptedCount(cache, 3)).toBe(1);
    });

    it('measures the window from the first add, not from later duplicates', async () => {
        const cache = makeCache();

        await cache.add('stream-1', 'evt-1');
        vi.advanceTimersByTime(WINDOW_MS / 2);
        expect(await cache.add('stream-1', 'evt-1')).toBe(false);
        vi.advanceTimersByTime(WINDOW_MS / 2);
        expect(await cache.add('stream-1', 'evt-1')).toBe(true);
    });
});

describe('RedisDedupCache – window configuration', () => {
    it('defaults the Redis TTL to 24h', async () => {
        const client = mockRedisClient();
        await new RedisDedupCache(client).add('s', 'e');
        expect(client.setNx).toHaveBeenCalledWith(expect.any(String), '1', 86400 * 1000);
    });
});

describe('HybridDedupCache – store unavailable (fail-open to in-memory)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        __resetDedupForTest();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function fallbackCount(): Promise<number> {
        const metric = await dedupRedisFallbackTotal.get();
        return metric.values.reduce((sum, v) => sum + v.value, 0);
    }

    it('never rejects an event because the store is unavailable', async () => {
        const hybrid = new HybridDedupCache(brokenStore(), new InMemoryDedupCache(WINDOW_SECONDS), true);

        await expect(hybrid.add('stream-1', 'evt-1')).resolves.toBe(true);
        await expect(hybrid.has('stream-1', 'evt-1')).resolves.toBe(true);
    });

    it('records every fallback on dedup_redis_fallback_total', async () => {
        const hybrid = new HybridDedupCache(brokenStore(), new InMemoryDedupCache(WINDOW_SECONDS), true);
        const before = await fallbackCount();

        await hybrid.add('stream-1', 'evt-1');
        await hybrid.add('stream-1', 'evt-2');
        await hybrid.has('stream-1', 'evt-1');

        expect((await fallbackCount()) - before).toBe(3);
    });

    it('keeps suppressing an event seen before Redis went down', async () => {
        const primary = brokenStore();
        const redisHealthy = new RedisDedupCache(windowedRedisClient(), WINDOW_SECONDS);
        (primary.add as ReturnType<typeof vi.fn>).mockImplementationOnce((s: string, e: string) =>
            redisHealthy.add(s, e),
        );
        const hybrid = new HybridDedupCache(primary, new InMemoryDedupCache(WINDOW_SECONDS), true);

        expect(await hybrid.add('stream-1', 'evt-1')).toBe(true);
        // Redis is now down for every later call.
        expect(await hybrid.add('stream-1', 'evt-1')).toBe(false);
    });

    it('does not suppress a duplicate reaching a different process during an outage (documented)', async () => {
        const processA = new HybridDedupCache(brokenStore(), new InMemoryDedupCache(WINDOW_SECONDS), true);
        const processB = new HybridDedupCache(brokenStore(), new InMemoryDedupCache(WINDOW_SECONDS), true);

        expect(await processA.add('stream-1', 'evt-1')).toBe(true);
        expect(await processB.add('stream-1', 'evt-1')).toBe(true);
    });

    it('suppresses via Redis again once it recovers, for keys written before the outage', async () => {
        const client = windowedRedisClient();
        const before = new HybridDedupCache(
            new RedisDedupCache(client, WINDOW_SECONDS),
            new InMemoryDedupCache(WINDOW_SECONDS),
            true,
        );
        await before.add('stream-1', 'evt-1');

        // A fresh process (empty in-memory cache) after Redis recovers.
        const after = new HybridDedupCache(
            new RedisDedupCache(client, WINDOW_SECONDS),
            new InMemoryDedupCache(WINDOW_SECONDS),
            true,
        );
        expect(await after.add('stream-1', 'evt-1')).toBe(false);
    });
});
