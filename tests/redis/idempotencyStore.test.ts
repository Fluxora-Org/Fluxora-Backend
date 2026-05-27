/**
 * Tests for src/redis/idempotencyStore.ts
 *
 * Covers:
 *  - cache miss (first request)
 *  - cache hit (duplicate request / replay)
 *  - TTL is forwarded to the Redis client
 *  - Redis get failure → graceful degradation (returns null, logs warning)
 *  - Redis set failure → graceful degradation (silently no-ops, logs warning)
 *  - NoOpIdempotencyStore always returns null / never throws
 *  - Key namespacing (fluxora:idempotency: prefix)
 *  - Serialisation round-trip preserves status code and body exactly
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RedisIdempotencyStore,
  NoOpIdempotencyStore,
  IDEMPOTENCY_KEY_PREFIX,
  type IdempotentEntry,
} from '../../src/redis/idempotencyStore.js';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<IdempotentEntry> = {}): IdempotentEntry {
  return {
    requestFingerprint: 'fp-abc123',
    statusCode: 201,
    body: { data: { id: 'stream-1', status: 'active' }, meta: {} },
    ...overrides,
  };
}

// ── RedisIdempotencyStore ─────────────────────────────────────────────────────

describe('RedisIdempotencyStore', () => {
  let fake: FakeRedisClient;
  let store: RedisIdempotencyStore;

  beforeEach(() => {
    fake = new FakeRedisClient();
    store = new RedisIdempotencyStore(fake);
  });

  it('returns null on cache miss', async () => {
    const result = await store.get('key-1');
    expect(result).toBeNull();
  });

  it('returns the stored entry on cache hit', async () => {
    const entry = makeEntry();
    await store.set('key-1', entry, 3600);
    const result = await store.get('key-1');
    expect(result).toEqual(entry);
  });

  it('preserves status code and body exactly through serialisation round-trip', async () => {
    const entry = makeEntry({ statusCode: 201, body: { data: { id: 'stream-xyz' }, meta: { requestId: 'r1' } } });
    await store.set('key-2', entry, 60);
    const result = await store.get('key-2');
    expect(result?.statusCode).toBe(201);
    expect(result?.body).toEqual(entry.body);
    expect(result?.requestFingerprint).toBe(entry.requestFingerprint);
  });

  it('stores under the namespaced key (fluxora:idempotency: prefix)', async () => {
    const entry = makeEntry();
    await store.set('my-key', entry, 100);
    // Access the fake's internal string store via get() to confirm the prefix
    const raw = await fake.get(`${IDEMPOTENCY_KEY_PREFIX}my-key`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(entry);
  });

  it('forwards the TTL to the Redis client', async () => {
    const setSpy = vi.spyOn(fake, 'set');
    const entry = makeEntry();
    await store.set('key-ttl', entry, 7200);
    expect(setSpy).toHaveBeenCalledWith(
      `${IDEMPOTENCY_KEY_PREFIX}key-ttl`,
      expect.any(String),
      { ex: 7200 },
    );
  });

  it('different keys are independent', async () => {
    const e1 = makeEntry({ requestFingerprint: 'fp-1' });
    const e2 = makeEntry({ requestFingerprint: 'fp-2' });
    await store.set('key-a', e1, 60);
    await store.set('key-b', e2, 60);
    expect((await store.get('key-a'))?.requestFingerprint).toBe('fp-1');
    expect((await store.get('key-b'))?.requestFingerprint).toBe('fp-2');
  });

  // ── Graceful degradation ──────────────────────────────────────────────────

  it('returns null and logs a warning when Redis get throws', async () => {
    fake.throwOnNext('get');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await store.get('key-err');
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[IdempotencyStore]'),
      expect.objectContaining({ keyLength: expect.any(Number) }),
    );
    warnSpy.mockRestore();
  });

  it('silently no-ops and logs a warning when Redis set throws', async () => {
    fake.throwOnNext('set');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Should not throw
    await expect(store.set('key-err', makeEntry(), 60)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[IdempotencyStore]'),
      expect.objectContaining({ keyLength: expect.any(Number) }),
    );
    warnSpy.mockRestore();
  });

  it('subsequent get after a failed set returns null (no partial state)', async () => {
    fake.throwOnNext('set');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store.set('key-partial', makeEntry(), 60);
    const result = await store.get('key-partial');
    expect(result).toBeNull();
    vi.restoreAllMocks();
  });

  it('get still works after a previous set failure', async () => {
    // First set fails
    fake.throwOnNext('set');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store.set('key-recover', makeEntry({ requestFingerprint: 'fp-fail' }), 60);

    // Second set succeeds
    const entry2 = makeEntry({ requestFingerprint: 'fp-ok' });
    await store.set('key-recover', entry2, 60);
    const result = await store.get('key-recover');
    expect(result?.requestFingerprint).toBe('fp-ok');
    vi.restoreAllMocks();
  });
});

// ── NoOpIdempotencyStore ──────────────────────────────────────────────────────

describe('NoOpIdempotencyStore', () => {
  const store = new NoOpIdempotencyStore();

  it('get always returns null', async () => {
    expect(await store.get('any-key')).toBeNull();
  });

  it('set resolves without throwing', async () => {
    await expect(store.set('any-key', makeEntry(), 3600)).resolves.toBeUndefined();
  });

  it('get after set still returns null (pass-through semantics)', async () => {
    await store.set('key-x', makeEntry(), 60);
    expect(await store.get('key-x')).toBeNull();
  });
});
