import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReflectorOracle, formatFiatAmount } from '../../../src/lib/stellar/reflector.js';

describe('ReflectorOracle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns undefined when the oracle is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const oracle = new ReflectorOracle({ fetchImpl, ttlMs: 60_000 });

    await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBeUndefined();
  });

  it('caches prices for 60 seconds and refreshes afterward', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ price: 1.23 }),
    }));
    const oracle = new ReflectorOracle({ fetchImpl, ttlMs: 60_000 });

    await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBe(1.23);
    await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBe(1.23);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);

    await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBe(1.23);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('formats amounts in the selected currency and hides the suffix when unavailable', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ price: 2 }),
    }));
    const oracle = new ReflectorOracle({ fetchImpl, ttlMs: 60_000 });

    await expect(oracle.formatAmount(12.5, 'USDC', 'issuer', 'EUR')).resolves.toBe('≈ €25.00');
    await expect(formatFiatAmount(12.5, 'USD')).toBe('$12.50');
  });
});
