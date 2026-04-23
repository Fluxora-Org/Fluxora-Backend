/**
 * Integration tests for GET /health/ready and GET /health
 *
 * Covers:
 *  - All dependencies healthy → 200 "healthy"
 *  - Any dependency degraded (high latency) → 200 "degraded"
 *  - Any dependency unhealthy (error) → 503 "unhealthy"
 *  - Checker throws unexpectedly → 503 "unhealthy"
 *  - No health manager configured → 503
 *  - Redis dependency checks
 *  - Sensitive data is never leaked in responses
 *  - Flat dependencies map shape
 */

import request from 'supertest';
import { describe, it, expect } from 'vitest';
import express from 'express';
import { healthRouter } from '../src/routes/health.js';
import { HealthCheckManager } from '../src/config/health.js';
import type { HealthChecker } from '../src/config/health.js';

function buildApp(checkers: HealthChecker[]) {
  const app = express();
  app.use(express.json());

  const manager = new HealthCheckManager();
  checkers.forEach((c) => manager.registerChecker(c));
  app.locals.healthManager = manager;

  app.use('/health', healthRouter);
  return app;
}

const healthyChecker = (name: string): HealthChecker => ({
  name,
  async check() { return { latency: 1 }; },
});

const degradedChecker = (name: string): HealthChecker => ({
  name,
  async check() { return { latency: 1, degraded: true }; },
});

const unhealthyChecker = (name: string, error = 'Connection refused'): HealthChecker => ({
  name,
  async check() { return { latency: 1, error }; },
});

const throwingChecker = (name: string): HealthChecker => ({
  name,
  async check() { throw new Error('Unexpected failure'); },
});

// ── All healthy ───────────────────────────────────────────────────────────────

describe('GET /health/ready — all dependencies healthy', () => {
  it('returns 200', async () => {
    const app = buildApp([healthyChecker('postgres'), healthyChecker('stellar_rpc')]);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
  });

  it('response status is "healthy"', async () => {
    const app = buildApp([healthyChecker('postgres'), healthyChecker('stellar_rpc')]);
    const res = await request(app).get('/health/ready');
    expect(res.body.status).toBe('healthy');
  });

  it('response includes flat dependencies map', async () => {
    const app = buildApp([healthyChecker('postgres'), healthyChecker('stellar_rpc')]);
    const res = await request(app).get('/health/ready');
    expect(res.body.dependencies).toEqual({ postgres: 'healthy', stellar_rpc: 'healthy' });
  });

  it('response includes version', async () => {
    const app = buildApp([healthyChecker('postgres')]);
    const res = await request(app).get('/health/ready');
    expect(typeof res.body.version).toBe('string');
  });

  it('includes all three core dependencies when registered', async () => {
    const app = buildApp([
      healthyChecker('postgres'),
      healthyChecker('redis'),
      healthyChecker('stellar_rpc'),
    ]);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.dependencies).toEqual({
      postgres: 'healthy',
      redis: 'healthy',
      stellar_rpc: 'healthy',
    });
  });
});

// ── Degraded classification ───────────────────────────────────────────────────

describe('GET /health/ready — degraded classification', () => {
  it('returns 200 when a dependency is degraded (not 503)', async () => {
    const app = buildApp([degradedChecker('postgres'), healthyChecker('stellar_rpc')]);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
  });

  it('response status is "degraded" when any dependency is degraded', async () => {
    const app = buildApp([degradedChecker('postgres'), healthyChecker('stellar_rpc')]);
    const res = await request(app).get('/health/ready');
    expect(res.body.status).toBe('degraded');
  });

  it('dependencies map shows degraded status for slow dependency', async () => {
    const app = buildApp([degradedChecker('postgres'), healthyChecker('stellar_rpc')]);
    const res = await request(app).get('/health/ready');
    expect(res.body.dependencies.postgres).toBe('degraded');
    expect(res.body.dependencies.stellar_rpc).toBe('healthy');
  });

  it('redis degraded → overall degraded, still 200', async () => {
    const app = buildApp([
      healthyChecker('postgres'),
      degradedChecker('redis'),
      healthyChecker('stellar_rpc'),
    ]);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.dependencies.redis).toBe('degraded');
  });

  it('stellar_rpc degraded → overall degraded, still 200', async () => {
    const app = buildApp([healthyChecker('postgres'), degradedChecker('stellar_rpc')]);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
  });

  it('unhealthy takes precedence over degraded', async () => {
    const app = buildApp([degradedChecker('postgres'), unhealthyChecker('stellar_rpc')]);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
  });
});

// ── Postgres unhealthy ────────────────────────────────────────────────────────

