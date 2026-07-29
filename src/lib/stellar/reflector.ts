export type FiatCurrency = 'USD' | 'EUR' | 'GBP' | 'NGN';

export interface ReflectorResponse {
  price?: number;
  [key: string]: unknown;
}

export interface ReflectorOracleOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
}

interface CacheEntry {
  value: number;
  expiresAt: number;
}

const DEFAULT_BASE_URL = 'https://api.reflector.network/v1/prices';
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_CURRENCY_SYMBOLS: Record<FiatCurrency, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  NGN: '₦',
};

export class ReflectorOracle {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: ReflectorOracleOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async getPrice(assetCode: string, assetIssuer: string, currency: FiatCurrency): Promise<number | undefined> {
    const cacheKey = `${assetCode}:${assetIssuer}:${currency}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    try {
      const url = new URL(this.baseUrl);
      url.searchParams.set('asset_code', assetCode);
      url.searchParams.set('asset_issuer', assetIssuer);
      url.searchParams.set('currency', currency);

      const response = await this.fetchImpl(url.toString());
      if (!response.ok) {
        return undefined;
      }

      const payload = (await response.json()) as ReflectorResponse;
      const price = payload.price;
      if (typeof price !== 'number' || Number.isNaN(price)) {
        return undefined;
      }

      this.cache.set(cacheKey, { value: price, expiresAt: Date.now() + this.ttlMs });
      return price;
    } catch {
      return undefined;
    }
  }

  async formatAmount(amount: number, assetCode: string, assetIssuer: string, currency: FiatCurrency): Promise<string | undefined> {
    const price = await this.getPrice(assetCode, assetIssuer, currency);
    if (price === undefined) {
      return undefined;
    }

    const value = amount * price;
    return `≈ ${formatFiatAmount(value, currency)}`;
  }
}

export function formatFiatAmount(amount: number, currency: FiatCurrency): string {
  const symbol = DEFAULT_CURRENCY_SYMBOLS[currency];
  const normalized = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(amount);

  if (currency === 'NGN') {
    return `${symbol}${normalized.replace(/^\D+/, '')}`;
  }

  return normalized;
}
