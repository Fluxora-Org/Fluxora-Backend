/**
 * Contract tests for `src/redis/rateLimitStore.ts`.
 *
 * These assert the documented behaviour of the store backing the rate limiter:
 *
 *   - The window is **sliding**, not fixed: a burst at the end of one window
 *     plus a burst at the start of the next cannot exceed the configured limit.
 *   - Entries **cannot outlive** their documented lifetime — at the expiry
 *     boundary they are no longer counted (and, for Redis, the key is gone).
 *   - When the store is **unavailable** (Redis error / closed store) the
 *     `HybridStore` falls back to the always-available in-memory sliding
 *     window and keeps enforcing the limit.
 *
 * Time is driven with fake timers so boundary behaviour is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HybridStore,
  InMemoryStore,
  SlidingWindowStore,
} from '../../src/redis/rateLimitStore.js';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';
import type { RateLimitStore } from '../../src/types/rateLimit.js';

/** A wall-clock base that is an exact multiple of the 1 s windows used here. */
const BASE = 1_700_000_000_000;
const WINDOW_MS = 1_000;

describe('SlidingWindowStore — sliding window contract', () => {
  let client: FakeRedisClient;
  let store: SlidingWindowStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    client = new FakeRedisClient();
    store = new SlidingWindowStore(client);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts only requests inside the trailing window (sliding, not fixed)', async () => {
    const limit = 2;

    await store.increment('principal:route', WINDOW_MS, limit); // t = BASE
    vi.setSystemTime(BASE + WINDOW_MS - 1);
    const second = await store.increment('principal:route', WINDOW_MS, limit);
    expect(second.count).toBe(2);

    // A fixed window anchored at the first request would reset its counter
    // here and admit a fresh burst. The sliding window does not: the request
    // at BASE has left the window, but the one at BASE+999 has not.
    vi.setSystemTime(BASE + WINDOW_MS);
    const boundary = await store.increment('principal:route', WINDOW_MS, limit);
    expect(boundary.count).toBe(2);
    expect(boundary.count).not.toBe(1);

    // One millisecond later the trailing window contains three requests, so
    // the limit is exceeded rather than doubled from a clean slate.
    vi.setSystemTime(BASE + WINDOW_MS + 1);
    const overLimit = await store.increment('principal:route', WINDOW_MS, limit);
    expect(overLimit.count).toBe(3);
    expect(overLimit.count).toBeGreaterThan(limit);
  });

  it('does not count an entry past the documented window boundary and lets the key expire', async () => {
    const redisKey = 'fluxora:rl:principal_route';
    await store.increment('principal:route', WINDOW_MS, 10); // t = BASE
    expect(client.getTtl(redisKey)).toBe(WINDOW_MS);

    vi.setSystemTime(BASE + WINDOW_MS - 1);
    expect((await store.getCount('principal:route', WINDOW_MS)).count).toBe(1);

    // At the boundary the PEXPIRE deadline is reached: the key is gone and the
    // entry can no longer be counted or observed.
    vi.setSystemTime(BASE + WINDOW_MS);
    expect((await store.getCount('principal:route', WINDOW_MS)).count).toBe(0);
    expect(client.getTtl(redisKey)).toBeUndefined();
  });

  it('refreshes the lifetime so the key cannot outlive one window of inactivity', async () => {
    const redisKey = 'fluxora:rl:principal_route';
    await store.increment('principal:route', WINDOW_MS, 10); // expiry BASE + WINDOW

    vi.setSystemTime(BASE + WINDOW_MS / 2);
    await store.increment('principal:route', WINDOW_MS, 10); // expiry refreshed

    // The original deadline has passed, but the refreshed key is still alive...
    vi.setSystemTime(BASE + WINDOW_MS + 1);
    expect((await store.getCount('principal:route', WINDOW_MS)).count).toBe(1);
    expect(client.getTtl(redisKey)).toBe(WINDOW_MS);

    // ...and the stale member is pruned by score, so it is not counted.
    expect((await store.getCount('principal:route', WINDOW_MS)).count).toBe(1);
  });

  it('reports the store as unavailable (throws) after close', async () => {
    await store.close();
    await expect(store.increment('principal:route', WINDOW_MS, 10)).rejects.toThrow(
      'SlidingWindowStore is closed',
    );
    await expect(store.getCount('principal:route', WINDOW_MS)).rejects.toThrow(
      'SlidingWindowStore is closed',
    );
  });
});

