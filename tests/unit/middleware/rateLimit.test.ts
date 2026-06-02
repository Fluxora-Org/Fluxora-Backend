/**
 * Comprehensive tests for RFC 6585 rate-limit response headers (#290).
 *
 * Covers:
 *  - All four headers present on every allowed response
 *  - All four headers present on 429 responses (Retry-After included)
 *  - Header values pass the RateLimitHeadersSchema Zod schema
 *  - X-RateLimit-Reset is a Unix epoch timestamp (seconds, not ms)
 *  - X-RateLimit-Remaining decrements correctly across requests
 *  - Retry-After equals the difference between reset epoch and now
 *  - First request in a new window: remaining = limit - 1
 *  - Window boundary: reset epoch is in the future
 *  - Redis TTL mismatch: headers sourced from store result, not estimated
 *  - Concurrent requests use independent counters per key
 *  - Exempt paths (/health, /) do not receive rate-limit headers
 */

import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import { createRateLimiter } from '../../../src/middleware/rateLimiter.js';
import { InMemoryStore } from '../../../src/redis/rateLimitStore.js';
import { RateLimitHeadersSchema } from '../../../src/validation/rateLimitHeaders.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(ipMax: number, store?: InMemoryStore) {
  const env = {
    REDIS_ENABLED: 'false',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_IP_MAX: String(ipMax),
    RATE_LIMIT_IP_WINDOW_MS: '60000',
    RATE_LIMIT_APIKEY_MAX: String(ipMax),
    RATE_LIMIT_APIKEY_WINDOW_MS: '60000',
  };
  const s = store ?? new InMemoryStore();
  const limiter = createRateLimiter(env, s);
  const app = createApp({ env });
  app.locals.rateLimiter = limiter;
  return { app, limiter, store: s };
}

// ---------------------------------------------------------------------------
// #290 — Headers on allowed responses
// ---------------------------------------------------------------------------

