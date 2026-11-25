import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReflectorOracle, formatFiatAmount, type FiatCurrency } from './reflector';

function jsonResponse(payload: unknown): Response {
  // A mocked parser can return NaN/Infinity, unlike a JSON.stringify round trip.
  return { ok: true, json: vi.fn().mockResolvedValue(payload) } as unknown as Response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ReflectorOracle', () => {
  it('uses the default endpoint and encodes asset and currency query parameters', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ price: 1.25 }));
    vi.stubGlobal('fetch', fetchImpl);
    const oracle = new ReflectorOracle();

    await expect(oracle.getPrice('A & B', 'issuer/+?', 'EUR')).resolves.toBe(1.25);
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://api.reflector.network/v1/prices');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      asset_code: 'A & B',
      asset_issuer: 'issuer/+?',
      currency: 'EUR',
    });
  });

  it.each([0, -0, -1, NaN, Infinity, -Infinity, '1.25', null, undefined, true])(
    'rejects invalid price %s without caching it',
    async (price) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ price }))
        .mockResolvedValueOnce(jsonResponse({ price: 2 }));
      const oracle = new ReflectorOracle({ fetchImpl });
      await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBeUndefined();
      await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  );

  it.each([null, undefined, {}, [], 'invalid'])('handles malformed payload %j', async (payload) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));
    await expect(
      new ReflectorOracle({ fetchImpl }).getPrice('USDC', 'issuer', 'USD')
    ).resolves.toBeUndefined();
  });

  it.each([400, 429, 500])('does not parse or cache an HTTP %s response', async (status) => {
    const response = new Response('unavailable', { status });
    const json = vi.spyOn(response, 'json');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(jsonResponse({ price: 3 }));
    const oracle = new ReflectorOracle({ fetchImpl });
    await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
    await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBe(3);
  });

  it('recovers after fetch and JSON parsing failures', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(new Response('invalid JSON'))
      .mockResolvedValueOnce(jsonResponse({ price: 4 }));
    const oracle = new ReflectorOracle({ fetchImpl });
    await expect(oracle.getPrice('USDC', 'issuer', 'GBP')).resolves.toBeUndefined();
    await expect(oracle.getPrice('USDC', 'issuer', 'GBP')).resolves.toBeUndefined();
    await expect(oracle.getPrice('USDC', 'issuer', 'GBP')).resolves.toBe(4);
  });

  it('caches valid prices until the exact TTL boundary and uses the configured endpoint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ price: 1 }))
      .mockResolvedValueOnce(jsonResponse({ price: 2 }));
    const oracle = new ReflectorOracle({
      fetchImpl,
      ttlMs: 100,
      baseUrl: 'https://oracle.example/prices',
    });
    await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBe(1);
    vi.advanceTimersByTime(99);
    await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBe(2);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('https://oracle.example/prices?');
  });

  it('does not return an expired cached price when the refresh is invalid', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ price: 1 }))
      .mockResolvedValueOnce(jsonResponse({ price: -1 }))
      .mockResolvedValueOnce(jsonResponse({ price: 2 }));
    const oracle = new ReflectorOracle({ fetchImpl });
    await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBe(1);
    vi.advanceTimersByTime(60_000);
    await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBeUndefined();
    await expect(oracle.getPrice('USDC', 'issuer', 'USD')).resolves.toBe(2);
  });

  it('separates cached prices by asset, issuer, and currency', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ price: 1 }));
    const oracle = new ReflectorOracle({ fetchImpl });
    for (const [asset, issuer, currency] of [
      ['USDC', 'issuer', 'USD'],
      ['XLM', 'issuer', 'USD'],
      ['USDC', 'another-issuer', 'USD'],
      ['USDC', 'issuer', 'EUR'],
    ] as const) {
      await oracle.getPrice(asset, issuer, currency);
    }
    await oracle.getPrice('USDC', 'issuer', 'USD');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('formats converted amounts and returns undefined when the price is unavailable', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ price: 1.25 }))
      .mockResolvedValueOnce(jsonResponse({ price: 0 }));
    const oracle = new ReflectorOracle({ fetchImpl });
    await expect(oracle.formatAmount(10, 'USDC', 'issuer', 'USD')).resolves.toBe('≈ $12.50');
    await expect(oracle.formatAmount(10, 'USDC', 'issuer', 'NGN')).resolves.toBeUndefined();
  });
});

describe('formatFiatAmount', () => {
  it.each<[FiatCurrency, string]>([
    ['USD', '$'],
    ['EUR', '€'],
    ['GBP', '£'],
    ['NGN', '₦'],
  ])('formats %s with its symbol, grouping, sign, and two decimal places', (currency, symbol) => {
    expect(formatFiatAmount(1234.5, currency)).toBe(`${symbol}1,234.50`);
    expect(formatFiatAmount(0, currency)).toBe(`${symbol}0.00`);
    expect(formatFiatAmount(-1234.5, currency)).toBe(`-${symbol}1,234.50`);
    expect(formatFiatAmount(1.004, currency)).toBe(`${symbol}1.00`);
    expect(formatFiatAmount(1.005, currency)).toBe(`${symbol}1.01`);
    expect(formatFiatAmount(-1.005, currency)).toBe(`-${symbol}1.01`);
  });

  it.each<FiatCurrency>(['USD', 'EUR', 'GBP', 'NGN'])(
    'rounds large %s values without scaling them through floating-point cents',
    (currency) => {
      const symbol = { USD: '$', EUR: '€', GBP: '£', NGN: '₦' }[currency];
      expect(formatFiatAmount(1_000_000_000_000.125, currency)).toBe(
        `${symbol}1,000,000,000,000.13`
      );
      expect(formatFiatAmount(Number.MAX_SAFE_INTEGER, currency)).toBe(
        `${symbol}9,007,199,254,740,991.00`
      );
    }
  );
});
