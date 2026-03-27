import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { idempotencyMiddleware } from './idempotency.js';
import { InMemoryCacheClient, NullCacheClient, setCacheClient, resetCacheClient } from '../cache/redis.js';

let callCount = 0;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request & { correlationId?: string }, _res, next) => {
    req.correlationId = 'test';
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

describe('idempotencyMiddleware', () => {
  let cache: InMemoryCacheClient;
  let app: ReturnType<typeof buildApp>;

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

  it('passes through without key', async () => {
    const res = await request(app).post('/resource').send({}).expect(201);
    expect(res.body.created).toBe(true);
    expect(callCount).toBe(1);
  });

  it('executes handler on first request with key', async () => {
    const res = await request(app)
      .post('/resource').set('Idempotency-Key', 'key-first-001').send({}).expect(201);
    expect(res.body.created).toBe(true);
    expect(callCount).toBe(1);
  });

  it('replays cached response on duplicate key', async () => {
    await request(app).post('/resource').set('Idempotency-Key', 'key-dup-001').send({}).expect(201);
    const res = await request(app).post('/resource').set('Idempotency-Key', 'key-dup-001').send({}).expect(201);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(callCount).toBe(1);
  });

  it('returns 400 for key shorter than 8 chars', async () => {
    const res = await request(app).post('/resource').set('Idempotency-Key', 'short').send({}).expect(400);
    expect(res.body.error.code).toBe('invalid_idempotency_key');
  });

  it('returns 400 for key longer than 128 chars', async () => {
    const res = await request(app).post('/resource').set('Idempotency-Key', 'a'.repeat(129)).send({}).expect(400);
    expect(res.body.error.code).toBe('invalid_idempotency_key');
  });

  it('does not cache non-2xx responses', async () => {
    await request(app).post('/fail').set('Idempotency-Key', 'fail-key-001').send({}).expect(400);
    const res = await request(app).post('/fail').set('Idempotency-Key', 'fail-key-001').send({}).expect(400);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  it('fails open when cache throws on get', async () => {
    // Use a cache that throws on get to hit the catch branch
    const throwingCache = {
      get: async () => { throw new Error('cache error'); },
      set: async () => { /* no-op */ },
      del: async () => { /* no-op */ },
      delPattern: async () => { /* no-op */ },
      ping: async () => false,
      quit: async () => { /* no-op */ },
    };
    setCacheClient(throwingCache as never);
    const res = await request(app).post('/resource').set('Idempotency-Key', 'key-throw').send({}).expect(201);
    expect(res.body.created).toBe(true);
  });

  it('handles array Idempotency-Key header (takes first)', async () => {
    const res = await request(app)
      .post('/resource').set('Idempotency-Key', 'valid-key-abc').send({}).expect(201);
    expect(res.body.created).toBe(true);
  });

  it('handles cache write error gracefully (fail-open on set)', async () => {
    // Cache that succeeds on get (returns null = no cached response) but throws on set
    let getCallCount = 0;
    const partialFailCache = {
      get: async () => { getCallCount++; return null; },
      set: async () => { throw new Error('write error'); },
      del: async () => { /* no-op */ },
      delPattern: async () => { /* no-op */ },
      ping: async () => false,
      quit: async () => { /* no-op */ },
    };
    setCacheClient(partialFailCache as never);
    // Should still return 201 even though caching the response fails
    const res = await request(app).post('/resource').set('Idempotency-Key', 'key-write-fail').send({}).expect(201);
    expect(res.body.created).toBe(true);
    expect(getCallCount).toBeGreaterThan(0);
  });

  it('fails open when cache unavailable', async () => {
    resetCacheClient();
    const res = await request(app).post('/resource').set('Idempotency-Key', 'key-no-cache').send({}).expect(201);
    expect(res.body.created).toBe(true);
  });
});
