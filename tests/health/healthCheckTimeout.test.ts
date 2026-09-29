/**
 * Integration tests for issue #1575 — Make health check timeouts explicit and bounded.
 *
 * Acceptance criteria validated here:
 *
 *   ✓ Each check declares a timeout.
 *   ✓ The endpoint returns within a bounded time regardless of dependency latency.
 *   ✓ A timed-out check reports as unhealthy rather than hanging.
 *   ✓ Timeouts are configurable through the schema (schema-level tests in
 *     src/config/health.test.ts; wiring tested via createBoundedHealthCheckManager).
 *
 * The key assertion in each test:
 *   - Register a checker whose `check()` never resolves (simulates a hung dependency).
 *   - Hit GET /health/ready.
 *   - Assert the response arrives within a wall-clock bound.
 *   - Assert the response body marks that dependency as unhealthy.
 */

import request from 'supertest';
import { describe, it, expect } from 'vitest';
import express from 'express';
import { healthRouter } from '../../src/routes/health.js';
import { HealthCheckManager, type HealthChecker } from '../../src/config/health.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function buildApp(checkers: HealthChecker[]) {
  const app = express();
  app.use(express.json());
  const manager = new HealthCheckManager();
  for (const c of checkers) manager.registerChecker(c);
  app.locals.healthManager = manager;
  app.use('/health', healthRouter);
  return app;
}

/** A checker whose check() promise never settles — simulates a hung dependency. */
function hangingChecker(name: string, timeoutMs: number): HealthChecker {
  return {
    name,
    timeoutMs,
    async check() {
      return new Promise(() => { /* intentionally never resolves */ });
    },
  };
}

/** A checker that resolves immediately as healthy. */
function healthyChecker(name: string): HealthChecker {
  return {
    name,
    async check() { return { latency: 1 }; },
  };
}

// ── Core acceptance-criteria tests ───────────────────────────────────────────

describe('GET /health/ready — hanging dependency responds within bound (issue #1575)', () => {
  it('responds within the checker timeout bound when postgres hangs', async () => {
    const TIMEOUT_MS = 200;
    const MAX_WALL_MS = TIMEOUT_MS + 400; // 400 ms scheduling-jitter allowance

    const app = buildApp([hangingChecker('postgres', TIMEOUT_MS)]);

    const start = Date.now();
    const res = await request(app).get('/health/ready');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(MAX_WALL_MS);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
  }, 5000);

  it('marks the hung dependency as unhealthy in the response', async () => {
    const app = buildApp([hangingChecker('postgres', 150)]);

    const res = await request(app).get('/health/ready');

    expect(res.body.dependencies.postgres).toBe('unhealthy');
  }, 5000);

  it('responds within bound when redis hangs', async () => {
    const TIMEOUT_MS = 150;
    const MAX_WALL_MS = TIMEOUT_MS + 400;

    const app = buildApp([
      healthyChecker('postgres'),
      hangingChecker('redis', TIMEOUT_MS),
      healthyChecker('stellar_rpc'),
    ]);

    const start = Date.now();
    const res = await request(app).get('/health/ready');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(MAX_WALL_MS);
    expect(res.status).toBe(503);
    expect(res.body.dependencies.redis).toBe('unhealthy');
    expect(res.body.dependencies.postgres).toBe('healthy');
    expect(res.body.dependencies.stellar_rpc).toBe('healthy');
  }, 5000);

  it('responds within bound when stellar_rpc hangs', async () => {
    const TIMEOUT_MS = 150;
    const MAX_WALL_MS = TIMEOUT_MS + 400;

    const app = buildApp([
      healthyChecker('postgres'),
      healthyChecker('redis'),
      hangingChecker('stellar_rpc', TIMEOUT_MS),
    ]);

    const start = Date.now();
    const res = await request(app).get('/health/ready');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(MAX_WALL_MS);
    expect(res.status).toBe(503);
    expect(res.body.dependencies.stellar_rpc).toBe('unhealthy');
  }, 5000);

  it('responds within bound when all three dependencies hang', async () => {
    const TIMEOUT_MS = 150;
    const MAX_WALL_MS = TIMEOUT_MS + 600; // all run in parallel, not in series

    const app = buildApp([
      hangingChecker('postgres',    TIMEOUT_MS),
      hangingChecker('redis',       TIMEOUT_MS),
      hangingChecker('stellar_rpc', TIMEOUT_MS),
    ]);

    const start = Date.now();
    const res = await request(app).get('/health/ready');
    const elapsed = Date.now() - start;

    // All checkers run concurrently, so the total elapsed time is bounded by
    // one timeout — not three.
    expect(elapsed).toBeLessThan(MAX_WALL_MS);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');

    for (const name of ['postgres', 'redis', 'stellar_rpc']) {
      expect(res.body.dependencies[name]).toBe('unhealthy');
    }
  }, 5000);

  it('healthy dependencies are unaffected when one checker hangs', async () => {
    const app = buildApp([
      healthyChecker('postgres'),
      hangingChecker('redis', 150),
      healthyChecker('stellar_rpc'),
    ]);

    const res = await request(app).get('/health/ready');

    // Overall verdict is unhealthy because one dep is unhealthy, but the
    // other two are correctly reported as healthy.
    expect(res.body.dependencies.postgres).toBe('healthy');
    expect(res.body.dependencies.redis).toBe('unhealthy');
    expect(res.body.dependencies.stellar_rpc).toBe('healthy');
  }, 5000);

  it('concurrent requests are each served within the bound independently', async () => {
    const TIMEOUT_MS = 150;
    const MAX_WALL_MS = TIMEOUT_MS + 600;

    const app = buildApp([hangingChecker('postgres', TIMEOUT_MS)]);

    const start = Date.now();
    const responses = await Promise.all([
      request(app).get('/health/ready'),
      request(app).get('/health/ready'),
      request(app).get('/health/ready'),
    ]);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(MAX_WALL_MS);
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(res.body.dependencies.postgres).toBe('unhealthy');
    }
  }, 5000);
});

// ── Per-checker timeout declaration ──────────────────────────────────────────

describe('GET /health/ready — per-checker timeout declaration', () => {
  it('checker with a short timeoutMs times out faster than default 5 000 ms', async () => {
    const SHORT_TIMEOUT = 100;
    // Without the per-checker timeout the test would take ~5 000 ms (the
    // default HEALTH_CHECK_TIMEOUT_MS). With it it should finish in ~100 ms.
    const MAX_WALL_MS = SHORT_TIMEOUT + 400;

    const app = buildApp([hangingChecker('postgres', SHORT_TIMEOUT)]);

    const start = Date.now();
    await request(app).get('/health/ready');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(MAX_WALL_MS);
  }, 5000);

  it('checker without timeoutMs still completes (falls back to global default)', async () => {
    // A checker that resolves quickly should always succeed regardless of
    // whether it declares timeoutMs, confirming the fallback path works.
    const app = buildApp([
      {
        name: 'no-timeout-declared',
        // No timeoutMs — manager falls back to HEALTH_CHECK_TIMEOUT_MS (5 000 ms).
        async check() { return { latency: 1 }; },
      },
    ]);

    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.dependencies['no-timeout-declared']).toBe('healthy');
  });
});
