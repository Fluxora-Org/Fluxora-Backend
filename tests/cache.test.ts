/**
 * Cache layer tests — InMemoryCacheClient, NullCacheClient, key builders, TTL constants.
 *
 * These tests run without a real Redis instance. The InMemoryCacheClient is the
 * production-equivalent used in test environments; the NullCacheClient is the
 * graceful-degradation path when Redis is disabled.
 */

import {
  InMemoryCacheClient,
  NullCacheClient,
  CacheKey,
  TTL,
  setCacheClient,
  getCacheClient,
  resetCacheClient,
  CACHE_NS,
} from '../src/cache/redis.js';

// ---------------------------------------------------------------------------
// InMemoryCacheClient
// ---------------------------------------------------------------------------

describe('InMemoryCacheClient', () => {
  let cache: InMemoryCacheClient;

  beforeEach(() => {
    cache = new InMemoryCacheClient();
  });

  afterEach(async () => {
    await cache.quit();
  });

  describe('get / set', () => {
    it('returns null for missing key', async () => {
      expect(await cache.get('missing')).toBeNull();
    });

    it('stores and retrieves a value', async () => {
      await cache.set('k', { foo: 'bar' }, 60);
      expect(await cache.get('k')).toEqual({ foo: 'bar' });
    });

    it('returns null after TTL expires', async () => {
      await cache.set('k', 'value', 0); // 0 s TTL → already expired
      // Force expiry by setting expiresAt in the past
      await cache.set('k', 'value', -1);
      expect(await cache.get('k')).toBeNull();
    });

    it('handles primitive values', async () => {
      await cache.set('num', 42, 60);
      expect(await cache.get<number>('num')).toBe(42);
    });

    it('handles arrays', async () => {
      await cache.set('arr', [1, 2, 3], 60);
      expect(await cache.get<number[]>('arr')).toEqual([1, 2, 3]);
    });
  });

  describe('del', () => {
    it('removes a key', async () => {
      await cache.set('k', 'v', 60);
      await cache.del('k');
      expect(await cache.get('k')).toBeNull();
    });

    it('is a no-op for missing key', async () => {
      await expect(cache.del('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('delPattern', () => {
    it('removes keys matching a glob pattern', async () => {
      await cache.set('fluxora:stream:1', 'a', 60);
      await cache.set('fluxora:stream:2', 'b', 60);
      await cache.set('fluxora:other', 'c', 60);

      await cache.delPattern('fluxora:stream:*');

      expect(await cache.get('fluxora:stream:1')).toBeNull();
      expect(await cache.get('fluxora:stream:2')).toBeNull();
      expect(await cache.get('fluxora:other')).toBe('c');
    });

    it('is a no-op when no keys match', async () => {
      await cache.set('k', 'v', 60);
      await cache.delPattern('nomatch:*');
      expect(await cache.get('k')).toBe('v');
    });
  });

  describe('ping', () => {
    it('returns true', async () => {
      expect(await cache.ping()).toBe(true);
    });
  });

  describe('quit', () => {
    it('clears the store', async () => {
      await cache.set('k', 'v', 60);
      await cache.quit();
      expect(cache.size()).toBe(0);
    });
  });

  describe('size / clear helpers', () => {
    it('tracks store size', async () => {
      expect(cache.size()).toBe(0);
      await cache.set('a', 1, 60);
      await cache.set('b', 2, 60);
      expect(cache.size()).toBe(2);
    });

    it('clear empties the store', async () => {
      await cache.set('a', 1, 60);
      cache.clear();
      expect(cache.size()).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// NullCacheClient
// ---------------------------------------------------------------------------

describe('NullCacheClient', () => {
  const cache = new NullCacheClient();

  it('get always returns null', async () => {
    expect(await cache.get('k')).toBeNull();
  });

  it('set is a no-op', async () => {
    await expect(cache.set('k', 'v', 60)).resolves.toBeUndefined();
  });

  it('del is a no-op', async () => {
    await expect(cache.del('k')).resolves.toBeUndefined();
  });

  it('delPattern is a no-op', async () => {
    await expect(cache.delPattern('*')).resolves.toBeUndefined();
  });

  it('ping returns false', async () => {
    expect(await cache.ping()).toBe(false);
  });

  it('quit is a no-op', async () => {
    await expect(cache.quit()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CacheKey builders
// ---------------------------------------------------------------------------

describe('CacheKey', () => {
  it('stream key includes namespace and id', () => {
    expect(CacheKey.stream('abc-123')).toBe(`${CACHE_NS}stream:abc-123`);
  });

  it('streamList key is stable', () => {
    expect(CacheKey.streamList()).toBe(`${CACHE_NS}streams:list`);
  });
});

// ---------------------------------------------------------------------------
// TTL constants
// ---------------------------------------------------------------------------

describe('TTL', () => {
  it('STREAM is 30 seconds', () => {
    expect(TTL.STREAM).toBe(30);
  });

  it('STREAM_LIST is 60 seconds', () => {
    expect(TTL.STREAM_LIST).toBe(60);
  });

  it('HEALTH is 5 seconds', () => {
    expect(TTL.HEALTH).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

describe('cache singleton', () => {
  afterEach(() => {
    resetCacheClient();
  });

  it('getCacheClient returns NullCacheClient when not set', () => {
    resetCacheClient();
    const client = getCacheClient();
    expect(client).toBeInstanceOf(NullCacheClient);
  });

  it('setCacheClient replaces the singleton', async () => {
    const mem = new InMemoryCacheClient();
    setCacheClient(mem);
    const client = getCacheClient();
    await client.set('x', 1, 60);
    expect(await client.get('x')).toBe(1);
  });

  it('resetCacheClient clears the singleton', () => {
    setCacheClient(new InMemoryCacheClient());
    resetCacheClient();
    expect(getCacheClient()).toBeInstanceOf(NullCacheClient);
  });
});
