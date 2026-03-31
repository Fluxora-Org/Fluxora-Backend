import request from 'supertest';
import { describe, it, expect } from 'vitest';
import express from 'express';
import { createRateLimiter } from '../src/middleware/rateLimit';

function buildApp(max: number) {
  const app = express();
  app.use(createRateLimiter({ windowMs: 60_000, max }));
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('createRateLimiter', () => {
  it('allows requests within the limit', async () => {
    const app = buildApp(5);
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
  });

  it('returns 429 after limit is exceeded', async () => {
    const app = buildApp(2);
    await request(app).get('/ping');
    await request(app).get('/ping');
    const res = await request(app).get('/ping');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('sets RateLimit-* headers', async () => {
    const app = buildApp(10);
    const res = await request(app).get('/ping');
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();
  });
});
