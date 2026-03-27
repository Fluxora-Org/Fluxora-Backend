import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  InMemoryCacheClient,
  NullCacheClient,
  RedisCacheClient,
  CacheKey,
  TTL,
  CACHE_NS,
  setCacheClient,
  getCacheClient,
  resetCacheClient,
} from './redis.js';

describe('InMemoryCacheClient', () => {
  let cache: InMemoryCacheClient;

  beforeEach(() => { cache = new InMemoryCacheClient(); });
  afterEach(async () => { await cache.quit(); });

  it('returns null for missing key', async () => {
    expect(await cache.get('missing')).toBeNull();
  });

  it('stores and retrieves a value', async () => {
    await cache.set('k', { x: 1 }, 60);
    expect(await cache.get('k')).toEqual({ x: 1 });
  });

  it('returns null after TTL expires (negative TTL)', async () => {
    await cache.set('k', 'v', -1);
    expect(await cache.get('k')).toBeNull();
  });

  it('handles primitive values', async () => {
    await cache.set('n', 42, 60);
    expect(await cache.get<number>('n')).toBe(42);
  });

  it('del removes a key', async () => {
    await cache.set('k', 'v', 60);
    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  it('del is a no-op for missing key', async () => {
    await expect(cache.del('nope')).resolves.toBeUndefined();
  });

  it('delPattern removes matching keys', async () => {
    await cache.set('fluxora:stream:1', 'a', 60);
    await cache.set('fluxora:stream:2', 'b', 60);
    await cache.set('fluxora:other', 'c', 60);
    await cache.delPattern('fluxora:stream:*');
    expect(await cache.get('fluxora:stream:1')).toBeNull();
    expect(await cache.get('fluxora:stream:2')).toBeNull();
    expect(await cache.get('fluxora:other')).toBe('c');
  });

  it('delPattern no-op when no match', async () => {
    await cache.set('k', 'v', 60);
    await cache.delPattern('nomatch:*');
    expect(await cache.get('k')).toBe('v');
  });

  it('ping returns true', async () => {
    expect(await cache.ping()).toBe(true);
  });

  it('quit clears the store', async () => {
    await cache.set('k', 'v', 60);
    await cache.quit();
    expect(cache.size()).toBe(0);
  });

  it('clear empties the store', async () => {
    await cache.set('a', 1, 60);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('size tracks entries', async () => {
    expect(cache.size()).toBe(0);
    await cache.set('a', 1, 60);
    expect(cache.size()).toBe(1);
  });
});

describe('NullCacheClient', () => {
  const cache = new NullCacheClient();

  it('get returns null', async () => { expect(await cache.get('k')).toBeNull(); });
  it('set is no-op', async () => { await expect(cache.set('k', 'v', 60)).resolves.toBeUndefined(); });
  it('del is no-op', async () => { await expect(cache.del('k')).resolves.toBeUndefined(); });
  it('delPattern is no-op', async () => { await expect(cache.delPattern('*')).resolves.toBeUndefined(); });
  it('ping returns false', async () => { expect(await cache.ping()).toBe(false); });
  it('quit is no-op', async () => { await expect(cache.quit()).resolves.toBeUndefined(); });
});

describe('RedisCacheClient', () => {
  it('can be instantiated without connecting', () => {
    // Construction is now lazy — no require/import at construction time
    const client = new RedisCacheClient('redis://localhost:6379');
    expect(client).toBeDefined();
  });
});

describe('CacheKey builders', () => {
  it('stream key includes namespace and id', () => {
    expect(CacheKey.stream('abc')).toBe(`${CACHE_NS}stream:abc`);
  });

  it('streamList key is stable', () => {
    expect(CacheKey.streamList()).toBe(`${CACHE_NS}streams:list`);
  });
});

describe('TTL constants', () => {
  it('STREAM is 30', () => { expect(TTL.STREAM).toBe(30); });
  it('STREAM_LIST is 60', () => { expect(TTL.STREAM_LIST).toBe(60); });
  it('HEALTH is 5', () => { expect(TTL.HEALTH).toBe(5); });
});

describe('cache singleton', () => {
  afterEach(() => { resetCacheClient(); });

  it('getCacheClient returns NullCacheClient when not set', () => {
    resetCacheClient();
    expect(getCacheClient()).toBeInstanceOf(NullCacheClient);
  });

  it('setCacheClient replaces the singleton', async () => {
    const mem = new InMemoryCacheClient();
    setCacheClient(mem);
    await getCacheClient().set('x', 1, 60);
    expect(await getCacheClient().get('x')).toBe(1);
  });

  it('resetCacheClient clears the singleton', () => {
    setCacheClient(new InMemoryCacheClient());
    resetCacheClient();
    expect(getCacheClient()).toBeInstanceOf(NullCacheClient);
  });
});
