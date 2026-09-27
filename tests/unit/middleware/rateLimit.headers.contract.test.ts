/**
 * Contract test for issue #1572 — rate limit headers vs declared types.
 *
 * Guards the single declared header contract in `src/types/rateLimit.ts`
 * (`RATE_LIMIT_HEADERS` / `RateLimitHeaderValues`):
 *
 *  - The emitted header names are exactly the declared ones (none missing,
 *    none extra) on an exhausted (429) response.
 *  - Every declared field appears in the emitted headers.
 *  - The returned headers validate against `RateLimitHeadersSchema`, whose
 *    keys are derived from the declared mapping.
 *  - The values a caller receives match the documented contract
 *    (docs/api/rate-limiting.md): limit = configured cap, remaining = 0 on
 *    429, reset = future Unix epoch seconds, retry-after ≈ reset - now.
 *
 * Uses a minimal express app (limiter mounted directly) so the contract is
 * exercised end-to-end over HTTP without depending on the full app wiring.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../../../src/middleware/rateLimiter.js';
import { InMemoryStore } from '../../../src/redis/rateLimitStore.js';
import { RateLimitHeadersSchema } from '../../../src/validation/rateLimitHeaders.js';
import { RATE_LIMIT_HEADERS } from '../../../src/types/rateLimit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_IP = '203.0.113.10';

function makeApp(limit: number) {
  const env = {
    REDIS_ENABLED: 'false',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_IP_MAX: String(limit),
    RATE_LIMIT_IP_WINDOW_MS: '60000',
    RATE_LIMIT_APIKEY_MAX: String(limit),
    RATE_LIMIT_APIKEY_WINDOW_MS: '60000',
  };
  const limiter = createRateLimiter(env, new InMemoryStore());

  const app = express();
  app.set('trust proxy', true); // honour X-Forwarded-For so the client IP is deterministic
  app.use(limiter);
  app.get('/api/test-limit', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

/** Send requests until the limit is exhausted; returns the first 429 response. */
async function exhaustLimit(app: express.Express, limit: number) {
  let lastStatus = 0;
  // One extra request guarantees the rejection (count > limit).
  for (let i = 0; i <= limit; i++) {
    const res = await request(app).get('/api/test-limit').set('x-forwarded-for', TEST_IP);
    if (res.status === 429) return res;
    lastStatus = res.status;
  }
  throw new Error(`expected a 429 after ${limit + 1} requests, last status was ${lastStatus}`);
}

/** The declared contract, in the lowercase form HTTP clients observe. */
const DECLARED_HEADER_NAMES = Object.values(RATE_LIMIT_HEADERS).map((name) => name.toLowerCase());

// ---------------------------------------------------------------------------
// Emitted headers vs declared type
// ---------------------------------------------------------------------------

describe('#1572 emitted rate-limit headers match the declared type', () => {
  it('exhausting the limit returns exactly the declared header names', async () => {
    const limit = 3;
    const app = makeApp(limit);
    const res = await exhaustLimit(app, limit);

    expect(res.status).toBe(429);

    // Emitted quota/retry headers, normalised to the lowercase form clients see.
    // X-RateLimit-Store is excluded: it is an observability-only header that is
    // deliberately not part of the declared client contract.
    const emitted = Object.keys(res.headers)
      .filter((h) => h === DECLARED_HEADER_NAMES[3] || h.startsWith('x-ratelimit-'))
      .filter((h) => h !== 'x-ratelimit-store');

    expect([...emitted].sort()).toEqual([...DECLARED_HEADER_NAMES].sort());
  });

  it('every declared field appears in the headers of an exhausted response', async () => {
    const limit = 2;
    const app = makeApp(limit);
    const res = await exhaustLimit(app, limit);

    for (const name of DECLARED_HEADER_NAMES) {
      expect(res.headers[name]).toBeDefined();
    }
  });

  it('headers of an exhausted response parse against the schema derived from the declared type', async () => {
    const limit = 1;
    const app = makeApp(limit);
    const res = await exhaustLimit(app, limit);

    const parse = RateLimitHeadersSchema.safeParse(res.headers);
    expect(parse.success).toBe(true);
  });

  it('documented values match what a caller receives on 429', async () => {
    const limit = 5;
    const app = makeApp(limit);
    const beforeSeconds = Math.floor(Date.now() / 1000);
    const res = await exhaustLimit(app, limit);
    const afterSeconds = Math.floor(Date.now() / 1000);

    // limit — the configured cap
    expect(res.headers['x-ratelimit-limit']).toBe(String(limit));
    // remaining — zero once rejected
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    // reset — future Unix epoch seconds within the 60s window. The window is
    // anchored at the first request of the window, so the rejected request may
    // observe reset up to windowMs + 1s (ceil rounding) after it.
    const reset = parseInt(res.headers['x-ratelimit-reset'] as string, 10);
    expect(reset).toBeGreaterThan(beforeSeconds);
    expect(reset).toBeLessThanOrEqual(afterSeconds + 61);
    // retry-after — seconds until the window resets (±2s of clock skew)
    const retryAfter = parseInt(res.headers['retry-after'] as string, 10);
    expect(Math.abs(reset - afterSeconds - retryAfter)).toBeLessThanOrEqual(2);
  });

  it('allowed responses emit every declared field except the 429-only retry-after', async () => {
    const limit = 10;
    const app = makeApp(limit);
    const res = await request(app).get('/api/test-limit').set('x-forwarded-for', TEST_IP);

    expect(res.status).not.toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBe(String(limit));
    expect(res.headers['x-ratelimit-remaining']).toBe(String(limit - 1));
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('declared contract contains exactly the four documented headers', () => {
    expect(Object.values(RATE_LIMIT_HEADERS).sort()).toEqual(
      ['Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'].sort(),
    );
  });

  it('schema keys are exactly the declared header names', () => {
    expect(Object.keys(RateLimitHeadersSchema.shape).sort()).toEqual(
      Object.values(RATE_LIMIT_HEADERS)
        .map((name) => name.toLowerCase())
        .sort(),
    );
  });
});
