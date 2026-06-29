import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CircuitOpenError,
  StellarRpcService,
  type RawRpcClient,
} from '../../src/services/stellar-rpc.js';
import { createRpcDegradationMiddleware } from '../../src/middleware/rpcDegradation.js';
import {
  InMemoryRpcFallbackCache,
  RedisRpcFallbackCache,
  type RpcFallbackCache,
} from '../../src/redis/rpcFallbackCache.js';
import type { RedisClient } from '../../src/redis/client.js';
import {
  deRegisterRpcMetrics,
  fluxora_rpc_cache_corrupt_total,
  rpcFallbackCacheEarlyRefreshesTotal,
  rpcFallbackCacheHitsTotal,
  rpcFallbackCacheMissesTotal,
} from '../../src/metrics/rpcMetrics.js';

function makeClient(fn: () => Promise<{ sequence: number }>): RawRpcClient {
  return { getLatestLedger: fn };
}

describe('StellarRpcService fallback cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    deRegisterRpcMetrics();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes successful CLOSED responses to the fallback cache without reading it', async () => {
    const cache: RpcFallbackCache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    };
    const svc = new StellarRpcService(
      () => makeClient(vi.fn(async () => ({ sequence: 101 }))),
      { failureThreshold: 1, fallbackCache: cache, fallbackCacheTtlSeconds: 60 },
    );

    await expect(svc.getLatestLedger()).resolves.toEqual({ sequence: 101 });

    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledWith('getLatestLedger', { sequence: 101 }, 60, []);
    expect(svc.getCircuitState()).toBe('CLOSED');
  });

  it('serves cached data when the circuit is OPEN and the fallback cache hits', async () => {
    const cache = new InMemoryRpcFallbackCache();
    let shouldFail = false;
    const getLatestLedger = vi.fn(async () => {
      if (shouldFail) throw new Error('rpc down');
      return { sequence: 200 };
    });
    const svc = new StellarRpcService(
      () => makeClient(getLatestLedger),
      { failureThreshold: 1, resetTimeoutMs: 60_000, fallbackCache: cache, fallbackCacheTtlSeconds: 60 },
    );

    await expect(svc.getLatestLedger()).resolves.toEqual({ sequence: 200 });
    shouldFail = true;
    await expect(svc.getLatestLedger()).rejects.toThrow('rpc down');

    await expect(svc.getLatestLedger()).resolves.toEqual({ sequence: 200 });
    expect(getLatestLedger).toHaveBeenCalledTimes(2);
    expect(svc.getCircuitState()).toBe('OPEN');
  });

  it('propagates CircuitOpenError when the circuit is OPEN and the cache misses', async () => {
    const getLatestLedger = vi.fn(async () => {
      throw new Error('rpc down');
    });
    const svc = new StellarRpcService(
      () => makeClient(getLatestLedger),
      { failureThreshold: 1, resetTimeoutMs: 60_000, fallbackCache: new InMemoryRpcFallbackCache() },
    );

    await expect(svc.getLatestLedger()).rejects.toThrow('rpc down');
    await expect(svc.getLatestLedger()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(getLatestLedger).toHaveBeenCalledTimes(1);
  });

  it('uses a live HALF_OPEN probe instead of stale cache after reset timeout', async () => {
    const cache = new InMemoryRpcFallbackCache();
    let sequence = 300;
    let shouldFail = false;
    const getLatestLedger = vi.fn(async () => {
      if (shouldFail) throw new Error('rpc down');
      return { sequence };
    });
    const svc = new StellarRpcService(
      () => makeClient(getLatestLedger),
      { failureThreshold: 1, resetTimeoutMs: 1_000, fallbackCache: cache, fallbackCacheTtlSeconds: 60 },
    );

    await expect(svc.getLatestLedger()).resolves.toEqual({ sequence: 300 });
    shouldFail = true;
    await expect(svc.getLatestLedger()).rejects.toThrow('rpc down');

    vi.advanceTimersByTime(1_001);
    shouldFail = false;
    sequence = 301;

    await expect(svc.getLatestLedger()).resolves.toEqual({ sequence: 301 });
    expect(svc.getCircuitState()).toBe('CLOSED');
    expect(getLatestLedger).toHaveBeenCalledTimes(3);
  });

  it('treats expired fallback entries as misses', async () => {
    const cache = new InMemoryRpcFallbackCache();
    let shouldFail = false;
    const getLatestLedger = vi.fn(async () => {
      if (shouldFail) throw new Error('rpc down');
      return { sequence: 400 };
    });
    const svc = new StellarRpcService(
      () => makeClient(getLatestLedger),
      { failureThreshold: 1, resetTimeoutMs: 60_000, fallbackCache: cache, fallbackCacheTtlSeconds: 1 },
    );

    await expect(svc.getLatestLedger()).resolves.toEqual({ sequence: 400 });
    vi.advanceTimersByTime(1_001);
    shouldFail = true;
    await expect(svc.getLatestLedger()).rejects.toThrow('rpc down');

    await expect(svc.getLatestLedger()).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('isolates accountExists cache entries by hashed account parameter', async () => {
    const cache = new InMemoryRpcFallbackCache();
    const fetchMock = vi.fn(async (url: string) => ({
      status: url.endsWith('/GBEXISTS') ? 200 : 404,
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    let horizonUrl = 'https://horizon.test';
    const svc = new StellarRpcService(
      () => ({ getLatestLedger: vi.fn(), horizonUrl }),
      { failureThreshold: 1, resetTimeoutMs: 60_000, fallbackCache: cache, fallbackCacheTtlSeconds: 60 },
    );

    await expect(svc.accountExists('GBEXISTS')).resolves.toBe(true);
    horizonUrl = '';
    await expect(svc.accountExists('GDMISSING')).rejects.toThrow('horizonUrl not configured');

    await expect(svc.accountExists('GBEXISTS')).resolves.toBe(true);
    await expect(svc.accountExists('GDMISSING')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('sets X-RPC-Cache: stale on HTTP responses that use stale fallback data', async () => {
    const cache = new InMemoryRpcFallbackCache();
    let shouldFail = false;
    const getLatestLedger = vi.fn(async () => {
      if (shouldFail) throw new Error('rpc down');
      return { sequence: 500 };
    });
    const svc = new StellarRpcService(
      () => makeClient(getLatestLedger),
      { failureThreshold: 1, resetTimeoutMs: 60_000, fallbackCache: cache, fallbackCacheTtlSeconds: 60 },
    );

    await expect(svc.getLatestLedger()).resolves.toEqual({ sequence: 500 });
    shouldFail = true;
    await expect(svc.getLatestLedger()).rejects.toThrow('rpc down');

    const app = express();
    app.use(createRpcDegradationMiddleware(() => svc));
    app.get('/ledger', async (_req, res) => {
      res.json(await svc.getLatestLedger());
    });

    const res = await request(app).get('/ledger');

    expect(res.status).toBe(200);
    expect(res.headers['x-rpc-cache']).toBe('stale');
    expect(res.body).toEqual({ sequence: 500 });
  });

  it('stores cache metadata while preserving value reads', async () => {
    const cache = new InMemoryRpcFallbackCache();
    const svc = new StellarRpcService(
      () => makeClient(vi.fn(async () => ({ sequence: 600 }))),
      { fallbackCache: cache, fallbackCacheTtlSeconds: 60 },
    );

    await expect(svc.getLatestLedger()).resolves.toEqual({ sequence: 600 });

    await expect(cache.get('getLatestLedger')).resolves.toEqual({ sequence: 600 });
    const entry = await cache.getEntry<{ sequence: number }>('getLatestLedger');
    expect(entry?.value).toEqual({ sequence: 600 });
    expect(entry?.writtenAt).toBe(Date.now());
    expect(entry?.expiresAt).toBe(Date.now() + 60_000);
    expect(entry?.ttlSeconds).toBe(60);
    expect(entry?.refreshDurationMs).toBeGreaterThanOrEqual(1);
  });

  it('serves a CLOSED-cache hit and starts one probabilistic early refresh', async () => {
    const cache = new InMemoryRpcFallbackCache();
    await cache.setEntry(
      'getLatestLedger',
      { sequence: 700 },
      60,
      [],
      { nowMs: Date.now() - 59_500, refreshDurationMs: 1_000 },
    );
    let resolver: ((value: { sequence: number }) => void) | undefined;
    const getLatestLedger = vi.fn(() => new Promise<{ sequence: number }>((resolve) => {
      resolver = resolve;
    }));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(Number.EPSILON);
    const svc = new StellarRpcService(
      () => makeClient(getLatestLedger),
      { fallbackCache: cache, fallbackCacheTtlSeconds: 60, fallbackCacheEarlyExpiryBeta: 1 },
    );

    const first = await svc.getLatestLedger();
    const second = await svc.getLatestLedger();

    expect(first).toEqual({ sequence: 700 });
    expect(second).toEqual({ sequence: 700 });
    expect(getLatestLedger).toHaveBeenCalledTimes(1);

    resolver?.({ sequence: 701 });
    await vi.runAllTimersAsync();

    await expect(cache.get('getLatestLedger')).resolves.toEqual({ sequence: 701 });
    const hits = await rpcFallbackCacheHitsTotal.get();
    expect(hits.values[0]?.value).toBe(2);
    const refreshes = await rpcFallbackCacheEarlyRefreshesTotal.get();
    expect(refreshes.values[0]?.value).toBe(1);
    randomSpy.mockRestore();
  });

  it('records CLOSED-cache misses before the first live RPC fill', async () => {
    const cache = new InMemoryRpcFallbackCache();
    const getLatestLedger = vi.fn(async () => ({ sequence: 800 }));
    const svc = new StellarRpcService(
      () => makeClient(getLatestLedger),
      { fallbackCache: cache, fallbackCacheTtlSeconds: 60, fallbackCacheEarlyExpiryBeta: 1 },
    );

    await expect(svc.getLatestLedger()).resolves.toEqual({ sequence: 800 });

    const misses = await rpcFallbackCacheMissesTotal.get();
    expect(misses.values[0]?.labels).toEqual({ operation: 'getLatestLedger' });
    expect(misses.values[0]?.value).toBe(1);
  });
});

describe('rpcFallbackCache key collisions', () => {
  it('does not collide distinct (operation, parts[]) tuples', async () => {
    const cache = new InMemoryRpcFallbackCache();

    // These two tuples would collide under a naive delimiter-join strategy.
    // With the collision-resistant builder, they must map to distinct keys.

    // Build a tuple-pair that would collide under a naive delimiter-join
    // (operation/parts treated as raw, unescaped string segments).




    const operation1 = 'getLatestLedger';
    const parts1 = ['a', 'b'];

    const operation2 = 'getLatestLedger::a';
    const parts2 = ['b'];

    // Ensure safe inputs (avoid relying on delimiter-forging characters).
    expect(() => cache.setEntry(operation1, { v: 1 }, 60, parts1)).not.toThrow();
    expect(() => cache.setEntry(operation2, { v: 2 }, 60, parts2)).not.toThrow();

    await cache.setEntry(operation1, { v: 1 }, 60, parts1);
    await cache.setEntry(operation2, { v: 2 }, 60, parts2);

    await expect(cache.get<{ v: number }>(operation1, parts1)).resolves.toEqual({ v: 1 });
    await expect(cache.get<{ v: number }>(operation2, parts2)).resolves.toEqual({ v: 2 });

    // Cross-tuple reads must miss.
    await expect(cache.get<{ v: number }>(operation1, parts2)).resolves.toBeNull();
    await expect(cache.get<{ v: number }>(operation2, parts1)).resolves.toBeNull();
  });

  it('rejects unsafe key parts under SAFE_OPERATION', async () => {
    const cache = new InMemoryRpcFallbackCache();

    // ':' is not allowed by SAFE_OPERATION
    await expect(cache.setEntry('getLatestLedger', { v: 1 }, 60, ['bad:part'])).rejects.toThrow(
      /unsafe characters/i,
    );
  });
});

describe('corrupt cache entries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fluxora_rpc_cache_corrupt_total.reset();
  });

  it('returns null and deletes key and increments counter for empty string value', async () => {
    const fakeRedis: RedisClient = {
      get: vi.fn().mockResolvedValue(''),
      set: vi.fn(),
      setNx: vi.fn(),
      del: vi.fn(),
      exists: vi.fn(),
      close: vi.fn(),
      multi: vi.fn(),
      zcount: vi.fn(),
    };
    const cache = new RedisRpcFallbackCache(fakeRedis);

    const result = await cache.get('testOp');

    expect(result).toBeNull();
    expect(fakeRedis.del).toHaveBeenCalledWith(expect.stringContaining('testOp'));
    expect(cache.corruptEntriesTotal).toBe(1);
    
    const metric = await fluxora_rpc_cache_corrupt_total.get();
    expect(metric.values[0]?.value).toBe(1);
    expect(metric.values[0]?.labels).toEqual({ operation: 'unknown', reason: 'syntax_error' });
  });

  it('returns null and deletes key and increments counter for truncated JSON', async () => {
    const fakeRedis: RedisClient = {
      get: vi.fn().mockResolvedValue('{"key":'),
      set: vi.fn(),
      setNx: vi.fn(),
      del: vi.fn(),
      exists: vi.fn(),
      close: vi.fn(),
      multi: vi.fn(),
      zcount: vi.fn(),
    };
    const cache = new RedisRpcFallbackCache(fakeRedis);

    const result = await cache.get('testOp');

    expect(result).toBeNull();
    expect(fakeRedis.del).toHaveBeenCalledWith(expect.stringContaining('testOp'));
    expect(cache.corruptEntriesTotal).toBe(1);

    const metric = await fluxora_rpc_cache_corrupt_total.get();
    expect(metric.values[0]?.value).toBe(1);
    expect(metric.values[0]?.labels).toEqual({ operation: 'unknown', reason: 'syntax_error' });
  });

  it('returns null and deletes key and increments counter for valid JSON with wrong shape', async () => {
    const fakeRedis: RedisClient = {
      get: vi.fn().mockResolvedValue('{"sequence": 123}'), // Missing envelope
      set: vi.fn(),
      setNx: vi.fn(),
      del: vi.fn(),
      exists: vi.fn(),
      close: vi.fn(),
      multi: vi.fn(),
      zcount: vi.fn(),
    };
    const cache = new RedisRpcFallbackCache(fakeRedis);

    const result = await cache.get('testOp');

    expect(result).toBeNull();
    expect(fakeRedis.del).toHaveBeenCalledWith(expect.stringContaining('testOp'));
    expect(cache.corruptEntriesTotal).toBe(1);

    const metric = await fluxora_rpc_cache_corrupt_total.get();
    expect(metric.values[0]?.value).toBe(1);
    expect(metric.values[0]?.labels).toEqual({ operation: 'unknown', reason: 'wrong_shape' });
  });

  it('does not swallow Redis transport errors', async () => {
    const fakeRedis: RedisClient = {
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      set: vi.fn(),
      setNx: vi.fn(),
      del: vi.fn(),
      exists: vi.fn(),
      close: vi.fn(),
      multi: vi.fn(),
      zcount: vi.fn(),
    };
    const cache = new RedisRpcFallbackCache(fakeRedis);

    await expect(cache.get('testOp')).rejects.toThrow('ECONNREFUSED');
    expect(cache.corruptEntriesTotal).toBe(0);
  });
});