describe('InMemoryStore — sliding window contract', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    store = new InMemoryStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not permit twice the limit across a window boundary', async () => {
    const limit = 2;

    await store.increment('principal:route', WINDOW_MS, limit);
    vi.setSystemTime(BASE + WINDOW_MS - 1);
    expect((await store.increment('principal:route', WINDOW_MS, limit)).count).toBe(2);

    vi.setSystemTime(BASE + WINDOW_MS);
    const boundary = await store.increment('principal:route', WINDOW_MS, limit);
    expect(boundary.count).toBe(2);
    expect(boundary.count).not.toBe(1);

    vi.setSystemTime(BASE + WINDOW_MS + 1);
    const overLimit = await store.increment('principal:route', WINDOW_MS, limit);
    expect(overLimit.count).toBeGreaterThan(limit);
  });

  it('drops entries at the documented expiry boundary', async () => {
    await store.increment('principal:route', WINDOW_MS, 10);
    vi.setSystemTime(BASE + WINDOW_MS - 1);
    expect((await store.getCount('principal:route', WINDOW_MS)).count).toBe(1);

    vi.setSystemTime(BASE + WINDOW_MS);
    const expired = await store.getCount('principal:route', WINDOW_MS);
    expect(expired.count).toBe(0);
    expect(expired.resetAt).toBeGreaterThan(BASE + WINDOW_MS);
  });

  it('releases all state on close', async () => {
    await store.increment('principal:route', WINDOW_MS, 10);
    await store.close();
    expect((await store.getCount('principal:route', WINDOW_MS)).count).toBe(0);
  });
});

describe('HybridStore — behaviour when the store is unavailable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function unavailablePrimary(): RateLimitStore {
    return {
      async increment() {
        throw new Error('Redis down');
      },
      async getCount() {
        throw new Error('Redis down');
      },
      async close() {},
    };
  }

  it('delegates to the in-memory sliding window and keeps enforcing the limit', async () => {
    const errors: string[] = [];
    const fallback = new InMemoryStore();
    const hybrid = new HybridStore(unavailablePrimary(), fallback, (_err, op) =>
      errors.push(op),
    );

    expect(hybrid.usingFallback).toBe(false);
    expect((await hybrid.increment('principal:route', WINDOW_MS, 2)).count).toBe(1);
    expect(hybrid.usingFallback).toBe(true);
    expect(errors).toContain('increment');

    // The fallback is a genuine sliding window, not a fixed one.
    vi.setSystemTime(BASE + WINDOW_MS - 1);
    expect((await hybrid.increment('principal:route', WINDOW_MS, 2)).count).toBe(2);
    vi.setSystemTime(BASE + WINDOW_MS);
    expect((await hybrid.increment('principal:route', WINDOW_MS, 2)).count).toBe(2);

    // Once the window has fully elapsed the fallback resets.
    vi.setSystemTime(BASE + 2 * WINDOW_MS);
    expect((await hybrid.increment('principal:route', WINDOW_MS, 2)).count).toBe(1);
  });

  it('falls back for reads too and reports degraded operation', async () => {
    const fallback = new InMemoryStore();
    await fallback.increment('principal:route', WINDOW_MS, 5);
    const hybrid = new HybridStore(unavailablePrimary(), fallback, () => {});

    const result = await hybrid.getCount('principal:route', WINDOW_MS);
    expect(result.count).toBe(1);
    expect(hybrid.usingFallback).toBe(true);
  });
});
