import { z } from 'zod';
import { RATE_LIMIT_HEADERS, type RateLimitHeaderField } from '../types/rateLimit.js';

const nonNegativeIntString = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer string');

/**
 * Per-field header value schemas, keyed by the declared header field from
 * `RATE_LIMIT_HEADERS` (`src/types/rateLimit.ts`).
 *
 * The `satisfies` clause guarantees every declared field has a value schema:
 * adding a field to the declared `RATE_LIMIT_HEADERS` contract without adding
 * its validation here is a compile error.
 */
const rateLimitHeaderValueSchemas = {
  limit: nonNegativeIntString,
  remaining: nonNegativeIntString,
  reset: nonNegativeIntString.refine(
    (v) => parseInt(v, 10) > 0,
    'X-RateLimit-Reset must be a positive Unix epoch timestamp in seconds',
  ),
  retryAfter: nonNegativeIntString.optional(),
} as const satisfies Record<RateLimitHeaderField, z.ZodTypeAny>;

/**
 * Wire keys for the schema, lowercased from the declared header names.
 * Node's HTTP client normalises response header names to lowercase, so the
 * schema must validate objects keyed the way callers actually receive them.
 */
const HEADER_KEYS = {
  limit: RATE_LIMIT_HEADERS.limit.toLowerCase(),
  remaining: RATE_LIMIT_HEADERS.remaining.toLowerCase(),
  reset: RATE_LIMIT_HEADERS.reset.toLowerCase(),
  retryAfter: RATE_LIMIT_HEADERS.retryAfter.toLowerCase(),
} as const;

/**
 * Zod schema for the rate-limit response headers, derived from the declared
 * header contract in `src/types/rateLimit.ts`.
 *
 * Used in tests to validate that the middleware sets all headers with
 * correctly-typed values. Values are transmitted as strings over HTTP.
 *
 * x-ratelimit-limit     — configured request cap for the current window
 * x-ratelimit-remaining — requests left before the client is rejected
 * x-ratelimit-reset     — Unix epoch (seconds) when the window resets
 * retry-after           — seconds until the client may retry (429 only)
 */
export const RateLimitHeadersSchema = z.object({
  [HEADER_KEYS.limit]: rateLimitHeaderValueSchemas.limit,
  [HEADER_KEYS.remaining]: rateLimitHeaderValueSchemas.remaining,
  [HEADER_KEYS.reset]: rateLimitHeaderValueSchemas.reset,
  [HEADER_KEYS.retryAfter]: rateLimitHeaderValueSchemas.retryAfter,
});

export type RateLimitHeaders = z.infer<typeof RateLimitHeadersSchema>;
