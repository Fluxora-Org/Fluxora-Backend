/**
 * Rate limiter middleware tests.
 *
 * Uses InMemoryCacheClient so no Redis instance is required.
 * Covers: normal flow, limit enforcement, header correctness,
 * fail-open on cache error, and IP extraction.
 */

import express, { Application } from 'express';
import request from 'supertest';
import { createRateLimiter } from '../src/middleware/rateLimit.js';
import { InMemoryCacheClient, setCacheClient, resetCacheClient } from '../src/cache/redis.js';

function buildApp(max: number, windowSeconds = 60): Application {
  const app = express();
  app.use(createRateLimiter({ max, windowSeconds, keyPrefix: 'test-rl' }));
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('Rate limiter middleware', () => {
  let cache: InMemoryCacheClient;

  beforeEach(() => {
    cache = new InMemoryCacheClient();
    setCacheClient(cache);
  });

  afterEach(async () => {
    resetCacheClient();
    await cache.quit();
  });

  it('allows requests under the limit', async () => {
    const app = buildApp(5);
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
  });

  it('sets X-RateLimit-* headers on allowed requests', async () => {
    const app = buildApp(10);
    const res = await request(app).get('/ping');
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('returns 429 when limit is exceeded', async () => {
    const app = buildApp(2);
    await request(app).get('/ping').expect(200);
    await request(app).get('/ping').expect(200);
    const res = await request(app).get('/ping').expect(429);
    expect(res.body.error.code).toBe('rate_limit_exceeded');
    expect(res.body.error.status).toBe(429);
  });

  it('includes Retry-After header on 429', async () => {
    const app = buildApp(1, 30);
    await request(app).get('/ping');
    const res = await request(app).get('/ping').expect(429);
    expect(res.headers['retry-after']).toBe('30');
  });

  it('X-RateLimit-Remaining is 0 on 429', async () => {
    const app = buildApp(1);
    await request(app).get('/ping');
    const res = await request(app).get('/ping').expect(429);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('fails open when cache is unavailable', async () => {
    resetCacheClient(); // NullCacheClient — always returns null
    const app = buildApp(1);
    // Should allow even though limit is 1 (cache unavailable = fail-open)
    await request(app).get('/ping').expect(200);
    await request(app).get('/ping').expect(200);
  });

  it('respects X-Forwarded-For for IP extraction', async () => {
    const app = buildApp(1);
    // First request from "client-a"
    await request(app).get('/ping').set('X-Forwarded-For', '1.2.3.4').expect(200);
    // Second request from same IP — should be blocked
    await request(app).get('/ping').set('X-Forwarded-For', '1.2.3.4').expect(429);
    // Different IP — should be allowed
    await request(app).get('/ping').set('X-Forwarded-For', '5.6.7.8').expect(200);
  });
});
