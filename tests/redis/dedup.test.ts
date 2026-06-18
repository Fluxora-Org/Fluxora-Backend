/**
 * Dedup cache tests.
 *
 * Covers:
 *   - InMemoryDedupCache basic operations
 *   - RedisDedupCache with mocked client
 *   - HybridDedupCache fallback behavior
 *   - Edge cases: empty inputs, max capacity, Redis failure modes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    InMemoryDedupCache,
    RedisDedupCache,
    HybridDedupCache,
    type DedupCache,
} from '../../src/redis/dedup.js';
import type { RedisClient } from '../../src/redis/client.js';

const mockRedisClient = (overrides: Partial<RedisClient> = {}): RedisClient => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
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

    it('delegates set to Redis client with TTL', async () => {
        await cache.add('stream-1', 'evt-1');
        expect(client.set).toHaveBeenCalledWith(
            'fluxora:dedup:stream-1:evt-1',
            '1',
            { ex: 86400 }
        );
    });

    it('returns custom TTL when provided', async () => {
        const cacheWithTTL = new RedisDedupCache(client, 3600);
        await cacheWithTTL.add('stream-1', 'evt-1');
        expect(client.set).toHaveBeenCalledWith(
            'fluxora:dedup:stream-1:evt-1',
            '1',
            { ex: 3600 }
        );
    });

    it('closes the Redis client', async () => {
        await cache.close();
        expect(client.close).toHaveBeenCalled();
    });

    it('returns false when Redis exists throws', async () => {
        vi.mocked(client.exists).mockRejectedValue(new Error('connection failed'));
        await expect(cache.has('stream-1', 'evt-1')).resolves.toBe(false);
    });

    it('swallows errors when add throws', async () => {
        vi.mocked(client.set).mockRejectedValue(new Error('write failed'));
        await expect(cache.add('stream-1', 'evt-1')).resolves.toBeUndefined();
    });

    it('clear is a no-op', async () => {
        await expect(cache.clear()).resolves.toBeUndefined();
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
                add: vi.fn().mockResolvedValue(undefined),
                clear: vi.fn().mockResolvedValue(undefined),
                close: vi.fn().mockResolvedValue(undefined),
            };
            primary = mockPrimary;
            hybrid = new HybridDedupCache(primary, fallback, true);
        });

        it('checks Redis first, then fallback', async () => {
            await hybrid.has('stream-1', 'evt-1');
            expect(vi.mocked(primary.has)).toHaveBeenCalledWith('stream-1', 'evt-1');
            await expect(fallback.has('stream-1', 'evt-1')).resolves.toBe(false);
        });

        it('returns true if found in Redis', async () => {
            vi.mocked(primary.has).mockResolvedValue(true);
            await expect(hybrid.has('stream-1', 'evt-1')).resolves.toBe(true);
        });

        it('adds to both caches', async () => {
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
    });
});

describe('DedupCache key format', () => {
    it('uses consistent key format for RedisDedupCache', async () => {
        const client = mockRedisClient();
        const cache = new RedisDedupCache(client);
        await cache.add('stream-abc', 'evt-xyz');
        expect(client.set).toHaveBeenCalledWith(
            'fluxora:dedup:stream-abc:evt-xyz',
            '1',
            expect.any(Object)
        );
    });
});