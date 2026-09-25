/**
 * Negative-path contract tests for src/routes/health.ts (issue #1543).
 *
 * The deciding question for a health endpoint is whether a dependency failure
 * marks the *process* unhealthy (liveness) or merely *not ready* (readiness).
 * This suite pins that separation, then covers every endpoint of the module
 * (`/health`, `/health/ready`, `/health/live`, `/health/deployment`) with
 * malformed input, missing / insufficient credentials, boundary values and the
 * documented error shape.
 *
 * Notes on scope:
 *  - None of these endpoints takes a path parameter, query parameter or body,
 *    so "malformed input" means unexpected or malformed input the route must
 *    ignore or reject cleanly (odd query strings, a bad JSON body, wrong
 *    methods, unknown sub-paths).
 *  - docs/authentication.md §4 lists all four endpoints as public
 *    (credential: None), so "missing / insufficient authorisation" means:
 *    no credentials are required, and wrong or low-privilege credentials never
 *    turn a probe into a 401/403.
 *  - The router is mounted on a small app with the real correlation-id, 404
 *    and error-handler middleware, so error bodies are the documented envelope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { healthRouter } from '../../src/routes/health.js';
import { HealthCheckManager, type HealthChecker } from '../../src/config/health.js';
import type { Config } from '../../src/config/env.js';
import type { Logger } from '../../src/config/logger.js';
import { correlationIdMiddleware } from '../../src/middleware/correlationId.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { notFound } from '../../src/errors.js';
import { _resetShutdownState } from '../../src/shutdown.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const ENDPOINTS = ['/health', '/health/ready', '/health/live', '/health/deployment'] as const;

const healthy = (name: string): HealthChecker => ({
  name,
  async check() {
    return { latency: 1 };
  },
});

const degraded = (name: string): HealthChecker => ({
  name,
  async check() {
    return { latency: 1, degraded: true };
  },
});

const unhealthy = (name: string, error = 'Connection refused'): HealthChecker => ({
  name,
  async check() {
    return { latency: 1, error };
  },
});

/** Minimal non-production config: every deployment check passes or is n/a. */
const devConfig = {
  nodeEnv: 'development',
  deploymentChecklistVersion: 'test-v1',
  requirePartnerAuth: false,
  requireAdminAuth: false,
  redisEnabled: false,
  workerEnabled: false,
  indexerEnabled: false,
  metricsEnabled: true,
} as unknown as Config;

interface BuildOptions {
  checkers?: HealthChecker[];
  /** Pass `null` to mount the router with no health manager at all. */
  manager?: HealthCheckManager | null;
  config?: Config;
  logger?: Logger;
}

