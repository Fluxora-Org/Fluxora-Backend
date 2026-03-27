import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { app } from '../app.js';
import { InMemoryCacheClient, setCacheClient, resetCacheClient } from '../cache/redis.js';

describe('GET /health', () => {
  let cache: InMemoryCacheClient;

  beforeEach(() => {
    cache = new InMemoryCacheClient();
    setCacheClient(cache);
  });

  afterEach(() => { resetCacheClient(); });

  it('returns 200', async () => {
    await request(app).get('/health').expect(200);
  });

  it('includes status, service, timestamp, indexer, dependencies', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBeDefined();
    expect(res.body.service).toBe('fluxora-backend');
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.body.indexer).toBeDefined();
    expect(res.body.dependencies).toBeDefined();
  });

  it('reports redis status', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.dependencies.redis).toBeDefined();
    expect(res.body.dependencies.redis.status).toBeDefined();
  });

  it('reports redis as unavailable when NullCacheClient', async () => {
    resetCacheClient(); // NullCacheClient — ping returns false
    const res = await request(app).get('/health').expect(200);
    expect(res.body.dependencies.redis.status).toBe('unavailable');
  });

  it('reports redis as healthy when InMemoryCacheClient', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.dependencies.redis.status).toBe('healthy');
  });

  it('status is ok when indexer is not_configured', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.indexer.status).toBe('not_configured');
  });
});