describe('GET /health/ready — postgres unhealthy', () => {
  it('returns 503', async () => {
    const app = buildApp([unhealthyChecker('postgres'), healthyChecker('stellar_rpc')]);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
  });

  it('response status is "unhealthy"', async () => {
    const app = buildApp([unhealthyChecker('postgres'), healthyChecker('stellar_rpc')]);
    const res = await request(app).get('/health/ready');
    expect(res.body.status).toBe('unhealthy');
  });

  it('dependencies map shows postgres as unhealthy', async () => {
    const app = buildApp([unhealthyChecker('postgres'), healthyChecker('stellar_rpc')]);
    const res = await request(app).get('/health/ready');
    expect(res.body.dependencies.postgres).toBe('unhealthy');
    expect(res.body.dependencies.stellar_rpc).toBe('healthy');
  });
});

// ── Stellar RPC unhealthy ─────────────────────────────────────────────────────

describe('GET /health/ready — stellar_rpc unhealthy', () => {
  it('returns 503', async () => {
    const app = buildApp([healthyChecker('postgres'), unhealthyChecker('stellar_rpc', 'RPC unreachable')]);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
  });

  it('dependencies map shows stellar_rpc as unhealthy', async () => {
    const app = buildApp([healthyChecker('postgres'), unhealthyChecker('stellar_rpc', 'RPC unreachable')]);
    const res = await request(app).get('/health/ready');
    expect(res.body.dependencies.stellar_rpc).toBe('unhealthy');
  });
});

// ── Redis unhealthy ───────────────────────────────────────────────────────────

describe('GET /health/ready — redis unhealthy', () => {
  it('returns 503 when redis is unhealthy', async () => {
    const app = buildApp([
      healthyChecker('postgres'),
      unhealthyChecker('redis', 'ECONNREFUSED'),
      healthyChecker('stellar_rpc'),
    ]);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
  });

  it('response status is "unhealthy" when redis fails', async () => {
    const app = buildApp([
      healthyChecker('postgres'),
      unhealthyChecker('redis', 'ECONNREFUSED'),
      healthyChecker('stellar_rpc'),
    ]);
    const res = await request(app).get('/health/ready');
    expect(res.body.status).toBe('unhealthy');
  });

  it('dependencies map shows redis as unhealthy', async () => {
    const app = buildApp([
      healthyChecker('postgres'),
      unhealthyChecker('redis', 'ECONNREFUSED'),
      healthyChecker('stellar_rpc'),
    ]);
    const res = await request(app).get('/health/ready');
    expect(res.body.dependencies.redis).toBe('unhealthy');
    expect(res.body.dependencies.postgres).toBe('healthy');
    expect(res.body.dependencies.stellar_rpc).toBe('healthy');
  });
});

// ── Checker throws ────────────────────────────────────────────────────────────

describe('GET /health/ready — checker throws unexpectedly', () => {
  it('returns 503', async () => {
    const app = buildApp([throwingChecker('postgres')]);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
  });

  it('response status is "unhealthy"', async () => {
    const app = buildApp([throwingChecker('postgres')]);
    const res = await request(app).get('/health/ready');
    expect(res.body.status).toBe('unhealthy');
  });

  it('redis throwing → 503 unhealthy', async () => {
    const app = buildApp([healthyChecker('postgres'), throwingChecker('redis')]);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
  });
});

// ── No health manager ─────────────────────────────────────────────────────────

describe('GET /health/ready — no health manager configured', () => {
  it('returns 503', async () => {
    const app = express();
    app.use('/health', healthRouter);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
  });

  it('response status is "unhealthy"', async () => {
    const app = express();
    app.use('/health', healthRouter);
    const res = await request(app).get('/health/ready');
    expect(res.body.status).toBe('unhealthy');
  });
});

// ── Security: no sensitive data leakage ──────────────────────────────────────

describe('GET /health/ready — response does not leak sensitive data', () => {
  it('does not include postgresql connection strings', async () => {
    const app = buildApp([unhealthyChecker('postgres', 'postgresql://user:secret@host/db')]);
    const res = await request(app).get('/health/ready');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('does not include redis connection strings', async () => {
    const app = buildApp([unhealthyChecker('redis', 'redis://admin:topsecret@redis-host:6379')]);
    const res = await request(app).get('/health/ready');
    expect(JSON.stringify(res.body)).not.toContain('topsecret');
  });

  it('flat dependencies map exposes only status strings, not raw errors', async () => {
    const app = buildApp([unhealthyChecker('postgres', 'internal error details')]);
    const res = await request(app).get('/health/ready');
    // The flat map should only contain status strings
    for (const value of Object.values(res.body.dependencies ?? {})) {
      expect(['healthy', 'degraded', 'unhealthy']).toContain(value);
    }
  });
});

// ── GET /health liveness ──────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok when indexer not configured', async () => {
    const app = buildApp([]);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
