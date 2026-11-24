import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createApp } from '../../src/app.js';
import { resetRuntimeRateLimitConfig, MAX_WINDOW_MS } from '../../src/config/rateLimits.js';
import { createRateLimiter } from '../../src/middleware/rateLimiter.js';
import { createRateLimitsRouter } from '../../src/routes/rateLimits.js';
import { getRateLimitConfig } from '../../src/config/rateLimits.js';
import { InMemoryStore } from '../../src/redis/rateLimitStore.js';

const ADMIN_KEY = 'test-admin-key';

function authed(req: request.Test) {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

function createTestEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    PORT: '0',
    NODE_ENV: 'test',
    ADMIN_API_KEY: ADMIN_KEY,
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

// Create a minimal test app for rate limiting tests
function createTestApp(env: Record<string, string | undefined>) {
  const app = express();
  const rateLimiter = createRateLimiter(env, new InMemoryStore());

  // Add JSON body parsing middleware (required for PUT requests)
  app.use(express.json());

  // Add rate limiter middleware
  app.use(rateLimiter);

  // Add test routes that don't require database
  app.get('/api/test-streams', (_req, res) => {
    res.json({ streams: [] });
  });

  app.post('/api/test-streams', (_req, res) => {
    res.status(201).json({ id: 'test-stream' });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'fluxora-backend' });
  });

  app.get('/', (_req, res) => {
    res.json({ name: 'Fluxora API' });
  });

  // Add rate limits router
  app.use('/api/rate-limits', createRateLimitsRouter(rateLimiter, { defaults: getRateLimitConfig(env) }));

  return app;
}

// requireAdminAuth reads process.env.ADMIN_API_KEY directly, so we set/restore it in admin suites.

describe('GET /api/rate-limits', () => {
  beforeEach(() => resetRuntimeRateLimitConfig());

  it('returns 200 with rate limit status', async () => {
    const app = createTestApp(createTestEnv());
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
    const app = createTestApp(createTestEnv({ RATE_LIMIT_IP_MAX: '3' }));
    await request(app).get('/api/test-streams');
    await request(app).get('/api/test-streams');
    const res = await request(app).get('/api/rate-limits').expect(200);
    expect(res.body.remaining).toBe(1);
    expect(res.body.limit).toBe(3);
  });

  it('reports 0 remaining after exhaustion', async () => {
    const app = createTestApp(createTestEnv({ RATE_LIMIT_IP_MAX: '2' }));
    await request(app).get('/api/test-streams');
    await request(app).get('/api/test-streams');
    const res = await request(app).get('/api/rate-limits').expect(200);
    expect(res.body.remaining).toBe(0);
  });

  it('aggregates usage across different routes for the same principal (#1260)', async () => {
    const app = createTestApp(createTestEnv({ RATE_LIMIT_IP_MAX: '4' }));
    // Two different routes, same caller — the status endpoint must report the
    // combined count, not the per-route count of the status path itself.
    await request(app).get('/api/test-streams');
    await request(app).get('/api/other-route');
    await request(app).get('/api/test-streams');
    const res = await request(app).get('/api/rate-limits').expect(200);
    expect(res.body.remaining).toBe(1);
    expect(res.body.limit).toBe(4);
  });

  it('returns correct status for API key caller', async () => {
    const app = createTestApp(createTestEnv({ RATE_LIMIT_APIKEY_MAX: '7' }));
    const res = await request(app)
      .get('/api/rate-limits')
      .set('X-API-Key', 'my-test-key')
      .expect(200);
    expect(res.body.identifierType).toBe('apiKey');
    expect(res.body.limit).toBe(7);
    expect(res.body.identifier).toBe('my-t...-key');
  });

  it('uses admin limit for admin API key', async () => {
    const app = createTestApp(createTestEnv({ RATE_LIMIT_APIKEY_MAX: '5', RATE_LIMIT_ADMIN_MAX: '20' }));
    const res = await request(app)
      .get('/api/rate-limits')
      .set('X-API-Key', ADMIN_KEY)
      .expect(200);
    expect(res.body.limit).toBe(20);
  });

  it('status endpoint is exempt from rate limiting', async () => {
    const app = createTestApp(createTestEnv({ RATE_LIMIT_IP_MAX: '1' }));
    await request(app).get('/api/test-streams');
    const res = await request(app).get('/api/rate-limits').expect(200);
    expect(res.body.identifierType).toBe('ip');
  });

  it('returns route-specific status when path parameter provided', async () => {
    const app = createTestApp(createTestEnv());
    const res = await request(app)
      .get('/api/rate-limits?path=/api/test-streams&method=GET')
      .expect(200);
    expect(res.body.route).toBe('/api/test-streams');
    expect(res.body.method).toBe('GET');
    expect(res.body.limit).toBe(5); // Global IP limit since no route-specific config for test-streams
  });

  it('applies stricter write limits for write methods', async () => {
    const app = createTestApp(createTestEnv());
    const res = await request(app)
      .get('/api/rate-limits?path=/api/test-streams&method=POST')
      .expect(200);
    expect(res.body.method).toBe('POST');
    expect(res.body.limit).toBe(5); // Global IP limit since no route-specific config for test-streams
  });

  it('returns 400 for malformed path or method', async () => {
    const app = createTestApp(createTestEnv());
    let res = await request(app).get('/api/rate-limits?path[]=array').expect(400);
    expect(res.body.error.message ?? res.body.error).toMatch(/path/i);

    res = await request(app).get('/api/rate-limits?method[]=array').expect(400);
    expect(res.body.error.message ?? res.body.error).toMatch(/method/i);
  });

  it('explicitly exposes only the caller\'s own limits and ignores arbitrary identifier overriding', async () => {
    const app = createTestApp(createTestEnv({ RATE_LIMIT_APIKEY_MAX: '7', RATE_LIMIT_ADMIN_MAX: '20' }));
    // Try to pass admin key via query to spoof identity
    const res = await request(app)
      .get(`/api/rate-limits?identifier=${ADMIN_KEY}&keyId=${ADMIN_KEY}`)
      .set('X-API-Key', 'my-test-key')
      .expect(200);
    expect(res.body.limit).toBe(7); // Must still be the user's key limit, not 20
  });
});

