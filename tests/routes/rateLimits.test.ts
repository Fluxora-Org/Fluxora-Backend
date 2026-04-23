import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { resetRuntimeRateLimitConfig } from '../../src/config/rateLimits.js';

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

// requireAdminAuth reads process.env.ADMIN_API_KEY directly, so we set/restore it in admin suites.

describe('GET /api/rate-limits', () => {
  beforeEach(() => resetRuntimeRateLimitConfig());

  it('returns 200 with rate limit status', async () => {
    const app = createApp({ env: createTestEnv() });
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
    const app = createApp({ env: createTestEnv({ RATE_LIMIT_IP_MAX: '3' }) });
    await request(app).get('/api/streams');
    await request(app).get('/api/streams');
    const res = await request(app).get('/api/rate-limits').expect(200);
    expect(res.body.remaining).toBe(1);
    expect(res.body.limit).toBe(3);
  });

  it('reports 0 remaining after exhaustion', async () => {
    const app = createApp({ env: createTestEnv({ RATE_LIMIT_IP_MAX: '2' }) });
    await request(app).get('/api/streams');
    await request(app).get('/api/streams');
    const res = await request(app).get('/api/rate-limits').expect(200);
    expect(res.body.remaining).toBe(0);
  });

  it('returns correct status for API key caller', async () => {
    const app = createApp({ env: createTestEnv({ RATE_LIMIT_APIKEY_MAX: '7' }) });
    const res = await request(app)
      .get('/api/rate-limits')
      .set('X-API-Key', 'my-test-key')
      .expect(200);
    expect(res.body.identifierType).toBe('apiKey');
    expect(res.body.limit).toBe(7);
    expect(res.body.identifier).toBe('my-t...-key');
  });

  it('uses admin limit for admin API key', async () => {
    const app = createApp({ env: createTestEnv({ RATE_LIMIT_APIKEY_MAX: '5', RATE_LIMIT_ADMIN_MAX: '20' }) });
    const res = await request(app)
      .get('/api/rate-limits')
      .set('X-API-Key', ADMIN_KEY)
      .expect(200);
    expect(res.body.limit).toBe(20);
  });

  it('status endpoint is exempt from rate limiting', async () => {
    const app = createApp({ env: createTestEnv({ RATE_LIMIT_IP_MAX: '1' }) });
    await request(app).get('/api/streams');
    const res = await request(app).get('/api/rate-limits').expect(200);
    expect(res.body.identifierType).toBe('ip');
  });
});

