/**
 * Streams API — caching integration tests.
 *
 * Verifies that:
 * - GET /api/streams/:id returns X-Cache: MISS on first hit, HIT on second
 * - GET /api/streams returns X-Cache: MISS on first hit, HIT on second
 * - POST /api/streams invalidates the list cache
 * - DELETE /api/streams/:id invalidates both stream and list caches
 * - Service degrades gracefully when cache is unavailable (NullCacheClient)
 */

import express, { Application } from 'express';
import request from 'supertest';
import { streamsRouter, setStreamsCache } from '../src/routes/streams.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { requestIdMiddleware } from '../src/errors.js';
import { correlationIdMiddleware } from '../src/middleware/correlationId.js';
import {
  InMemoryCacheClient,
  NullCacheClient,
  setCacheClient,
  getCacheClient,
  resetCacheClient,
} from '../src/cache/redis.js';

function createTestApp(): Application {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(correlationIdMiddleware);
  app.use(express.json());
  app.use('/api/streams', streamsRouter);
  app.use(errorHandler);
  return app;
}

const VALID_STREAM = {
  sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
  recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
  depositAmount: '1000.0000000',
  ratePerSecond: '0.0000116',
};

describe('Streams API — cache integration', () => {
  let app: Application;
  let cache: InMemoryCacheClient;

  beforeEach(() => {
    cache = new InMemoryCacheClient();
    setStreamsCache(cache);
    setCacheClient(cache);
    app = createTestApp();
    // Verify the cache client is set correctly
    const client = getCacheClient();
    expect(client).toBe(cache);
  });

  afterEach(async () => {
    setStreamsCache(null);
    resetCacheClient();
    await cache.quit();
  });

  describe('GET /api/streams (list)', () => {
    it('returns X-Cache: MISS on first request', async () => {
      const res = await request(app).get('/api/streams').expect(200);
      expect(res.headers['x-cache']).toBe('MISS');
    });

    it('returns X-Cache: HIT on second request', async () => {
      await request(app).get('/api/streams');
      const res = await request(app).get('/api/streams').expect(200);
      expect(res.headers['x-cache']).toBe('HIT');
    });

    it('cached list response matches original', async () => {
      const first = await request(app).get('/api/streams').expect(200);
      const second = await request(app).get('/api/streams').expect(200);
      expect(second.body).toEqual(first.body);
    });
  });

  describe('GET /api/streams/:id', () => {
    it('returns X-Cache: MISS on first fetch of uncached stream', async () => {
      // Create a stream, then clear the cache to simulate a cold start
      const created = await request(app).post('/api/streams').send(VALID_STREAM).expect(201);
      const id: string = created.body.id as string;

      // Clear the cache to force a MISS
      cache.clear();

      const res = await request(app).get(`/api/streams/${id}`).expect(200);
      expect(res.headers['x-cache']).toBe('MISS');
    });

    it('returns X-Cache: HIT on second fetch', async () => {
      const created = await request(app).post('/api/streams').send(VALID_STREAM).expect(201);
      const id: string = created.body.id as string;

      await request(app).get(`/api/streams/${id}`);
      const res = await request(app).get(`/api/streams/${id}`).expect(200);
      expect(res.headers['x-cache']).toBe('HIT');
    });

    it('cached stream data matches original', async () => {
      const created = await request(app).post('/api/streams').send(VALID_STREAM).expect(201);
      const id: string = created.body.id as string;

      const first = await request(app).get(`/api/streams/${id}`).expect(200);
      const second = await request(app).get(`/api/streams/${id}`).expect(200);
      expect(second.body).toEqual(first.body);
    });
  });

  describe('POST /api/streams — cache invalidation', () => {
    it('invalidates the list cache after creation', async () => {
      // Warm the list cache
      await request(app).get('/api/streams');
      const warmRes = await request(app).get('/api/streams');
      expect(warmRes.headers['x-cache']).toBe('HIT');

      // Create a new stream — should bust the list cache
      await request(app).post('/api/streams').send(VALID_STREAM).expect(201);

      // Next list request should be a MISS
      const afterCreate = await request(app).get('/api/streams');
      expect(afterCreate.headers['x-cache']).toBe('MISS');
    });

    it('caches the newly created stream immediately', async () => {
      const created = await request(app).post('/api/streams').send(VALID_STREAM).expect(201);
      const id: string = created.body.id as string;

      // POST already populates the cache, so first GET should be HIT
      const res = await request(app).get(`/api/streams/${id}`).expect(200);
      expect(res.headers['x-cache']).toBe('HIT');
    });
  });

  describe('DELETE /api/streams/:id — cache invalidation', () => {
    it('invalidates stream and list caches after cancellation', async () => {
      const created = await request(app).post('/api/streams').send(VALID_STREAM).expect(201);
      const id: string = created.body.id as string;

      // Warm both caches
      await request(app).get(`/api/streams/${id}`);
      await request(app).get('/api/streams');

      // Cancel the stream
      await request(app).delete(`/api/streams/${id}`).expect(200);

      // Both should now be MISS
      const streamRes = await request(app).get(`/api/streams/${id}`).expect(200);
      expect(streamRes.headers['x-cache']).toBe('MISS');

      const listRes = await request(app).get('/api/streams').expect(200);
      expect(listRes.headers['x-cache']).toBe('MISS');
    });
  });

  describe('Cache unavailable (NullCacheClient)', () => {
    beforeEach(() => {
      setStreamsCache(new NullCacheClient());
    });

    afterEach(() => {
      setStreamsCache(cache); // restore
    });

    it('GET /api/streams still returns 200', async () => {
      await request(app).get('/api/streams').expect(200);
    });

    it('GET /api/streams/:id still returns 404 for missing stream', async () => {
      await request(app).get('/api/streams/nonexistent').expect(404);
    });

    it('POST /api/streams still creates a stream', async () => {
      const res = await request(app).post('/api/streams').send(VALID_STREAM).expect(201);
      expect(res.body.id).toBeDefined();
    });

    it('DELETE /api/streams/:id still cancels a stream', async () => {
      // Create with real cache, then cancel with null cache
      setStreamsCache(cache);
      const created = await request(app).post('/api/streams').send(VALID_STREAM).expect(201);
      const id: string = created.body.id as string;

      setStreamsCache(new NullCacheClient());
      await request(app).delete(`/api/streams/${id}`).expect(200);
    });
  });
});
