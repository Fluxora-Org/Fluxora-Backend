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
 *  - onStateChange callback — called false on errors, true on success
 *  - cross-instance replay — two store instances sharing one FakeRedisClient
 *  - close() — delegates to client.close() / clears InMemory / no-ops on NoOp
 *  - InMemoryIdempotencyStore full semantics
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RedisIdempotencyStore,
  NoOpIdempotencyStore,
  InMemoryIdempotencyStore,
  IDEMPOTENCY_KEY_PREFIX,
  ENVELOPE_VERSION,
  type IdempotentEntry,
} from '../../src/redis/idempotencyStore.js';
import { logger } from '../../src/logging/logger.js';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<IdempotentEntry> = {}): IdempotentEntry {
  return {
    version: ENVELOPE_VERSION,
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
    const parsed = JSON.parse(raw!);
    expect(parsed).toMatchObject(entry);
    expect(parsed.version).toBe(ENVELOPE_VERSION);
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
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const result = await store.get('key-err');
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Idempotency store'),
      expect.objectContaining({
        operation: 'get',
        keyLength: expect.any(Number),
        error: expect.any(String),
      }),
    );
    warnSpy.mockRestore();
  });

  it('silently no-ops and logs a warning when Redis set throws', async () => {
    fake.throwOnNext('set');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // Should not throw
    await expect(store.set('key-err', makeEntry(), 60)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Idempotency store'),
      expect.objectContaining({
        operation: 'set',
        keyLength: expect.any(Number),
        error: expect.any(String),
      }),
    );
    warnSpy.mockRestore();
  });

  it('subsequent get after a failed set returns null (no partial state)', async () => {
    fake.throwOnNext('set');
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await store.set('key-partial', makeEntry(), 60);
    const result = await store.get('key-partial');
    expect(result).toBeNull();
    vi.restoreAllMocks();
  });

  it('get still works after a previous set failure', async () => {
    // First set fails
    fake.throwOnNext('set');
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
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

  it('close() resolves without throwing', async () => {
    await expect(store.close()).resolves.toBeUndefined();
  });
});

// ── InMemoryIdempotencyStore ──────────────────────────────────────────────────

describe('InMemoryIdempotencyStore', () => {
  let store: InMemoryIdempotencyStore;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
  });

  it('returns null on cache miss', async () => {
    expect(await store.get('key-1')).toBeNull();
  });

  it('returns stored entry on cache hit', async () => {
    const entry = makeEntry();
    await store.set('key-1', entry, 60);
    expect(await store.get('key-1')).toEqual(entry);
  });

  it('ignores TTL parameter (in-memory, no expiry)', async () => {
    const entry = makeEntry();
    await store.set('key-ttl', entry, 1); // very short TTL is ignored
    expect(await store.get('key-ttl')).toEqual(entry);
  });

  it('close() clears all stored entries', async () => {
    await store.set('k1', makeEntry(), 60);
    await store.close();
    expect(await store.get('k1')).toBeNull();
  });
});

// ── RedisIdempotencyStore.onStateChange callback ──────────────────────────────

describe('RedisIdempotencyStore — onStateChange', () => {
  let fake: FakeRedisClient;
  let stateChanges: boolean[];
  let store: RedisIdempotencyStore;

  beforeEach(() => {
    fake = new FakeRedisClient();
    stateChanges = [];
    store = new RedisIdempotencyStore(fake, {
      onStateChange: (healthy) => stateChanges.push(healthy),
    });
  });

  it('calls onStateChange(true) after a successful get (cache miss)', async () => {
    await store.get('key-1');
    expect(stateChanges).toContain(true);
  });

  it('calls onStateChange(true) after a successful set', async () => {
    await store.set('key-1', makeEntry(), 60);
    expect(stateChanges).toContain(true);
  });

  it('calls onStateChange(false) when Redis get throws', async () => {
    fake.throwOnNext('get');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await store.get('key-err');
    expect(stateChanges).toContain(false);
    warnSpy.mockRestore();
  });

  it('calls onStateChange(false) when Redis set throws', async () => {
    fake.throwOnNext('set');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await store.set('key-err', makeEntry(), 60);
    expect(stateChanges).toContain(false);
    warnSpy.mockRestore();
  });

  it('recovers: onStateChange(true) fires on the next successful operation after a failure', async () => {
    fake.throwOnNext('get');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await store.get('key-fail'); // error → false
    warnSpy.mockRestore();
    await store.get('key-ok');   // success → true
    expect(stateChanges).toEqual([false, true]);
  });

  it('does not call onStateChange when no options are provided', async () => {
    const plainStore = new RedisIdempotencyStore(fake);
    // Should not throw
    await plainStore.set('k', makeEntry(), 60);
    await plainStore.get('k');
    // No assertion needed — absence of throw is sufficient
  });
});

