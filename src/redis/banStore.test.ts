import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  sanitiseIp,
  InMemoryBanStore,
  RedisBanStore,
  HybridBanStore,
  createBanStore,
  BAN_KEY_PREFIX,
} from './banStore.js';
import type { RedisClient } from './client.js';

describe('banStore - sanitiseIp', () => {
  it('returns unknown for empty string', () => {
    expect(sanitiseIp('')).toBe('unknown');
  });

  it('returns unknown for undefined', () => {
    expect(sanitiseIp(undefined as unknown as string)).toBe('unknown');
  });

  it('returns unknown for null', () => {
    expect(sanitiseIp(null as unknown as string)).toBe('unknown');
  });

  it('produces deterministic hash for same input', () => {
    const ip = '192.168.1.1';
    expect(sanitiseIp(ip)).toBe(sanitiseIp(ip));
  });

  it('produces different hashes for different inputs', () => {
    expect(sanitiseIp('192.168.1.1')).not.toBe(sanitiseIp('192.168.1.2'));
    expect(sanitiseIp('10.0.0.1')).not.toBe(sanitiseIp('10.0.0.2'));
  });

  it('handles IPv6 addresses', () => {
    const ipv6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
    const hash = sanitiseIp(ipv6);
    expect(hash).toHaveLength(64);
    expect(sanitiseIp(ipv6)).toBe(hash);
  });

  it('handles IPv4 addresses', () => {
    const ipv4 = '192.168.1.1';
    const hash = sanitiseIp(ipv4);
    expect(hash).toHaveLength(64);
    expect(sanitiseIp(ipv4)).toBe(hash);
  });

  it('handles CIDR notation', () => {
    const cidr = '192.168.1.0/24';
    const hash = sanitiseIp(cidr);
    expect(hash).toHaveLength(64);
    expect(sanitiseIp(cidr)).toBe(hash);
  });

  it('prevents collision: two distinct long inputs sharing 256-char prefix produce different ban keys', () => {
    const prefix = 'A'.repeat(256);
    const input1 = prefix + '1';
    const input2 = prefix + '2';

    const key1 = sanitiseIp(input1);
    const key2 = sanitiseIp(input2);

    expect(key1).not.toBe(key2);
    expect(key1).toHaveLength(64);
    expect(key2).toHaveLength(64);
  });

  it('prevents collision: multiple distinct long inputs with same prefix produce unique keys', () => {
    const prefix = 'X'.repeat(256);
    const inputs = [
      prefix + 'a',
      prefix + 'b',
      prefix + 'c',
      prefix + 'different_suffix_1',
      prefix + 'different_suffix_2',
      prefix + 'another_very_long_suffix_that_exceeds_256_characters_by_quite_a_bit_to_ensure_no_collision_possible',
    ];

    const keys = inputs.map(sanitiseIp);
    const uniqueKeys = new Set(keys);

    expect(uniqueKeys.size).toBe(inputs.length);
    keys.forEach((key) => {
      expect(key).toHaveLength(64);
    });
  });

  it('hash is SHA-256 (64 hex chars)', () => {
    const hash = sanitiseIp('test');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not truncate - long inputs produce full hash', () => {
    const longInput = 'A'.repeat(1000);
    const hash = sanitiseIp(longInput);
    expect(hash).toHaveLength(64);
  });
});

describe('banStore - InMemoryBanStore', () => {
  let store: InMemoryBanStore;

  beforeEach(() => {
    store = new InMemoryBanStore();
  });

  it('returns not banned for unknown IP', async () => {
    const result = await store.isBanned('1.2.3.4');
    expect(result.banned).toBe(false);
  });

  it('bans and unbans IP', async () => {
    await store.ban({ ip: '1.2.3.4', ttlSeconds: 60 });
    const result = await store.isBanned('1.2.3.4');
    expect(result.banned).toBe(true);
    expect(result.expiry).toBeDefined();
    expect(result.expiry! > Date.now()).toBe(true);

    await store.unban('1.2.3.4');
    const result2 = await store.isBanned('1.2.3.4');
    expect(result2.banned).toBe(false);
  });

  it('expires ban after TTL', async () => {
    vi.useFakeTimers();
    await store.ban({ ip: '1.2.3.4', ttlSeconds: 1 });
    expect((await store.isBanned('1.2.3.4')).banned).toBe(true);

    vi.advanceTimersByTime(2000);
    expect((await store.isBanned('1.2.3.4')).banned).toBe(false);
    vi.useRealTimers();
  });

  it('uses raw IP as internal key', async () => {
    const ip = '1.2.3.4';
    await store.ban({ ip, ttlSeconds: 60 });
    const expiry = store._getBanExpiry(ip);
    expect(expiry).toBeDefined();
    expect(expiry! > Date.now()).toBe(true);
  });
});

