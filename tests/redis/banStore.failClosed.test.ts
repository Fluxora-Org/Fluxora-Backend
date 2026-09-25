import { describe, expect, it, vi } from 'vitest';
import { HybridBanStore, InMemoryBanStore } from '../../src/redis/banStore.js';

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
