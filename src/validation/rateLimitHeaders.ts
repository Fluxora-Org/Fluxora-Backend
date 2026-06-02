import { z } from 'zod';

const nonNegativeIntString = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer string');

/**
 * Zod schema for the four RFC 6585 rate-limit response headers.
 *
 * Used in tests to validate that the middleware sets all headers with
 * correctly-typed values. Values are transmitted as strings over HTTP.
 *
 * X-RateLimit-Limit     — configured request cap for the current window
 * X-RateLimit-Remaining — requests left before the client is rejected
 * X-RateLimit-Reset     — Unix epoch (seconds) when the window resets
 * Retry-After           — seconds until the client may retry (429 only)
 */
export const RateLimitHeadersSchema = z.object({
  'x-ratelimit-limit': nonNegativeIntString,
  'x-ratelimit-remaining': nonNegativeIntString,
  'x-ratelimit-reset': nonNegativeIntString.refine(
    (v) => parseInt(v, 10) > 0,
    'X-RateLimit-Reset must be a positive Unix epoch timestamp in seconds',
  ),
  'retry-after': nonNegativeIntString.optional(),
});

export type RateLimitHeaders = z.infer<typeof RateLimitHeadersSchema>;