describe('banStore - RedisBanStore', () => {
  let mockRedis: RedisClient;
  let store: RedisBanStore;

  beforeEach(() => {
    mockRedis = {
      async get(_key: string) { return null; },
      async set(_key: string, _value: string, _options?: { ex?: number }) { },
      async del(_key: string) { },
      async close() {},
      async setNx() { return false; },
      async exists() { return false; },
      multi() {
        const pipeline = {
          zadd() { return pipeline; },
          zremrangebyscore() { return pipeline; },
          zcard() { return pipeline; },
          pexpire() { return pipeline; },
          async exec() { return []; }
        };
        return pipeline;
      },
      async zcount() { return 0; },
    };
    store = new RedisBanStore(mockRedis);
  });

  it('returns not banned for unknown IP', async () => {
    const result = await store.isBanned('1.2.3.4');
    expect(result.banned).toBe(false);
  });

  it('bans IP with TTL', async () => {
    await store.ban({ ip: '1.2.3.4', ttlSeconds: 60 });
  });

  it('uses sanitised key with prefix', async () => {
    let capturedKey: string | null = null;
    const mockRedisWithCapture: RedisClient = {
      ...mockRedis,
      async set(_key: string, _value: string) {
        capturedKey = _key;
      },
    };
    const storeWithCapture = new RedisBanStore(mockRedisWithCapture);
    await storeWithCapture.ban({ ip: '1.2.3.4', ttlSeconds: 60 });
    expect(capturedKey).toMatch(new RegExp(`^${BAN_KEY_PREFIX}[a-f0-9]{64}$`));
  });
});

describe('banStore - HybridBanStore', () => {
  let primary: InMemoryBanStore;
  let fallback: InMemoryBanStore;
  let store: HybridBanStore;

  beforeEach(() => {
    primary = new InMemoryBanStore();
    fallback = new InMemoryBanStore();
    store = new HybridBanStore(primary, fallback);
  });

  it('checks local cache first', async () => {
    await store.ban({ ip: '1.2.3.4', ttlSeconds: 60 });
    const result = await store.isBanned('1.2.3.4');
    expect(result.banned).toBe(true);
  });

  it('checks primary after cache miss', async () => {
    await primary.ban({ ip: '1.2.3.4', ttlSeconds: 60 });
    const result = await store.isBanned('1.2.3.4');
    expect(result.banned).toBe(true);
  });

  it('populates local cache on primary hit', async () => {
    await primary.ban({ ip: '1.2.3.4', ttlSeconds: 60 });
    await store.isBanned('1.2.3.4');
    const cached = await store['localCache'].isBanned('1.2.3.4');
    expect(cached.banned).toBe(true);
  });

  it('falls back on primary error', async () => {
    const failingPrimary: BanStore = {
      async isBanned() { throw new Error('Redis down'); },
      async ban() { throw new Error('Redis down'); },
      async unban() { throw new Error('Redis down'); },
      async close() {},
    };
    const hybrid = new HybridBanStore(failingPrimary, fallback);
    await fallback.ban({ ip: '1.2.3.4', ttlSeconds: 60 });
    const result = await hybrid.isBanned('1.2.3.4');
    expect(result.banned).toBe(true);
    expect(hybrid.usingFallback).toBe(true);
  });

  it('bans in local cache, primary, and fallback on primary error', async () => {
    const failingPrimary: BanStore = {
      async isBanned() { throw new Error('Redis down'); },
      async ban() { throw new Error('Redis down'); },
      async unban() { throw new Error('Redis down'); },
      async close() {},
    };
    const hybrid = new HybridBanStore(failingPrimary, fallback);
    await hybrid.ban({ ip: '1.2.3.4', ttlSeconds: 60 });
    expect((await hybrid['localCache'].isBanned('1.2.3.4')).banned).toBe(true);
    expect((await fallback.isBanned('1.2.3.4')).banned).toBe(true);
  });

  it('unbans from local cache, primary, and fallback on primary error', async () => {
    const failingPrimary: BanStore = {
      async isBanned() { throw new Error('Redis down'); },
      async ban() { throw new Error('Redis down'); },
      async unban() { throw new Error('Redis down'); },
      async close() {},
    };
    const hybrid = new HybridBanStore(failingPrimary, fallback);
    await hybrid.ban({ ip: '1.2.3.4', ttlSeconds: 60 });
    await hybrid.unban('1.2.3.4');
    expect((await hybrid['localCache'].isBanned('1.2.3.4')).banned).toBe(false);
    expect((await fallback.isBanned('1.2.3.4')).banned).toBe(false);
  });

  it('does not check fallback when primary returns not banned (no error)', async () => {
    await fallback.ban({ ip: '1.2.3.4', ttlSeconds: 60 });
    const result = await store.isBanned('1.2.3.4');
    expect(result.banned).toBe(false);
    expect(store.usingFallback).toBe(false);
  });
});

describe('banStore - createBanStore factory', () => {
  it('returns InMemoryBanStore when no redis client', () => {
    const store = createBanStore();
    expect(store).toBeInstanceOf(InMemoryBanStore);
  });

  it('returns HybridBanStore with RedisBanStore when redis client provided', () => {
    const mockRedis: RedisClient = {
      async get() { return null; },
      async set() { },
      async del() { },
      async close() {},
      async setNx() { return false; },
      async exists() { return false; },
      multi() {
        const pipeline = {
          zadd() { return pipeline; },
          zremrangebyscore() { return pipeline; },
          zcard() { return pipeline; },
          pexpire() { return pipeline; },
          async exec() { return []; }
        };
        return pipeline;
      },
      async zcount() { return 0; },
    };
    const store = createBanStore(mockRedis);
    expect(store).toBeInstanceOf(HybridBanStore);
  });
});