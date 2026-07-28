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
import { logger } from '../../src/logging/logger.js';

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