function buildApp(opts: BuildOptions = {}) {
  const app = express();
  app.use(correlationIdMiddleware);
  app.use(express.json());

  if (opts.manager !== null) {
    const manager = opts.manager ?? new HealthCheckManager();
    (opts.checkers ?? []).forEach((checker) => manager.registerChecker(checker));
    app.locals.healthManager = manager;
  }
  if (opts.config) app.locals.config = opts.config;
  if (opts.logger) app.locals.logger = opts.logger;

  app.use('/health', healthRouter);
  app.use((_req, _res, next) => next(notFound('The requested resource was')));
  app.use(errorHandler);
  return app;
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

/** The documented error envelope: { success: false, error: { code, message, … } }. */
function expectErrorEnvelope(body: { success?: unknown; error?: Record<string, unknown> }, code: string) {
  const error = body.error as { code: string; message: string } & Record<string, unknown>;
  expect(body.success).toBe(false);
  expect(error.code).toBe(code);
  expect(typeof error.message).toBe('string');
  expect(error.message.length).toBeGreaterThan(0);
  expect(Object.keys(body)).toEqual(['success', 'error']);
  for (const key of Object.keys(error)) {
    expect(['code', 'message', 'details', 'requestId']).toContain(key);
  }
  expect(JSON.stringify(body)).not.toMatch(/stack/i);
}

const shape = (body: unknown) =>
  body && typeof body === 'object' ? Object.keys(body as object).sort() : [];

/** Config-aware app for endpoints that need `app.locals.config` to answer. */
const appFor = (endpoint: string) =>
  buildApp({ checkers: [healthy('postgres')], config: endpoint === '/health/deployment' ? devConfig : undefined });

beforeEach(() => {
  // The error handler logs every API error to stderr; keep test output readable.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  _resetShutdownState();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 1. Liveness vs readiness ─────────────────────────────────────────────────

describe('liveness is separate from readiness', () => {
  it('unhealthy dependency: /health/ready is 503 while /health stays 200 "ok"', async () => {
    const app = buildApp({ checkers: [healthy('redis'), unhealthy('postgres')] });

    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.status).toBe('unhealthy');
    expect(ready.body.dependencies).toEqual({ redis: 'healthy', postgres: 'unhealthy' });

    const live = await request(app).get('/health');
    expect(live.status).toBe(200);
    expect(live.body.status).toBe('ok');
    // Liveness reports the process, not the readiness dependencies.
    expect(Object.keys(live.body.dependencies)).toEqual(['indexer']);
  });

  it('every dependency unhealthy still leaves /health alive', async () => {
    const app = buildApp({ checkers: [unhealthy('postgres'), unhealthy('redis'), unhealthy('stellar_rpc')] });

    expect((await request(app).get('/health/ready')).status).toBe(503);
    const live = await request(app).get('/health');
    expect(live.status).toBe(200);
    expect(live.body.status).not.toBe('unhealthy');
    expect(['ok', 'degraded']).toContain(live.body.status);
  });

  it('/health/live reports a failed dependency in the body but answers 200', async () => {
    const app = buildApp({ checkers: [unhealthy('postgres')] });
    await request(app).get('/health/ready'); // populates the last report

    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.report.status).toBe('unhealthy');
  });

  it('liveness endpoints never probe dependencies; only readiness does', async () => {
    const check = vi.fn(async () => ({ latency: 1, error: 'down' }));
    const app = buildApp({ checkers: [{ name: 'postgres', check }] });

    await request(app).get('/health');
    const beforeReady = await request(app).get('/health/live');
    expect(check).not.toHaveBeenCalled();
    // Nothing has been probed yet, so the cached report is still the initial one.
    expect(beforeReady.body.data.report.status).toBe('healthy');

    await request(app).get('/health/ready');
    expect(check).toHaveBeenCalledTimes(1);

    const afterReady = await request(app).get('/health/live');
    expect(check).toHaveBeenCalledTimes(1);
    expect(afterReady.body.data.report.status).toBe('unhealthy');
  });

  it('dependency degraded during startup: not ready (503) but alive (200)', async () => {
    const app = buildApp({ checkers: [degraded('postgres')] });

    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.status).toBe('degraded');
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('no health manager: not ready (503 "unhealthy") but the process is alive', async () => {
    const app = buildApp({ manager: null });

    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({
      status: 'unhealthy',
      reason: 'Health manager not configured',
      dependencies: {},
    });
    expect((await request(app).get('/health')).status).toBe(200);
    const live = await request(app).get('/health/live');
    expect(live.status).toBe(200);
    expect(live.body.data.report.dependencies).toEqual([]);
  });

  describe('during graceful shutdown', () => {
    beforeEach(() => {
      process.env['FLUXORA_SHUTDOWN'] = 'true';
    });

    it('/health answers 503 with the flat "shutting_down" body', async () => {
      const res = await request(buildApp()).get('/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('shutting_down');
      expect(res.body.service).toBe('fluxora-backend');
      expect(res.body.message).toBe('Service is shutting down');
      expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
    });

    it('/health/ready answers 503 with the error envelope and probes nothing', async () => {
      const check = vi.fn(async () => ({ latency: 1 }));
      const app = buildApp({ checkers: [{ name: 'postgres', check }] });

      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(503);
      expectErrorEnvelope(res.body, 'SERVICE_SHUTTING_DOWN');
      expect(check).not.toHaveBeenCalled();
    });

    it('/health/live keeps returning its report (it is not shutdown-gated)', async () => {
      const res = await request(buildApp({ checkers: [healthy('postgres')] })).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});

// ── 2. Malformed input ───────────────────────────────────────────────────────

describe.each(ENDPOINTS)('%s — malformed input', (endpoint) => {
  const QUERY_NOISE = [
    '?deep=true&verbose=1&format=xml',
    '?a[]=1&a[]=2&b[c]=d',
    '?x=%E0%A4%A', // truncated percent-encoding
    '?%',
    '?x=%00%0d%0a', // NUL / CRLF
    '?=&&&==',
    '?x=' + 'A'.repeat(2048),
  ];

  it.each(QUERY_NOISE)('ignores unexpected or malformed query string %#', async (query) => {
    const app = appFor(endpoint);
    const baseline = await request(app).get(endpoint);
    const res = await request(app).get(`${endpoint}${query}`);

    expect(res.status).toBe(baseline.status);
    expect(shape(res.body)).toEqual(shape(baseline.body));
  });

  it('ignores a well-formed JSON body it does not need', async () => {
    const app = appFor(endpoint);
    const baseline = await request(app).get(endpoint);
    const res = await request(app).get(endpoint).send({ unexpected: 'field', nested: { a: [1, 2, 3] } });

    expect(res.status).toBe(baseline.status);
    expect(shape(res.body)).toEqual(shape(baseline.body));
  });

  it('rejects a malformed JSON body with the 400 VALIDATION_ERROR envelope', async () => {
    const res = await request(appFor(endpoint))
      .get(endpoint)
      .set('Content-Type', 'application/json')
      .send('{bad json');

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Request body is not valid JSON');
    expect(typeof res.body.error.requestId).toBe('string');
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)('%s is not routed (404 NOT_FOUND envelope)', async (method) => {
    const res = await request(appFor(endpoint))[method](endpoint);

    expect(res.status).toBe(404);
    expectErrorEnvelope(res.body, 'NOT_FOUND');
  });
});

describe('health sub-paths that do not exist', () => {
  it.each([
    '/health/unknown',
    '/health/ready/extra',
    '/health/live/extra',
    '/health/deployment/extra',
    '/health/%E0%A4%A', // truncated percent-encoding in the path
    '/health/ready%2F..%2F..',
  ])('GET %s returns the 404 NOT_FOUND envelope', async (path) => {
    const res = await request(buildApp({ checkers: [healthy('postgres')], config: devConfig })).get(path);

    expect(res.status).toBe(404);
    expectErrorEnvelope(res.body, 'NOT_FOUND');
  });
});

// ── 3. Missing and insufficient authorisation ────────────────────────────────

describe.each(ENDPOINTS)('%s — authorisation (public per docs/authentication.md §4)', (endpoint) => {
  const CREDENTIALS: Array<[string, Record<string, string>]> = [
    ['no credentials', {}],
    ['garbage bearer token', { Authorization: 'Bearer not-a-jwt' }],
    ['oversized bearer token', { Authorization: 'Bearer ' + 'a'.repeat(4096) }],
    ['low-privilege looking JWT', { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoidmlld2VyIn0.bad-signature' }],
    ['malformed basic auth', { Authorization: 'Basic !!!' }],
    ['unknown auth scheme', { Authorization: 'Digest nonsense' }],
    ['wrong API key', { 'X-API-Key': 'wrong-key' }],
    ['bogus session cookie', { Cookie: 'token=bogus; session=xyz' }],
  ];

  it.each(CREDENTIALS)('%s never produces 401/403 and is never echoed', async (_label, headers) => {
    const app = appFor(endpoint);
    const baseline = await request(app).get(endpoint);
    const res = await request(app).get(endpoint).set(headers);

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(baseline.status);
    expect(res.headers['www-authenticate']).toBeUndefined();
    for (const value of Object.values(headers)) {
      expect(JSON.stringify(res.body)).not.toContain(value);
    }
  });
});

// ── 4. Boundary values ───────────────────────────────────────────────────────

describe('boundary values', () => {
  describe('startup grace period (30 s) on /health/ready', () => {
    const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

    function frozenApp() {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
      return buildApp({ checkers: [degraded('postgres')] }); // manager.startTime === T0
    }

    it('uptime 29 s (29.999 s): degraded dependency → 503 during startup', async () => {
      const app = frozenApp();
      vi.setSystemTime(T0 + 29_999);

      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
    });

    it('uptime exactly 30 s: freshly degraded dependency → 200 "degraded"', async () => {
      const app = frozenApp();
      vi.setSystemTime(T0 + 30_000);

      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
    });

    it('degraded for 29.999 s → 200; degraded for exactly 30 s → 503', async () => {
      const app = frozenApp();
      vi.setSystemTime(T0 + 60_000);
      expect((await request(app).get('/health/ready')).status).toBe(200); // degradedSince = T0 + 60 s

      vi.setSystemTime(T0 + 60_000 + 29_999);
      expect((await request(app).get('/health/ready')).status).toBe(200);

      vi.setSystemTime(T0 + 60_000 + 30_000);
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
    });
  });

  describe('number of registered dependencies on /health/ready', () => {
    it.each([0, 1, 50])('%i healthy dependencies → 200 with a map of that size', async (count) => {
      const checkers = Array.from({ length: count }, (_, i) => healthy(`dep_${i}`));
      const res = await request(buildApp({ checkers })).get('/health/ready');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(Object.keys(res.body.dependencies)).toHaveLength(count);
    });

    it('one unhealthy dependency among 50 → 503 naming only that dependency', async () => {
      const checkers = Array.from({ length: 50 }, (_, i) => (i === 49 ? unhealthy('dep_49') : healthy(`dep_${i}`)));
      const res = await request(buildApp({ checkers })).get('/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      const bad = Object.entries(res.body.dependencies).filter(([, status]) => status !== 'healthy');
      expect(bad).toEqual([['dep_49', 'unhealthy']]);
    });
  });

  describe('request size and shape', () => {
    it.each([1, 1000, 1001])('%i query parameters are ignored', async (count) => {
      const query = Array.from({ length: count }, (_, i) => `p${i}=${i}`).join('&');
      const res = await request(buildApp()).get(`/health?${query}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it.each([0, 1, 8000])('a %i-character query value is ignored', async (length) => {
      const res = await request(buildApp()).get(`/health/ready?x=${'A'.repeat(length)}`);
      expect(res.status).toBe(200);
    });

    it.each(['/health/', '/HEALTH', '/health//ready', '/health/ready/', '/HEALTH/LIVE'])(
      'equivalent path form %s is still served',
      async (path) => {
        const res = await request(buildApp({ checkers: [healthy('postgres')] })).get(path);
        expect(res.status).toBe(200);
      },
    );
  });

  describe('/health/deployment status → HTTP code', () => {
    it('pass → 200', async () => {
      const res = await request(buildApp({ checkers: [healthy('postgres')], config: devConfig })).get('/health/deployment');
      expect(res.status).toBe(200);
      expect(res.body.report.status).toBe('pass');
    });

    it('warn (metrics disabled) → 200', async () => {
      const config = { ...devConfig, metricsEnabled: false } as unknown as Config;
      const res = await request(buildApp({ checkers: [healthy('postgres')], config })).get('/health/deployment');
      expect(res.status).toBe(200);
      expect(res.body.report.status).toBe('warn');
    });

    it('fail (unhealthy dependency) → 503, while /health stays 200', async () => {
      const app = buildApp({ checkers: [unhealthy('postgres')], config: devConfig });
      const res = await request(app).get('/health/deployment');
      expect(res.status).toBe(503);
      expect(res.body.report.status).toBe('fail');
      expect((await request(app).get('/health')).status).toBe(200);
    });

    it('fail (production without Redis) → 503', async () => {
      const config = { ...devConfig, nodeEnv: 'production' } as unknown as Config;
      const res = await request(buildApp({ checkers: [healthy('postgres')], config })).get('/health/deployment');
      expect(res.status).toBe(503);
      expect(res.body.report.status).toBe('fail');
    });
  });
});

// ── 5. Documented error shape when the handler itself fails ──────────────────

describe('failures return the documented error shape without leaking internals', () => {
  const SECRET = 'postgres://admin:hunter2@db.internal:5432/fluxora';

  it('/health/ready: a throwing readiness check → 503 HEALTH_CHECK_ERROR', async () => {
    const manager = new HealthCheckManager();
    manager.checkAll = vi.fn().mockRejectedValue(new Error(`connect failed: ${SECRET}`));
    const logger = fakeLogger();

    const res = await request(buildApp({ manager, logger })).get('/health/ready');

    expect(res.status).toBe(503);
    expectErrorEnvelope(res.body, 'HEALTH_CHECK_ERROR');
    expect(res.body.error.message).toBe('Health check failed');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(logger.error).toHaveBeenCalledTimes(1); // detail goes to the log, not the response
  });

  it('/health/live: a failing report read → 500 HEALTH_CHECK_ERROR', async () => {
    const manager = new HealthCheckManager();
    manager.getLastReport = vi.fn(() => {
      throw new Error(`report failed: ${SECRET}`);
    });

    const res = await request(buildApp({ manager, logger: fakeLogger() })).get('/health/live');

    expect(res.status).toBe(500);
    expectErrorEnvelope(res.body, 'HEALTH_CHECK_ERROR');
    expect(res.body.error.message).toBe('Failed to get health report');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('/health/deployment: no config loaded → 503 HEALTH_CHECK_ERROR', async () => {
    const res = await request(buildApp({ checkers: [healthy('postgres')] })).get('/health/deployment');

    expect(res.status).toBe(503);
    expectErrorEnvelope(res.body, 'HEALTH_CHECK_ERROR');
    expect(res.body.error.message).toBe('Config not loaded');
  });

  it('/health/deployment: a throwing dependency check → 500 HEALTH_CHECK_ERROR', async () => {
    const manager = new HealthCheckManager();
    manager.checkAll = vi.fn().mockRejectedValue(new Error(`boom: ${SECRET}`));

    const res = await request(buildApp({ manager, config: devConfig, logger: fakeLogger() })).get('/health/deployment');

    expect(res.status).toBe(500);
    expectErrorEnvelope(res.body, 'HEALTH_CHECK_ERROR');
    expect(res.body.error.message).toBe('Failed to generate deployment report');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});
