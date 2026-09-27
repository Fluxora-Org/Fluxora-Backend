export interface RateLimitConfig {
  windowMs: number;
  max: number;
  enabled: boolean;
}

export interface RouteRateLimitConfig {
  /** Base limit for this route (applies to all HTTP methods) */
  baseLimit: number;
  /** Stricter limit for write methods (POST, PUT, PATCH, DELETE) */
  writeLimit: number;
  /** Whether this route is exempt from rate limiting */
  exempt: boolean;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number, limit: number): Promise<{ count: number; resetAt: number }>;
  getCount(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
  close(): Promise<void>;
}

export interface RateLimitStatus {
  identifier: string;
  identifierType: 'ip' | 'apiKey';
  limit: number;
  remaining: number;
  resetsAt: string;
  window: string;
  route?: string;
  method?: string;
  store?: 'redis' | 'memory';
  degraded?: boolean;
}

export interface RateLimitErrorBody {
  error: {
    code: string;
    message: string;
    retryAfter: number;
    limit: number;
    window: string;
    identifier: string;
    route?: string;
    method?: string;
  };
}

export interface AdminKeySet {
  adminKeys: Set<string>;
}

export interface RateLimitCounters {
  ip: Map<string, { count: number; resetAt: number }>;
  apiKey: Map<string, { count: number; resetAt: number }>;
}

export interface RouteBudget {
  path: string;
  config: RouteRateLimitConfig;
}

// ---------------------------------------------------------------------------
// Rate-limit response headers — single declared contract
// ---------------------------------------------------------------------------

/**
 * Single declared contract for the rate-limit response headers.
 *
 * Every rate-limit header the service emits is keyed from this mapping (see
 * `setRateLimitHeaders` in `src/middleware/rateLimiter.ts`), and the
 * client-facing Zod schema (`src/validation/rateLimitHeaders.ts`) derives its
 * header names from it, so the emitted headers cannot drift from the
 * declared type.
 *
 * `retryAfter` (`Retry-After`, RFC 6585) is only emitted on HTTP 429; the
 * remaining headers are emitted on every rate-limited response.
 *
 * Note: `X-RateLimit-Store` is an observability-only header emitted
 * separately and is intentionally not part of the client contract.
 */
export const RATE_LIMIT_HEADERS = {
  limit: 'X-RateLimit-Limit',
  remaining: 'X-RateLimit-Remaining',
  reset: 'X-RateLimit-Reset',
  retryAfter: 'Retry-After',
} as const;

/** Declared rate-limit header fields (keys of {@link RATE_LIMIT_HEADERS}). */
export type RateLimitHeaderField = keyof typeof RATE_LIMIT_HEADERS;

/** Declared wire header names as emitted by the service. */
export type RateLimitHeaderName = (typeof RATE_LIMIT_HEADERS)[RateLimitHeaderField];

/**
 * Declared semantic values carried by the rate-limit response headers.
 * `retryAfter` is present only when the request was rejected with 429.
 */
export interface RateLimitHeaderValues {
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
}