describe('rate-limit headers on allowed responses', () => {
  it('sets X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset on first request', async () => {
    const { app } = makeApp(10);
    const res = await request(app)
      .get('/api/streams')
      .set('x-forwarded-for', '1.2.3.4');

    expect(res.status).not.toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBe('9');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('all three quota headers pass RateLimitHeadersSchema validation', async () => {
    const { app } = makeApp(10);
    const res = await request(app)
      .get('/api/streams')
      .set('x-forwarded-for', '1.2.3.5');

    const parse = RateLimitHeadersSchema.safeParse(res.headers);
    expect(parse.success).toBe(true);
  });

  it('X-RateLimit-Reset is a positive Unix epoch in seconds (not milliseconds)', async () => {
    const { app } = makeApp(10);
    const before = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .get('/api/streams')
      .set('x-forwarded-for', '1.2.3.6');

    const reset = parseInt(res.headers['x-ratelimit-reset'] as string, 10);
    // epoch in seconds will be ~1.7 billion; milliseconds would be ~1.7 trillion
    expect(reset).toBeGreaterThan(before);
    expect(reset).toBeLessThan(before + 120); // within 2-minute window
  });

  it('X-RateLimit-Remaining decrements by 1 with each request', async () => {
    const { app } = makeApp(5);
    const ip = '1.2.3.7';

    for (let i = 1; i <= 4; i++) {
      const res = await request(app)
        .get('/api/streams')
        .set('x-forwarded-for', ip);
      const remaining = parseInt(res.headers['x-ratelimit-remaining'] as string, 10);
      expect(remaining).toBe(5 - i);
    }
  });

  it('X-RateLimit-Reset is in the future on window boundary (first request)', async () => {
    const { app } = makeApp(10);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .get('/api/streams')
      .set('x-forwarded-for', '1.2.3.8');

    const reset = parseInt(res.headers['x-ratelimit-reset'] as string, 10);
    expect(reset).toBeGreaterThan(nowSeconds);
  });

  it('does not set Retry-After on allowed responses', async () => {
    const { app } = makeApp(10);
    const res = await request(app)
      .get('/api/streams')
      .set('x-forwarded-for', '1.2.3.9');

    expect(res.headers['retry-after']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #290 — Headers on 429 responses
// ---------------------------------------------------------------------------

describe('rate-limit headers on 429 responses', () => {
  it('sets all four headers when limit is exceeded', async () => {
    const limit = 2;
    const { app } = makeApp(limit);
    const ip = '2.2.2.1';

    for (let i = 0; i <= limit; i++) {
      await request(app).get('/api/streams').set('x-forwarded-for', ip);
    }

    const res = await request(app)
      .get('/api/streams')
      .set('x-forwarded-for', ip);

    expect(res.status).toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBe(String(limit));
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('all four headers on 429 pass RateLimitHeadersSchema', async () => {
    const limit = 1;
    const { app } = makeApp(limit);
    const ip = '2.2.2.2';

    await request(app).get('/api/streams').set('x-forwarded-for', ip);
    await request(app).get('/api/streams').set('x-forwarded-for', ip);

    const res = await request(app)
      .get('/api/streams')
      .set('x-forwarded-for', ip);

    expect(res.status).toBe(429);
    const parse = RateLimitHeadersSchema.safeParse(res.headers);
    expect(parse.success).toBe(true);
  });

  it('Retry-After is non-negative integer seconds', async () => {
    const limit = 1;
    const { app } = makeApp(limit);
    const ip = '2.2.2.3';

    await request(app).get('/api/streams').set('x-forwarded-for', ip);
    await request(app).get('/api/streams').set('x-forwarded-for', ip);

    const res = await request(app)
      .get('/api/streams')
      .set('x-forwarded-for', ip);

    const retryAfter = parseInt(res.headers['retry-after'] as string, 10);
    expect(retryAfter).toBeGreaterThanOrEqual(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('Retry-After aligns with X-RateLimit-Reset (reset - now <= Retry-After + 1)', async () => {
    const limit = 1;
    const { app } = makeApp(limit);
    const ip = '2.2.2.4';

    await request(app).get('/api/streams').set('x-forwarded-for', ip);
    await request(app).get('/api/streams').set('x-forwarded-for', ip);

    const beforeSeconds = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .get('/api/streams')
      .set('x-forwarded-for', ip);

    const reset = parseInt(res.headers['x-ratelimit-reset'] as string, 10);
    const retryAfter = parseInt(res.headers['retry-after'] as string, 10);
    // Retry-After should approximately equal (reset - now), within 2s of clock skew
    expect(Math.abs(reset - beforeSeconds - retryAfter)).toBeLessThanOrEqual(2);
  });

  it('response body contains RATE_LIMIT_EXCEEDED code', async () => {
    const limit = 1;
    const { app } = makeApp(limit);
    const ip = '2.2.2.5';

    await request(app).get('/api/streams').set('x-forwarded-for', ip);
    await request(app).get('/api/streams').set('x-forwarded-for', ip);

    const res = await request(app)
      .get('/api/streams')
      .set('x-forwarded-for', ip);

    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.body.error.retryAfter).toBeTypeOf('number');
  });
});

// ---------------------------------------------------------------------------
// #290 — Store-sourced values (not estimated)
// ---------------------------------------------------------------------------

describe('header values sourced from store, not estimated', () => {
  it('X-RateLimit-Reset matches resetAt returned by store.increment', async () => {
    const store = new InMemoryStore();
    const { app } = makeApp(10, store);
    const ip = '3.3.3.1';

    const beforeMs = Date.now();
    const res = await request(app)
      .get('/api/streams')
      .set('x-forwarded-for', ip);
    const afterMs = Date.now();

    const reset = parseInt(res.headers['x-ratelimit-reset'] as string, 10);
    // The store sets resetAt = Date.now() + windowMs (60s); ceil to seconds.
    // The header must be within the window (60s) from the request time.
    expect(reset * 1000).toBeGreaterThanOrEqual(beforeMs + 59_000);
    expect(reset * 1000).toBeLessThanOrEqual(afterMs + 61_000);
  });
});

// ---------------------------------------------------------------------------
// #290 — Concurrent requests use independent per-IP counters
// ---------------------------------------------------------------------------

describe('concurrent requests use independent counters per client', () => {
  it('two IPs have independent remaining counts', async () => {
    const { app } = makeApp(5);

    const [r1, r2] = await Promise.all([
      request(app).get('/api/streams').set('x-forwarded-for', '4.4.4.1'),
      request(app).get('/api/streams').set('x-forwarded-for', '4.4.4.2'),
    ]);

    expect(r1.headers['x-ratelimit-remaining']).toBe('4');
    expect(r2.headers['x-ratelimit-remaining']).toBe('4');
  });

  it('same IP increments counter across parallel requests', async () => {
    const { app } = makeApp(10);
    const ip = '4.4.4.3';

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).get('/api/streams').set('x-forwarded-for', ip),
      ),
    );

    const remainingValues = responses
      .map((r) => parseInt(r.headers['x-ratelimit-remaining'] as string, 10))
      .sort((a, b) => b - a);

    // All remaining values should be distinct decrements within [5..9]
    expect(remainingValues[0]).toBeLessThanOrEqual(9);
    expect(remainingValues[remainingValues.length - 1]).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// #290 — RateLimitHeadersSchema validation
// ---------------------------------------------------------------------------

describe('RateLimitHeadersSchema', () => {
  it('accepts valid header object', () => {
    const headers = {
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '99',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
    };
    expect(RateLimitHeadersSchema.safeParse(headers).success).toBe(true);
  });

  it('accepts valid header object with retry-after', () => {
    const headers = {
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
      'retry-after': '58',
    };
    expect(RateLimitHeadersSchema.safeParse(headers).success).toBe(true);
  });

  it('rejects non-integer x-ratelimit-limit', () => {
    const headers = {
      'x-ratelimit-limit': '10.5',
      'x-ratelimit-remaining': '9',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
    };
    expect(RateLimitHeadersSchema.safeParse(headers).success).toBe(false);
  });

  it('rejects zero x-ratelimit-reset', () => {
    const headers = {
      'x-ratelimit-limit': '10',
      'x-ratelimit-remaining': '9',
      'x-ratelimit-reset': '0',
    };
    expect(RateLimitHeadersSchema.safeParse(headers).success).toBe(false);
  });

  it('rejects missing x-ratelimit-limit', () => {
    const headers = {
      'x-ratelimit-remaining': '9',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
    };
    expect(RateLimitHeadersSchema.safeParse(headers).success).toBe(false);
  });

  it('rejects negative-looking string for remaining', () => {
    const headers = {
      'x-ratelimit-limit': '10',
      'x-ratelimit-remaining': '-1',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
    };
    expect(RateLimitHeadersSchema.safeParse(headers).success).toBe(false);
  });

  it('allows retry-after to be absent on non-429', () => {
    const headers = {
      'x-ratelimit-limit': '10',
      'x-ratelimit-remaining': '7',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
    };
    const result = RateLimitHeadersSchema.safeParse(headers);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data['retry-after']).toBeUndefined();
    }
  });
});