// ── Logger injection ──────────────────────────────────────────────────────────

describe('RedisIdempotencyStore — structured logger', () => {
  let fake: FakeRedisClient;

  beforeEach(() => {
    fake = new FakeRedisClient();
  });

  it('calls logger.warn (not console.warn) on Redis get failure', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new RedisIdempotencyStore(fake);
    fake.throwOnNext('get');

    await store.get('key-err');

    expect(loggerWarnSpy).toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    loggerWarnSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('calls logger.warn (not console.warn) on Redis set failure', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new RedisIdempotencyStore(fake);
    fake.throwOnNext('set');

    await store.set('key-err', makeEntry(), 60);

    expect(loggerWarnSpy).toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    loggerWarnSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('uses the injected logger when provided via options', async () => {
    const mockLogger = { warn: vi.fn() };
    const store = new RedisIdempotencyStore(fake, { logger: mockLogger as unknown as typeof logger });
    fake.throwOnNext('get');

    await store.get('key-err');

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Idempotency store'),
      expect.objectContaining({ operation: 'get' }),
    );
  });

});

// ── RedisIdempotencyStore — envelope validation ───────────────────────────────

describe('RedisIdempotencyStore — envelope validation', () => {
  let fake: FakeRedisClient;
  let store: RedisIdempotencyStore;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fake = new FakeRedisClient();
    store = new RedisIdempotencyStore(fake);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  async function seedRaw(key: string, value: unknown) {
    await fake.set(`${IDEMPOTENCY_KEY_PREFIX}${key}`, JSON.stringify(value), { ex: 3600 });
  }

  it('returns null and warns on version mismatch (old version)', async () => {
    await seedRaw('k', { ...makeEntry(), version: 0 });
    expect(await store.get('k')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('envelope validation failed'),
      expect.objectContaining({ reason: expect.stringContaining('version mismatch') }),
    );
  });

  it('returns null and warns on future version', async () => {
    await seedRaw('k', { ...makeEntry(), version: ENVELOPE_VERSION + 1 });
    expect(await store.get('k')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('envelope validation failed'),
      expect.objectContaining({ reason: expect.stringContaining('version mismatch') }),
    );
  });

  it('returns null and warns when version field is missing', async () => {
    const { version: _v, ...noVersion } = makeEntry();
    await seedRaw('k', noVersion);
    expect(await store.get('k')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('envelope validation failed'),
      expect.objectContaining({ reason: 'missing version field' }),
    );
  });

  it('returns null and warns when requestFingerprint is missing', async () => {
    const { requestFingerprint: _fp, ...noFp } = makeEntry();
    await seedRaw('k', noFp);
    expect(await store.get('k')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('envelope validation failed'),
      expect.objectContaining({ reason: 'missing or invalid requestFingerprint' }),
    );
  });

  it('returns null and warns when statusCode is missing', async () => {
    const { statusCode: _sc, ...noSc } = makeEntry();
    await seedRaw('k', noSc);
    expect(await store.get('k')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('envelope validation failed'),
      expect.objectContaining({ reason: 'missing or invalid statusCode' }),
    );
  });

  it('returns null and warns when body is missing', async () => {
    const { body: _b, ...noBody } = makeEntry();
    await seedRaw('k', noBody);
    expect(await store.get('k')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('envelope validation failed'),
      expect.objectContaining({ reason: 'missing body' }),
    );
  });

  it('returns null and warns on malformed (non-object) JSON', async () => {
    await fake.set(`${IDEMPOTENCY_KEY_PREFIX}k`, '"just a string"', { ex: 3600 });
    expect(await store.get('k')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('envelope validation failed'),
      expect.objectContaining({ reason: 'envelope is not an object' }),
    );
  });

  it('returns null and warns on invalid JSON bytes', async () => {
    await fake.set(`${IDEMPOTENCY_KEY_PREFIX}k`, '{bad json}', { ex: 3600 });
    expect(await store.get('k')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('envelope validation failed'),
      expect.objectContaining({ reason: 'invalid JSON' }),
    );
  });

  it('stamps ENVELOPE_VERSION on every set()', async () => {
    const entry = makeEntry();
    await store.set('k', entry, 60);
    const raw = await fake.get(`${IDEMPOTENCY_KEY_PREFIX}k`);
    expect(JSON.parse(raw!).version).toBe(ENVELOPE_VERSION);
  });

  it('overwrites caller-supplied version with ENVELOPE_VERSION on set()', async () => {
    const entry = makeEntry({ version: 99 } as Partial<IdempotentEntry>);
    await store.set('k', entry, 60);
    const raw = await fake.get(`${IDEMPOTENCY_KEY_PREFIX}k`);
    expect(JSON.parse(raw!).version).toBe(ENVELOPE_VERSION);
  });

  it('returns the entry when the stored envelope is fully valid', async () => {
    const entry = makeEntry();
    await store.set('k', entry, 60);
    const result = await store.get('k');
    expect(result).not.toBeNull();
    expect(result?.requestFingerprint).toBe(entry.requestFingerprint);
    expect(result?.statusCode).toBe(entry.statusCode);
    expect(result?.version).toBe(ENVELOPE_VERSION);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ── RedisIdempotencyStore.close() ─────────────────────────────────────────────

describe('RedisIdempotencyStore — close()', () => {
  it('calls close() on the underlying Redis client', async () => {
    const fake = new FakeRedisClient();
    const closeSpy = vi.spyOn(fake, 'close');
    const store = new RedisIdempotencyStore(fake);
    await store.close();
    expect(closeSpy).toHaveBeenCalledOnce();
  });
});

// ── Cross-instance replay (two stores, one shared FakeRedisClient) ────────────

describe('RedisIdempotencyStore — cross-instance replay', () => {
  let sharedFake: FakeRedisClient;
  let instanceA: RedisIdempotencyStore;
  let instanceB: RedisIdempotencyStore;

  beforeEach(() => {
    sharedFake = new FakeRedisClient();
    instanceA = new RedisIdempotencyStore(sharedFake);
    instanceB = new RedisIdempotencyStore(sharedFake);
  });

  it('instance B replays a 201 written by instance A (same key + same body)', async () => {
    const entry = makeEntry({ statusCode: 201 });
    await instanceA.set('idem-key', entry, 86400);

    const replayed = await instanceB.get('idem-key');
    expect(replayed).not.toBeNull();
    expect(replayed?.statusCode).toBe(201);
    expect(replayed?.requestFingerprint).toBe(entry.requestFingerprint);
    expect(replayed?.body).toEqual(entry.body);
  });

  it('instance B detects a conflict (same key, different fingerprint) written by instance A', async () => {
    const entryA = makeEntry({ requestFingerprint: 'fp-from-instance-a' });
    await instanceA.set('conflict-key', entryA, 86400);

    const retrieved = await instanceB.get('conflict-key');
    // The route handler (not the store) enforces the 409 — the store just
    // returns the stored entry so the caller can compare fingerprints.
    expect(retrieved?.requestFingerprint).toBe('fp-from-instance-a');
  });

  it('instance A and B store to isolated keys', async () => {
    await instanceA.set('key-a', makeEntry({ requestFingerprint: 'fp-a' }), 60);
    await instanceB.set('key-b', makeEntry({ requestFingerprint: 'fp-b' }), 60);

    expect((await instanceA.get('key-b'))?.requestFingerprint).toBe('fp-b');
    expect((await instanceB.get('key-a'))?.requestFingerprint).toBe('fp-a');
  });

  it('TTL is forwarded correctly from config-derived value', async () => {
    const setSpy = vi.spyOn(sharedFake, 'set');
    const configTtl = 86400; // matches IDEMPOTENCY_TTL_SECONDS default
    await instanceA.set('key-ttl', makeEntry(), configTtl);
    expect(setSpy).toHaveBeenCalledWith(
      `${IDEMPOTENCY_KEY_PREFIX}key-ttl`,
      expect.any(String),
      { ex: configTtl },
    );
  });
});
