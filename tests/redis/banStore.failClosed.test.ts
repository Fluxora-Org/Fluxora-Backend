import { describe, expect, it, vi } from 'vitest';
import { HybridBanStore, InMemoryBanStore, RedisBanStore } from '../../src/redis/banStore.js';

describe('HybridBanStore failure policy', () => {
  it('rejects admission when Redis cannot answer a ban check', async () => {
    const primary = {
      isBanned: vi.fn().mockRejectedValue(new Error('redis timeout')),
      ban: vi.fn(), unban: vi.fn(), close: vi.fn(),
    };
    const store = new HybridBanStore(primary, new InMemoryBanStore());

    await expect(store.isBanned('203.0.113.10')).resolves.toEqual({ banned: true });
    expect(store.usingFallback).toBe(true);
  });

  it('resumes normal admission after Redis recovers', async () => {
    const primary = {
      isBanned: vi.fn()
        .mockRejectedValueOnce(new Error('redis timeout'))
        .mockResolvedValueOnce({ banned: false }),
      ban: vi.fn(), unban: vi.fn(), close: vi.fn(),
    };
    const store = new HybridBanStore(primary, new InMemoryBanStore());

    await expect(store.isBanned('203.0.113.11')).resolves.toEqual({ banned: true });
    await expect(store.isBanned('203.0.113.11')).resolves.toEqual({ banned: false });
    expect(store.usingFallback).toBe(false);
  });
});

describe('BanStore expiry and validation', () => {
  it('InMemoryBanStore rejects invalid ttlSeconds (zero)', async () => {
    const store = new InMemoryBanStore();
    await expect(store.ban({ ip: '192.0.2.1', ttlSeconds: 0 }))
      .rejects.toThrow('Invalid ttlSeconds: 0. Must be a positive integer.');
  });

  it('InMemoryBanStore rejects invalid ttlSeconds (negative)', async () => {
    const store = new InMemoryBanStore();
    await expect(store.ban({ ip: '192.0.2.1', ttlSeconds: -10 }))
      .rejects.toThrow('Invalid ttlSeconds: -10. Must be a positive integer.');
  });

  it('InMemoryBanStore rejects invalid ttlSeconds (non-integer)', async () => {
    const store = new InMemoryBanStore();
    await expect(store.ban({ ip: '192.0.2.1', ttlSeconds: 1.5 }))
      .rejects.toThrow('Invalid ttlSeconds: 1.5. Must be a positive integer.');
  });

  it('InMemoryBanStore expires bans after TTL', async () => {
    const store = new InMemoryBanStore();
    const ip = '192.0.2.2';
    const ttlSeconds = 1;

    await store.ban({ ip, ttlSeconds });
    const result1 = await store.isBanned(ip);
    expect(result1.banned).toBe(true);
    expect(result1.expiry).toBeDefined();

    // Wait for expiry
    await new Promise(resolve => setTimeout(resolve, 1100));
    const result2 = await store.isBanned(ip);
    expect(result2.banned).toBe(false);
  });

  it('RedisBanStore rejects invalid ttlSeconds (zero)', async () => {
    const client = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
    };
    const store = new RedisBanStore(client);
    await expect(store.ban({ ip: '192.0.2.1', ttlSeconds: 0 }))
      .rejects.toThrow('Invalid ttlSeconds: 0. Must be a positive integer.');
    expect(client.set).not.toHaveBeenCalled();
  });

  it('RedisBanStore rejects invalid ttlSeconds (negative)', async () => {
    const client = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
    };
    const store = new RedisBanStore(client);
    await expect(store.ban({ ip: '192.0.2.1', ttlSeconds: -5 }))
      .rejects.toThrow('Invalid ttlSeconds: -5. Must be a positive integer.');
    expect(client.set).not.toHaveBeenCalled();
  });

  it('RedisBanStore validates ttlSeconds before calling Redis', async () => {
    const client = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn(),
    };
    const store = new RedisBanStore(client);
    await store.ban({ ip: '192.0.2.1', ttlSeconds: 60 });
    
    expect(client.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { ex: 60 }
    );
  });
});

describe('HybridBanStore expiry and unavailability', () => {
  it('bans succeed via local fallback when Redis is unavailable', async () => {
    const primary = {
      isBanned: vi.fn().mockRejectedValue(new Error('redis down')),
      ban: vi.fn().mockRejectedValue(new Error('redis down')),
      unban: vi.fn().mockRejectedValue(new Error('redis down')),
      close: vi.fn(),
    };
    const fallback = new InMemoryBanStore();
    const store = new HybridBanStore(primary, fallback);

    await expect(store.ban({ ip: '192.0.2.3', ttlSeconds: 60 }))
      .resolves.not.toThrow();
    
    expect(store.usingFallback).toBe(true);
    expect(store.fallbackModeCount).toBeGreaterThan(0);

    // Verify ban exists in fallback
    const result = await fallback.isBanned('192.0.2.3');
    expect(result.banned).toBe(true);
  });

  it('isBanned returns fail-closed when Redis unavailable and no local cache', async () => {
    const primary = {
      isBanned: vi.fn().mockRejectedValue(new Error('redis down')),
      ban: vi.fn(), unban: vi.fn(), close: vi.fn(),
    };
    const store = new HybridBanStore(primary, new InMemoryBanStore());

    const result = await store.isBanned('192.0.2.4');
    expect(result.banned).toBe(true);
    expect(store.usingFallback).toBe(true);
  });

  it('local cache entries expire correctly', async () => {
    const primary = {
      isBanned: vi.fn().mockResolvedValue({ banned: false }),
      ban: vi.fn().mockResolvedValue(undefined),
      unban: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    };
    const store = new HybridBanStore(primary, new InMemoryBanStore());

    // Ban with short TTL
    await store.ban({ ip: '192.0.2.5', ttlSeconds: 1 });
    
    // Should be banned immediately
    const result1 = await store.isBanned('192.0.2.5');
    expect(result1.banned).toBe(true);

    // Wait for expiry
    await new Promise(resolve => setTimeout(resolve, 1100));
    
    // Should no longer be banned
    const result2 = await store.isBanned('192.0.2.5');
    expect(result2.banned).toBe(false);
  });
});