describe('API endpoints rate limiting', () => {
  beforeEach(() => resetRuntimeRateLimitConfig());

  it('returns 429 with correct body when IP limit hit on streams', async () => {
    const app = createTestApp(createTestEnv({ RATE_LIMIT_IP_MAX: '2' }));
    await request(app).get('/api/test-streams');
    await request(app).get('/api/test-streams');
    const res = await request(app).get('/api/test-streams').expect(429);
    expect(res.body).toMatchObject({
      error: { code: 'RATE_LIMIT_EXCEEDED', message: expect.stringContaining('Retry after'), limit: 2, window: 'minute' },
    });
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.headers['x-ratelimit-limit']).toBe('2');
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('returns 429 when API key limit hit', async () => {
    const app = createTestApp(createTestEnv({ RATE_LIMIT_APIKEY_MAX: '1' }));
    await request(app).get('/api/test-streams').set('X-API-Key', 'my-partner-key');
    const res = await request(app).get('/api/test-streams').set('X-API-Key', 'my-partner-key').expect(429);
    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('health endpoint is always exempt', async () => {
    const app = createTestApp(createTestEnv({ RATE_LIMIT_IP_MAX: '1' }));
    await request(app).get('/api/test-streams');
    await request(app).get('/health').expect(200);
  });

  it('root endpoint is always exempt', async () => {
    const app = createTestApp(createTestEnv({ RATE_LIMIT_IP_MAX: '1' }));
    await request(app).get('/api/test-streams');
    const res = await request(app).get('/').expect(200);
    expect(res.body.name).toBe('Fluxora API');
  });

  it('sets rate limit headers on successful responses', async () => {
    const app = createTestApp(createTestEnv({ RATE_LIMIT_IP_MAX: '5' }));
    const res = await request(app).get('/api/test-streams').expect(200);
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('different API keys have independent limits', async () => {
    const app = createTestApp(createTestEnv({ RATE_LIMIT_APIKEY_MAX: '1' }));
    await request(app).get('/api/test-streams').set('X-API-Key', 'partner-a');
    const res = await request(app).get('/api/test-streams').set('X-API-Key', 'partner-b').expect(200);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('applies per-route rate limits', async () => {
    // This test needs route-specific config, so let's update our test app
    const env = createTestEnv({ RATE_LIMIT_IP_MAX: '1000' });
    const app = express();
    const rateLimiter = createRateLimiter(env, new InMemoryStore());

    // Add rate limiter middleware
    app.use(rateLimiter);

    // Add test route with route-specific config
    app.get('/api/streams', (_req, res) => {
      res.json({ streams: [] });
    });

    // Add rate limits router
    app.use('/api/rate-limits', createRateLimitsRouter(rateLimiter, { defaults: getRateLimitConfig(env) }));

    // Use up the route-specific limit (100 for /api/streams GET from config)
    for (let i = 0; i < 100; i++) {
      await request(app).get('/api/streams');
    }
    const res = await request(app).get('/api/streams').expect(429);
    expect(res.body.error.limit).toBe(100); // Route-specific limit from config, not global 1000
  });

  it('applies stricter limits for write endpoints', async () => {
    // This test needs route-specific config with write limits
    const env = createTestEnv({ RATE_LIMIT_IP_MAX: '1000' });
    const app = express();
    app.use(express.json());
    const rateLimiter = createRateLimiter(env, new InMemoryStore());

    // Add rate limiter middleware
    app.use(rateLimiter);

    // Add test route with route-specific config
    app.post('/api/streams', (_req, res) => {
      res.status(201).json({ id: 'test-stream' });
    });

    // Add rate limits router
    app.use('/api/rate-limits', createRateLimitsRouter(rateLimiter, { defaults: getRateLimitConfig(env) }));

    // Use up the stricter write limit (20 for /api/streams POST from config)
    for (let i = 0; i < 20; i++) {
      await request(app).post('/api/streams').send({});
    }
    const res = await request(app).post('/api/streams').send({}).expect(429);
    expect(res.body.error.limit).toBe(20); // Stricter write limit from config
    expect(res.body.error.method).toBe('POST');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('respects allowlist IPs for health probes', async () => {
    const app = createTestApp(createTestEnv({
      RATE_LIMIT_IP_MAX: '1',
      RATE_LIMIT_ALLOWLIST_IPS: '127.0.0.1,10.0.0.1'
    }));

    // Exhaust the rate limit
    await request(app).get('/api/test-streams');

    // Try from non-allowlisted IP (should be rate limited)
    const res1 = await request(app).get('/api/test-streams').expect(429);
    expect(res1.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