describe('API endpoints rate limiting', () => {
  beforeEach(() => resetRuntimeRateLimitConfig());

  it('returns 429 with correct body when IP limit hit on streams', async () => {
    const app = createApp({ env: createTestEnv({ RATE_LIMIT_IP_MAX: '2' }) });
    await request(app).get('/api/streams');
    await request(app).get('/api/streams');
    const res = await request(app).get('/api/streams').expect(429);
    expect(res.body).toMatchObject({
      error: { code: 'RATE_LIMIT_EXCEEDED', message: expect.stringContaining('Retry after'), limit: 2, window: 'minute' },
    });
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('returns 429 when API key limit hit', async () => {
    const app = createApp({ env: createTestEnv({ RATE_LIMIT_APIKEY_MAX: '1' }) });
    await request(app).get('/api/streams').set('X-API-Key', 'my-partner-key');
    const res = await request(app).get('/api/streams').set('X-API-Key', 'my-partner-key').expect(429);
    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('health endpoint is always exempt', async () => {
    const app = createApp({ env: createTestEnv({ RATE_LIMIT_IP_MAX: '1' }) });
    await request(app).get('/api/streams');
    await request(app).get('/health').expect(200);
  });

  it('root endpoint is always exempt', async () => {
    const app = createApp({ env: createTestEnv({ RATE_LIMIT_IP_MAX: '1' }) });
    await request(app).get('/api/streams');
    const res = await request(app).get('/').expect(200);
    expect(res.body.name).toBe('Fluxora API');
  });

  it('sets rate limit headers on successful responses', async () => {
    const app = createApp({ env: createTestEnv({ RATE_LIMIT_IP_MAX: '5' }) });
    const res = await request(app).get('/api/streams').expect(200);
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('different API keys have independent limits', async () => {
    const app = createApp({ env: createTestEnv({ RATE_LIMIT_APIKEY_MAX: '1' }) });
    await request(app).get('/api/streams').set('X-API-Key', 'partner-a');
    const res = await request(app).get('/api/streams').set('X-API-Key', 'partner-b').expect(200);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });
});

// ─── Admin GET/PUT /api/rate-limits/config ────────────────────────────────────

describe('GET /api/rate-limits/config', () => {
  let prevAdminKey: string | undefined;
  beforeEach(() => {
    resetRuntimeRateLimitConfig();
    prevAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });
  afterEach(() => {
    if (prevAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevAdminKey;
  });

  it('requires admin auth', async () => {
    const app = createApp({ env: createTestEnv() });
    await request(app).get('/api/rate-limits/config').expect(401);
  });

  it('returns defaults when no runtime override set', async () => {
    const app = createApp({ env: createTestEnv() });
    const res = await authed(request(app).get('/api/rate-limits/config')).expect(200);
    expect(res.body.source).toBe('default');
    expect(res.body.ip.max).toBe(5);
    expect(res.body.apiKey.max).toBe(10);
    expect(res.body.admin.max).toBe(20);
  });

  it('returns runtime source after a PUT', async () => {
    const app = createApp({ env: createTestEnv() });
    await authed(request(app).put('/api/rate-limits/config').send({ ip: { max: 99 } }));
    const res = await authed(request(app).get('/api/rate-limits/config')).expect(200);
    expect(res.body.source).toBe('runtime');
    expect(res.body.ip.max).toBe(99);
  });
});

describe('PUT /api/rate-limits/config', () => {
  let prevAdminKey: string | undefined;
  beforeEach(() => {
    resetRuntimeRateLimitConfig();
    prevAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });
  afterEach(() => {
    if (prevAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevAdminKey;
  });

  it('requires admin auth', async () => {
    const app = createApp({ env: createTestEnv() });
    await request(app).put('/api/rate-limits/config').send({ ip: { max: 50 } }).expect(401);
  });

  it('updates ip tier max', async () => {
    const app = createApp({ env: createTestEnv() });
    const res = await authed(
      request(app).put('/api/rate-limits/config').send({ ip: { max: 200 } }),
    ).expect(200);
    expect(res.body.config.ip.max).toBe(200);
    expect(res.body.message).toMatch(/updated/i);
  });

  it('updates apiKey tier', async () => {
    const app = createApp({ env: createTestEnv() });
    const res = await authed(
      request(app).put('/api/rate-limits/config').send({ apiKey: { max: 999, windowMs: 120000 } }),
    ).expect(200);
    expect(res.body.config.apiKey.max).toBe(999);
    expect(res.body.config.apiKey.windowMs).toBe(120000);
  });

  it('updates multiple tiers at once', async () => {
    const app = createApp({ env: createTestEnv() });
    const res = await authed(
      request(app).put('/api/rate-limits/config').send({ ip: { max: 50 }, admin: { max: 5000 } }),
    ).expect(200);
    expect(res.body.config.ip.max).toBe(50);
    expect(res.body.config.admin.max).toBe(5000);
  });

  it('merges partial patches (unspecified fields preserved)', async () => {
    const app = createApp({ env: createTestEnv() });
    await authed(request(app).put('/api/rate-limits/config').send({ ip: { max: 77 } }));
    const res = await authed(
      request(app).put('/api/rate-limits/config').send({ ip: { windowMs: 30000 } }),
    ).expect(200);
    expect(res.body.config.ip.max).toBe(77);
    expect(res.body.config.ip.windowMs).toBe(30000);
  });

  it('returns 400 when body is empty', async () => {
    const app = createApp({ env: createTestEnv() });
    const res = await authed(request(app).put('/api/rate-limits/config').send({})).expect(400);
    expect(res.body.error).toMatch(/at least one/i);
  });

  it('returns 400 for invalid max (non-integer)', async () => {
    const app = createApp({ env: createTestEnv() });
    const res = await authed(
      request(app).put('/api/rate-limits/config').send({ ip: { max: 'lots' } }),
    ).expect(400);
    expect(res.body.error).toMatch(/max/i);
  });

  it('returns 400 for invalid windowMs (< 1000)', async () => {
    const app = createApp({ env: createTestEnv() });
    const res = await authed(
      request(app).put('/api/rate-limits/config').send({ ip: { windowMs: 500 } }),
    ).expect(400);
    expect(res.body.error).toMatch(/windowMs/i);
  });

  it('returns 400 for invalid enabled (non-boolean)', async () => {
    const app = createApp({ env: createTestEnv() });
    const res = await authed(
      request(app).put('/api/rate-limits/config').send({ ip: { enabled: 'yes' } }),
    ).expect(400);
    expect(res.body.error).toMatch(/enabled/i);
  });

  it('returns 409 when all tiers would be disabled', async () => {
    const app = createApp({ env: createTestEnv() });
    const res = await authed(
      request(app).put('/api/rate-limits/config').send({
        ip:     { enabled: false },
        apiKey: { enabled: false },
        admin:  { enabled: false },
      }),
    ).expect(409);
    expect(res.body.error).toMatch(/disable all/i);
  });

  it('allows disabling a single tier', async () => {
    const app = createApp({ env: createTestEnv() });
    const res = await authed(
      request(app).put('/api/rate-limits/config').send({ ip: { enabled: false } }),
    ).expect(200);
    expect(res.body.config.ip.enabled).toBe(false);
    expect(res.body.config.apiKey.enabled).toBe(true);
  });
});
