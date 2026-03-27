import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createRateLimiter } from './rateLimit.js';
import { InMemoryCacheClient, setCacheClient, resetCacheClient } from '../cache/redis.js';

function buildApp(max: number, windowSeconds = 60) {
  const app = express();
  // Minimal correlationId shim
  app.use((req: express.Request & { correlationId?: string }, _res, next) => {
    req.correlationId = 'test';
    next();
  });
  app.use(createRateLimiter({ max, windowSeconds, keyPrefix: 'test' }));
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('createRateLimiter', () => {
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
    await request(app).get('/ping').expect(200);
  });

  it('sets X-RateLimit headers', async () => {
    const app = buildApp(10);
    const res = await request(app).get('/ping');
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('returns 429 when limit exceeded', async () => {
    const app = buildApp(1);
    await request(app).get('/ping').expect(200);
    const res = await request(app).get('/ping').expect(429);
    expect(res.body.error.code).toBe('rate_limit_exceeded');
    expect(res.body.error.status).toBe(429);
  });

  it('includes Retry-After on 429', async () => {
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

  it('fails open when cache throws', async () => {
    const throwingCache = {
      get: async () => { throw new Error('cache error'); },
      set: async () => { throw new Error('cache error'); },
      del: async () => { /* no-op */ },
      delPattern: async () => { /* no-op */ },
      ping: async () => false,
      quit: async () => { /* no-op */ },
    };
    setCacheClient(throwingCache as never);
    const app = buildApp(5);
    await request(app).get('/ping').expect(200);
  });

  it('fails open when cache unavailable (NullCacheClient)', async () => {
    resetCacheClient();
    const app = buildApp(1);
    await request(app).get('/ping').expect(200);
    await request(app).get('/ping').expect(200);
  });

  it('respects X-Forwarded-For', async () => {
    const app = buildApp(1);
    await request(app).get('/ping').set('X-Forwarded-For', '1.2.3.4').expect(200);
    await request(app).get('/ping').set('X-Forwarded-For', '1.2.3.4').expect(429);
    await request(app).get('/ping').set('X-Forwarded-For', '5.6.7.8').expect(200);
  });
});
