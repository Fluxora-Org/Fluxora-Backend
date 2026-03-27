import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { streamsRouter, setStreamsCache } from './streams.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../errors.js';
import { correlationIdMiddleware } from '../middleware/correlationId.js';
import { InMemoryCacheClient, NullCacheClient, resetCacheClient } from '../cache/redis.js';

function createApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(correlationIdMiddleware);
  app.use(express.json());
  app.use('/api/streams', streamsRouter);
  app.use(errorHandler);
  return app;
}

const VALID = {
  sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
  recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
  depositAmount: '1000.0000000',
  ratePerSecond: '0.0000116',
};

describe('Streams route — caching', () => {
  let cache: InMemoryCacheClient;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    cache = new InMemoryCacheClient();
    setStreamsCache(cache);
    app = createApp();
  });

  afterEach(async () => {
    setStreamsCache(null);
    resetCacheClient();
    await cache.quit();
  });

  it('GET /api/streams returns X-Cache: MISS then HIT', async () => {
    const r1 = await request(app).get('/api/streams').expect(200);
    expect(r1.headers['x-cache']).toBe('MISS');
    const r2 = await request(app).get('/api/streams').expect(200);
    expect(r2.headers['x-cache']).toBe('HIT');
  });

  it('POST invalidates list cache', async () => {
    await request(app).get('/api/streams'); // warm
    await request(app).post('/api/streams').send(VALID).expect(201);
    const r = await request(app).get('/api/streams').expect(200);
    expect(r.headers['x-cache']).toBe('MISS');
  });

  it('POST pre-populates stream cache', async () => {
    const created = await request(app).post('/api/streams').send(VALID).expect(201);
    const id: string = created.body.id as string;
    const r = await request(app).get(`/api/streams/${id}`).expect(200);
    expect(r.headers['x-cache']).toBe('HIT');
  });

  it('GET /:id returns MISS after cache cleared', async () => {
    const created = await request(app).post('/api/streams').send(VALID).expect(201);
    const id: string = created.body.id as string;
    cache.clear();
    const r = await request(app).get(`/api/streams/${id}`).expect(200);
    expect(r.headers['x-cache']).toBe('MISS');
  });

  it('DELETE invalidates caches', async () => {
    const created = await request(app).post('/api/streams').send(VALID).expect(201);
    const id: string = created.body.id as string;
    await request(app).get(`/api/streams/${id}`); // warm
    await request(app).delete(`/api/streams/${id}`).expect(200);
    const r = await request(app).get(`/api/streams/${id}`).expect(200);
    expect(r.headers['x-cache']).toBe('MISS');
  });

  it('DELETE 409 on already-cancelled stream', async () => {
    const created = await request(app).post('/api/streams').send(VALID).expect(201);
    const id: string = created.body.id as string;
    await request(app).delete(`/api/streams/${id}`).expect(200);
    const r = await request(app).delete(`/api/streams/${id}`).expect(409);
    expect(r.body.error.code).toBe('CONFLICT');
  });

  it('GET /:id returns 404 for missing stream', async () => {
    const r = await request(app).get('/api/streams/nonexistent').expect(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });

  it('degrades gracefully with NullCacheClient', async () => {
    setStreamsCache(new NullCacheClient());
    await request(app).get('/api/streams').expect(200);
    await request(app).post('/api/streams').send(VALID).expect(201);
  });
});

describe('Streams route — validation', () => {
  let cache: InMemoryCacheClient;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    cache = new InMemoryCacheClient();
    setStreamsCache(cache);
    app = createApp();
  });

  afterEach(async () => {
    setStreamsCache(null);
    resetCacheClient();
    await cache.quit();
  });

  it('rejects missing sender', async () => {
    const r = await request(app).post('/api/streams').send({ ...VALID, sender: '' }).expect(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing recipient', async () => {
    const r = await request(app).post('/api/streams').send({ ...VALID, recipient: '' }).expect(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects numeric depositAmount', async () => {
    const r = await request(app).post('/api/streams').send({ ...VALID, depositAmount: 100 }).expect(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects zero depositAmount', async () => {
    const r = await request(app).post('/api/streams').send({ ...VALID, depositAmount: '0' }).expect(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects negative ratePerSecond', async () => {
    const r = await request(app).post('/api/streams').send({ ...VALID, ratePerSecond: '-1' }).expect(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid startTime', async () => {
    const r = await request(app).post('/api/streams').send({ ...VALID, startTime: -1 }).expect(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid endTime', async () => {
    const r = await request(app).post('/api/streams').send({ ...VALID, endTime: -1 }).expect(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts valid stream with startTime and endTime', async () => {
    const r = await request(app).post('/api/streams').send({ ...VALID, startTime: 1000, endTime: 2000 }).expect(201);
    expect(r.body.startTime).toBe(1000);
    expect(r.body.endTime).toBe(2000);
  });

  it('defaults depositAmount to 0 when omitted', async () => {
    const { depositAmount: _, ...body } = VALID;
    const r = await request(app).post('/api/streams').send(body).expect(201);
    expect(r.body.depositAmount).toBe('0');
  });

  it('defaults ratePerSecond to 0 when omitted', async () => {
    const { ratePerSecond: _, ...body } = VALID;
    const r = await request(app).post('/api/streams').send(body).expect(201);
    expect(r.body.ratePerSecond).toBe('0');
  });
});
