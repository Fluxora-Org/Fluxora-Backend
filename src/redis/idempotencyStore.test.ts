import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RedisClient } from './client.js';
import { InMemoryIdempotencyStore, RedisIdempotencyStore } from './idempotencyStore.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('idempotency store expiry and availability', () => {
  it('expires a response at the original lock deadline', async () => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const store = new InMemoryIdempotencyStore();

    expect(await store.start('request-key', 'tenant-a', 5)).toBe(true);
    now = 4_000;
    await store.set('request-key', 'tenant-a', {
      version: 1,
      requestFingerprint: 'fingerprint',
      statusCode: 201,
      body: { id: 'resource' },
    }, 5);

    now = 5_099;
    expect(await store.get('request-key', 'tenant-a')).not.toBeNull();
    now = 5_100;
    expect(await store.get('request-key', 'tenant-a')).toBeNull();

    now = 6_000;
    expect(await store.start('late-request', 'tenant-a', 1)).toBe(true);
    now = 7_000;
    await store.set('late-request', 'tenant-a', {
      version: 1,
      requestFingerprint: 'fingerprint',
      statusCode: 201,
      body: { id: 'late-resource' },
    }, 5);
    expect(await store.get('late-request', 'tenant-a')).toBeNull();
  });

  it('writes Redis responses with only the remaining lock lifetime', async () => {
    let now = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const client = {
      setNx: vi.fn().mockResolvedValue(true),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as RedisClient;
    const store = new RedisIdempotencyStore(client);
    const entry = {
      version: 1,
      requestFingerprint: 'fingerprint',
      statusCode: 201,
      body: { id: 'resource' },
    };

    expect(await store.start('request-key', 'tenant-a', 5)).toBe(true);
    now = 2_100;
    await store.set('request-key', 'tenant-a', entry, 5);
    expect(client.set).toHaveBeenCalledWith(
      'fluxora:idempotency:tenant-a:request-key',
      expect.any(String),
      { pxat: 5_100 },
    );

    expect(await store.start('expired-key', 'tenant-a', 1)).toBe(true);
    now += 1_000;
    vi.mocked(client.set).mockClear();
    await store.set('expired-key', 'tenant-a', entry, 1);
    expect(client.set).not.toHaveBeenCalled();
  });

  it('fails open at the adapter boundary and reports Redis unavailability', async () => {
    const onStateChange = vi.fn();
    const client = {
      setNx: vi.fn().mockRejectedValue(new Error('redis unavailable')),
      get: vi.fn().mockRejectedValue(new Error('redis unavailable')),
      set: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as RedisClient;
    const store = new RedisIdempotencyStore(client, { onStateChange });

    expect(await store.start('request-key', 'tenant-a', 5)).toBe(true);
    expect(await store.get('request-key', 'tenant-a')).toBeNull();
    await expect(store.set('request-key', 'tenant-a', {
      version: 1,
      requestFingerprint: 'fingerprint',
      statusCode: 201,
      body: {},
    }, 5)).resolves.toBeUndefined();
    expect(onStateChange).toHaveBeenNthCalledWith(1, false);
    expect(onStateChange).toHaveBeenNthCalledWith(2, false);
    expect(onStateChange).toHaveBeenNthCalledWith(3, false);
  });
});
