/**
 * Idempotency middleware tests.
 *
 * Covers: replay on duplicate key, pass-through without key,
 * invalid key format rejection, fail-open on cache error,
 * and non-2xx responses not being cached.
 */

import express, { Application } from 'express';
import request from 'supertest';
import { idempotencyMiddleware } from '../src/middleware/idempotency.js';
import { InMemoryCacheClient, setCacheClient, resetCacheClient } from '../src/cache/redis.js';

let callCount = 0;

function buildApp(): Application {
  const app = express();
  app.use(express.json());
  // Minimal correlation ID shim
  app.use((req, _res, next) => {
    (req as express.Request & { correlationId: string }).correlationId = 'test-id';
    next();
  });
  app.post('/resource', idempotencyMiddleware, (_req, res) => {
    callCount++;
    res.status(201).json({ created: true, count: callCount });
  });
  app.post('/fail', idempotencyMiddleware, (_req, res) => {
    res.status(400).json({ error: 'bad' });
  });
  return app;
}

describe('Idempotency middleware', () => {
  let cache: InMemoryCacheClient;
  let app: Application;

  beforeEach(() => {
    callCount = 0;
    cache = new InMemoryCacheClient();
    setCacheClient(cache);
    app = buildApp();
  });

  afterEach(async () => {
    resetCacheClient();
    await cache.quit();
  });

  it('passes through when no Idempotency-Key header is present', async () => {
    const res = await request(app).post('/resource').send({}).expect(201);
    expect(res.body.created).toBe(true);
    expect(callCount).toBe(1);
  });

  it('executes handler on first request with a key', async () => {
    const res = await request(app)
      .post('/resource')
      .set('Idempotency-Key', 'unique-key-001')
      .send({})
      .expect(201);
    expect(res.body.created).toBe(true);
    expect(callCount).toBe(1);
  });

  it('replays cached response on duplicate key', async () => {
    await request(app)
      .post('/resource')
      .set('Idempotency-Key', 'unique-key-002')
      .send({})
      .expect(201);

    const res = await request(app)
      .post('/resource')
      .set('Idempotency-Key', 'unique-key-002')
      .send({})
      .expect(201);

    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(callCount).toBe(1); // handler only called once
  });

  it('returns 400 for key shorter than 8 characters', async () => {
    const res = await request(app)
      .post('/resource')
      .set('Idempotency-Key', 'short')
      .send({})
      .expect(400);
    expect(res.body.error.code).toBe('invalid_idempotency_key');
  });

  it('returns 400 for key longer than 128 characters', async () => {
    const longKey = 'a'.repeat(129);
    const res = await request(app)
      .post('/resource')
      .set('Idempotency-Key', longKey)
      .send({})
      .expect(400);
    expect(res.body.error.code).toBe('invalid_idempotency_key');
  });

  it('does not cache non-2xx responses', async () => {
    await request(app)
      .post('/fail')
      .set('Idempotency-Key', 'fail-key-001')
      .send({})
      .expect(400);

    // Second request should NOT be replayed — handler runs again
    const res = await request(app)
      .post('/fail')
      .set('Idempotency-Key', 'fail-key-001')
      .send({})
      .expect(400);

    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  it('fails open when cache is unavailable', async () => {
    resetCacheClient(); // NullCacheClient
    const res = await request(app)
      .post('/resource')
      .set('Idempotency-Key', 'key-no-cache')
      .send({})
      .expect(201);
    expect(res.body.created).toBe(true);
  });
});
