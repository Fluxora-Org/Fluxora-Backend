/**
 * Tests for src/redis/rpcFallbackCache.ts
 *
 * Covers the InMemoryRpcFallbackCache read/write paths, including:
 * - getEntry returning correctly-parsed data for a non-expired entry (regression #878)
 * - get returning the unwrapped value for a non-expired entry
 * - Expired entries being evicted on read
 * - Corrupt entries being removed on read
 * - NoOpRpcFallbackCache always returning null / no-op
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryRpcFallbackCache,
  NoOpRpcFallbackCache,
} from '../../src/redis/rpcFallbackCache.js';

describe('InMemoryRpcFallbackCache', () => {
  let cache: InMemoryRpcFallbackCache;

  beforeEach(() => {
    cache = new InMemoryRpcFallbackCache();
  });

  describe('getEntry (non-expired entry)', () => {
    it('returns correctly-parsed entry data for a non-expired entry', async () => {
      const payload = { status: 'ok', data: [1, 2, 3] };

      await cache.set('getAccount', payload, 600);

      const entry = await cache.getEntry<typeof payload>('getAccount');

      expect(entry).not.toBeNull();
      expect(entry!.value).toEqual(payload);
      expect(entry!.ttlSeconds).toBe(600);
      expect(entry!.writtenAt).toBeGreaterThan(0);
      expect(entry!.expiresAt).toBeGreaterThan(entry!.writtenAt);
      expect(entry!.refreshDurationMs).toBeGreaterThanOrEqual(1);
    });

    it('returns unwrapped value via get for a non-expired entry', async () => {
      const payload = { result: 'success' };

      await cache.set('simulateTransaction', payload, 120);

      const value = await cache.get<typeof payload>('simulateTransaction');

      expect(value).toEqual(payload);
    });

    it('returns null for a missing key', async () => {
      const entry = await cache.getEntry('nonexistent');
      expect(entry).toBeNull();
    });

    it('evicts and returns null for an expired entry', async () => {
      const payload = { data: 'stale' };

      await cache.setEntry('getLedger', payload, 1, [], { nowMs: Date.now() - 2000 });

      const entry = await cache.getEntry<typeof payload>('getLedger');
      expect(entry).toBeNull();

      const value = await cache.get<typeof payload>('getLedger');
      expect(value).toBeNull();
    });

    it('removes corrupt entries on read', async () => {
      const key = (cache as unknown as { entries: Map<string, { value: string; expiresAt: number }> }).entries;
      // Manually inject a corrupt (non-JSON) entry
      key.set('corrupt-key', { value: 'not-json{{', expiresAt: Date.now() + 600_000 });

      const entry = await cache.getEntry('corrupt-key');
      expect(entry).toBeNull();
    });

    it('returns correctly-parsed data when cacheParts are provided', async () => {
      const payload = { accounts: [] };

      await cache.set('getAccounts', payload, 300, ['acct-123']);

      const entry = await cache.getEntry<typeof payload>('getAccounts', ['acct-123']);
      expect(entry).not.toBeNull();
      expect(entry!.value).toEqual(payload);
    });
  });
});

describe('NoOpRpcFallbackCache', () => {
  it('get returns null', async () => {
    const cache = new NoOpRpcFallbackCache();
    const value = await cache.get('anyOp');
    expect(value).toBeNull();
  });

  it('getEntry returns null', async () => {
    const cache = new NoOpRpcFallbackCache();
    const entry = await cache.getEntry('anyOp');
    expect(entry).toBeNull();
  });

  it('set does not throw', async () => {
    const cache = new NoOpRpcFallbackCache();
    await expect(cache.set('anyOp', { x: 1 }, 60)).resolves.toBeUndefined();
  });

  it('setEntry does not throw', async () => {
    const cache = new NoOpRpcFallbackCache();
    await expect(cache.setEntry('anyOp', { x: 1 }, 60)).resolves.toBeUndefined();
  });
});
