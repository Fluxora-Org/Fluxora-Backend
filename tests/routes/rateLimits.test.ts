import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

function createTestEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    PORT: '0',
    NODE_ENV: 'test',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_IP_MAX: '5',
    RATE_LIMIT_IP_WINDOW_MS: '60000',
    RATE_LIMIT_APIKEY_MAX: '10',
    RATE_LIMIT_APIKEY_WINDOW_MS: '60000',
    RATE_LIMIT_ADMIN_MAX: '20',
    RATE_LIMIT_ADMIN_WINDOW_MS: '60000',
    RATE_LIMIT_TRUST_PROXY: 'false',
    ...overrides,
  };
}

describe('GET /api/rate-limits', () => {
  it('returns 200 with rate limit status', async () => {
    const env = createTestEnv();
    const app = createApp(env);

    const res = await request(app).get('/api/rate-limits').expect(200);

    expect(res.body).toMatchObject({
      identifier: expect.any(String),
      identifierType: 'ip',
      limit: 5,
      remaining: expect.any(Number),
      resetsAt: expect.any(String),
      window: 'minute',
    });

    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('returns correct remaining after requests', async () => {
    const env = createTestEnv({ RATE_LIMIT_IP_MAX: '3' });
    const app = createApp(env);

    // Make 2 requests to decrement remaining
    await request(app).get('/api/streams');
    await request(app).get('/api/streams');

    const res = await request(app).get('/api/rate-limits').expect(200);

    // Status endpoint is exempt, so no decrement. 3 - 0 = 3, but 2 requests consumed 2, so 3 - 2 = 1
    expect(res.body.remaining).toBe(1);
    expect(res.body.limit).toBe(3);
  });

  it('reports 0 remaining after exhaustion', async () => {
    const env = createTestEnv({ RATE_LIMIT_IP_MAX: '2' });
    const app = createApp(env);

    await request(app).get('/api/streams');
    await request(app).get('/api/streams');

    const res = await request(app).get('/api/rate-limits').expect(200);
    expect(res.body.remaining).toBe(0);
  });

  it('returns correct status for API key caller', async () => {
    const env = createTestEnv({ RATE_LIMIT_APIKEY_MAX: '7' });
    const app = createApp(env);

    const res = await request(app)
      .get('/api/rate-limits')
      .set('X-API-Key', 'my-test-key')
      .expect(200);

    expect(res.body.identifierType).toBe('apiKey');
    expect(res.body.limit).toBe(7);
    expect(res.body.identifier).toBe('my-t...-key'); // masked
  });

  it('uses admin limit for admin API key', async () => {
    const env = createTestEnv({
      ADMIN_API_KEY: 'super-secret-admin',
      RATE_LIMIT_APIKEY_MAX: '5',
      RATE_LIMIT_ADMIN_MAX: '20',
    });
    const app = createApp(env);

    const res = await request(app)
      .get('/api/rate-limits')
      .set('X-API-Key', 'super-secret-admin')
      .expect(200);

    expect(res.body.limit).toBe(20);
  });

  it('status endpoint is exempt from rate limiting', async () => {
    const env = createTestEnv({ RATE_LIMIT_IP_MAX: '1' });
    const app = createApp(env);

    // Exhaust the single allowed request on /api/streams
    await request(app).get('/api/streams');

    // Status endpoint should still work
    const res = await request(app).get('/api/rate-limits').expect(200);
    expect(res.body.identifierType).toBe('ip');
  });
});

describe('API endpoints rate limiting', () => {
  it('returns 429 with correct body when IP limit hit on streams', async () => {
    const env = createTestEnv({ RATE_LIMIT_IP_MAX: '2' });
    const app = createApp(env);

    await request(app).get('/api/streams');
    await request(app).get('/api/streams');

    const res = await request(app).get('/api/streams').expect(429);

    expect(res.body).toMatchObject({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: expect.stringContaining('Retry after'),
        limit: 2,
        window: 'minute',
      },
    });
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('returns 429 when API key limit hit', async () => {
    const env = createTestEnv({ RATE_LIMIT_APIKEY_MAX: '1' });
    const app = createApp(env);

    await request(app)
      .get('/api/streams')
      .set('X-API-Key', 'my-partner-key');

    const res = await request(app)
      .get('/api/streams')
      .set('X-API-Key', 'my-partner-key')
      .expect(429);

    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('health endpoint is always exempt', async () => {
    const env = createTestEnv({ RATE_LIMIT_IP_MAX: '1' });
    const app = createApp(env);

    // Exhaust limit
    await request(app).get('/api/streams');

    // Health should still work
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('root endpoint is always exempt', async () => {
    const env = createTestEnv({ RATE_LIMIT_IP_MAX: '1' });
    const app = createApp(env);

    await request(app).get('/api/streams');
    const res = await request(app).get('/').expect(200);
    expect(res.body.name).toBe('Fluxora API');
  });

  it('sets rate limit headers on successful responses', async () => {
    const env = createTestEnv({ RATE_LIMIT_IP_MAX: '5' });
    const app = createApp(env);

    const res = await request(app).get('/api/streams').expect(200);

    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('different API keys have independent limits', async () => {
    const env = createTestEnv({ RATE_LIMIT_APIKEY_MAX: '1' });
    const app = createApp(env);

    await request(app).get('/api/streams').set('X-API-Key', 'partner-a');
    const res = await request(app).get('/api/streams').set('X-API-Key', 'partner-b').expect(200);

    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });
});
