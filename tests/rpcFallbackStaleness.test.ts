import { describe, it, expect, vi, afterEach } from 'vitest';

// `../src/config/env.js` has pre-existing, unrelated breakage (present on
// upstream `main` too) that crashes on import. Mocking it here keeps this
// test isolated to the fallback-staleness behavior under test (issue #1434)
// regardless of that unrelated issue.
vi.mock('../src/config/env.js', () => ({ getConfig: () => ({}) }));

import {
  StellarRpcService,
  RpcFallbackExhaustedError,
  CircuitOpenError,
  getRpcRequestCacheStatus,
  getRpcRequestCacheAgeMs,
  runWithRpcRequestMetadata,
} from '../src/services/stellar-rpc.js';
import { InMemoryRpcFallbackCache } from '../src/redis/rpcFallbackCache.js';

function makeClient(ledgerFn: () => Promise<{ sequence: number }>) {
  return () => ({
    getLatestLedger: ledgerFn,
    horizonUrl: 'https://horizon.example.com',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RPC fallback staleness (issue #1434)', () => {
  it('marks a served fallback response as stale and exposes its age to the caller', async () => {
    const cache = new InMemoryRpcFallbackCache();
    let failing = false;
    const svc = new StellarRpcService(
      makeClient(async () => {
        if (failing) throw new Error('ECONNREFUSED');
        return { sequence: 1 };
      }),
      {
        fallbackCache: cache,
        failureThreshold: 1,
        windowMs: 10_000,
        resetTimeoutMs: 60_000,
        fallbackCacheMaxAgeMs: 60_000,
      },
    );

    // Prime the cache with a real success.
    await svc.getLatestLedger();

    // Trip the breaker so subsequent calls hit the OPEN path.
    failing = true;
    await expect(svc.getLatestLedger()).rejects.toThrow();

    await runWithRpcRequestMetadata(async () => {
      const result = await svc.getLatestLedger();
      expect(result).toEqual({ sequence: 1 });
      expect(getRpcRequestCacheStatus()).toBe('stale');
      expect(getRpcRequestCacheAgeMs()).toBeGreaterThanOrEqual(0);
      expect(getRpcRequestCacheAgeMs()).toBeLessThan(60_000);
    });
  });

  it('refuses to serve a fallback entry older than the configured maximum age', async () => {
    const cache = new InMemoryRpcFallbackCache();
    let failing = false;
    const svc = new StellarRpcService(
      makeClient(async () => {
        if (failing) throw new Error('ECONNREFUSED');
        return { sequence: 1 };
      }),
      {
        fallbackCache: cache,
        failureThreshold: 1,
        windowMs: 10_000,
        resetTimeoutMs: 60_000,
        // Age the entry out immediately.
        fallbackCacheMaxAgeMs: 1,
      },
    );

    await svc.getLatestLedger();
    // Ensure at least 1ms has elapsed since the write.
    await new Promise((r) => setTimeout(r, 5));

    failing = true;
    await expect(svc.getLatestLedger()).rejects.toThrow();

    let err: unknown;
    try {
      await svc.getLatestLedger();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RpcFallbackExhaustedError);
    expect((err as RpcFallbackExhaustedError).ageMs).toBeGreaterThanOrEqual(1);
    expect((err as RpcFallbackExhaustedError).maxAgeMs).toBe(1);
  });

  it('throws the original CircuitOpenError-derived error on a genuine cache miss', async () => {
    const cache = new InMemoryRpcFallbackCache();
    const svc = new StellarRpcService(
      makeClient(async () => {
        throw new Error('ECONNREFUSED');
      }),
      {
        fallbackCache: cache,
        failureThreshold: 1,
        windowMs: 10_000,
        resetTimeoutMs: 60_000,
      },
    );

    await expect(svc.getLatestLedger()).rejects.toThrow();
    await expect(svc.getLatestLedger()).rejects.not.toThrow(RpcFallbackExhaustedError);
  });
});