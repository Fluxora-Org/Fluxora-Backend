import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { healthRouter } from '../src/routes/health';
import { HealthCheckManager } from '../src/config/health';
import type { HealthChecker } from '../src/config/health';

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

const unhealthyChecker = (name: string, error = 'Connection refused'): HealthChecker => ({
  name,
  async check() { return { latency: 1, error }; },
});

const throwingChecker = (name: string): HealthChecker => ({
  name,
  async check() { throw new Error('Unexpected failure'); },
});

describe('GET /health/ready', () => {
  describe('all dependencies healthy', () => {
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
  });

  describe('postgres unhealthy', () => {
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

  describe('stellar_rpc unhealthy', () => {
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

  describe('checker throws unexpectedly', () => {
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
  });

  describe('no health manager configured', () => {
    it('returns 503', async () => {
      const app = express();
      app.use('/health', healthRouter);
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(503);
    });
  });

  describe('response does not leak sensitive data', () => {
    it('does not include connection strings', async () => {
      const app = buildApp([unhealthyChecker('postgres', 'postgresql://user:secret@host/db')]);
      const res = await request(app).get('/health/ready');
      // The raw connection string should not appear in the response body
      expect(JSON.stringify(res.body)).not.toContain('secret');
    });
  });
});

describe('GET /health', () => {
  it('returns 200 with status ok when indexer not configured', async () => {
    const app = buildApp([]);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
