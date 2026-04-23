/**
 * Integration tests for the health endpoints via the full app stack.
 *
 * Covers:
 *  - GET /health liveness probe
 *  - GET /health/ready readiness probe (degraded classification)
 *  - GET /health/live detailed report (admin-gated)
 *  - GET /health/deployment staging parity checks
 *  - Correlation ID propagation
 */

import request from 'supertest';
import { describe, it, expect } from 'vitest';

import { createApp, app } from '../src/app.js';
import type { Config } from '../src/config/env.js';
import { HealthCheckManager, type HealthChecker } from '../src/config/health.js';
import { CORRELATION_ID_HEADER } from '../src/middleware/correlationId.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    nodeEnv: 'development',
    apiVersion: '0.1.0',
    databaseUrl: 'postgresql://localhost/fluxora',
    databasePoolMin: 2,
    databasePoolMax: 10,
    databaseConnectionTimeout: 5000,
    databaseIdleTimeout: 30000,
    redisUrl: 'redis://localhost:6379',
    redisEnabled: false,
    stellarNetwork: 'testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    horizonNetworkPassphrase: 'Test SDF Network ; September 2015',
    contractAddresses: { streaming: 'PLACEHOLDER' },
    jwtSecret: 'dev-secret-key-change-in-production',
    jwtExpiresIn: '24h',
    apiKeys: [],
    maxRequestSizeBytes: 1024 * 1024,
    maxJsonDepth: 20,
    requestTimeoutMs: 30000,
    logLevel: 'info',
    metricsEnabled: true,
    tracingEnabled: false,
    tracingSampleRate: 1.0,
    tracingOtelEnabled: false,
    tracingLogEvents: false,
    enableStreamValidation: true,
    enableRateLimit: false,
    requirePartnerAuth: false,
    requireAdminAuth: false,
    indexerEnabled: false,
    workerEnabled: false,
    indexerStallThresholdMs: 5 * 60 * 1000,
    deploymentChecklistVersion: '2026-03-27',
    ...overrides,
  };
}

function makeHealthManager(checkers: HealthChecker[]) {
  const manager = new HealthCheckManager();
  for (const checker of checkers) {
    manager.registerChecker(checker);
  }
  return manager;
}

// ── GET /health liveness ──────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('response body includes service and timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.body.service).toBe('fluxora-backend');
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.body.dependencies?.indexer).toBeDefined();
  });

  it('response includes x-correlation-id header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
  });

  it('propagates client-supplied correlation ID', async () => {
    const id = 'health-check-id';
    const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, id);
    expect(res.headers[CORRELATION_ID_HEADER]).toBe(id);
  });
});

// ── GET /health/ready readiness ───────────────────────────────────────────────

describe('GET /health/ready', () => {
  it('returns 503 when a dependency is unhealthy', async () => {
    const appWithUnhealthyDependency = createApp({
      config: makeConfig(),
      healthManager: makeHealthManager([
        {
          name: 'database',
          async check() {
            return { latency: 25, error: 'connection refused' };
          },
        },
      ]),
    });

    const res = await request(appWithUnhealthyDependency).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
    expect(res.body.dependencies.database).toBe('unhealthy');
  });

  it('returns 200 when all dependencies are healthy', async () => {
    const healthyApp = createApp({
      config: makeConfig(),
      healthManager: makeHealthManager([
        { name: 'database', async check() { return { latency: 5 }; } },
        { name: 'redis', async check() { return { latency: 3 }; } },
        { name: 'stellar_rpc', async check() { return { latency: 10 }; } },
      ]),
    });

    const res = await request(healthyApp).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.dependencies).toEqual({
      database: 'healthy',
      redis: 'healthy',
      stellar_rpc: 'healthy',
    });
  });

  it('returns 200 with status "degraded" when a dependency is slow', async () => {
    const degradedApp = createApp({
      config: makeConfig(),
      healthManager: makeHealthManager([
        { name: 'database', async check() { return { latency: 5 }; } },
        { name: 'redis', async check() { return { latency: 1, degraded: true }; } },
      ]),
    });

    const res = await request(degradedApp).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.dependencies.redis).toBe('degraded');
    expect(res.body.dependencies.database).toBe('healthy');
  });

  it('unhealthy takes precedence over degraded', async () => {
    const mixedApp = createApp({
      config: makeConfig(),
      healthManager: makeHealthManager([
        { name: 'database', async check() { return { latency: 1, degraded: true }; } },
        { name: 'redis', async check() { return { latency: 1, error: 'ECONNREFUSED' }; } },
      ]),
    });

    const res = await request(mixedApp).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
  });
});

// ── GET /health/live ──────────────────────────────────────────────────────────

describe('GET /health/live', () => {
  it('rejects unauthenticated access when admin auth is required', async () => {
    const protectedApp = createApp({
      config: makeConfig({
        nodeEnv: 'staging',
        requireAdminAuth: true,
        adminApiToken: 'admin-secret',
      }),
      healthManager: makeHealthManager([]),
    });

    const res = await request(protectedApp).get('/health/live');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});

// ── GET /health/deployment ────────────────────────────────────────────────────

describe('GET /health/deployment', () => {
  it('returns a failing deployment report when staging parity gaps exist', async () => {
    const stagingApp = createApp({
      config: makeConfig({
        nodeEnv: 'staging',
        requireAdminAuth: true,
        adminApiToken: 'admin-secret',
        requirePartnerAuth: true,
        redisEnabled: false,
        workerEnabled: false,
        indexerEnabled: false,
      }),
      healthManager: makeHealthManager([]),
    });

    const res = await request(stagingApp)
      .get('/health/deployment')
      .set('authorization', 'Bearer admin-secret');

    expect(res.status).toBe(503);
    expect(res.body.report.status).toBe('fail');
    expect(res.body.report.failureModes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'partial_data' }),
      ]),
    );
  });

  it('returns a passing deployment report when staging matches prod-critical controls', async () => {
    const healthyStagingApp = createApp({
      config: makeConfig({
        nodeEnv: 'staging',
        requireAdminAuth: true,
        adminApiToken: 'admin-secret',
        requirePartnerAuth: true,
        partnerApiToken: 'partner-secret',
        redisEnabled: true,
        workerEnabled: true,
        indexerEnabled: true,
        indexerLastSuccessfulSyncAt: new Date().toISOString(),
      }),
      healthManager: makeHealthManager([]),
    });

    const res = await request(healthyStagingApp)
      .get('/health/deployment')
      .set('authorization', 'Bearer admin-secret');

    expect(res.status).toBe(200);
    expect(res.body.report.status).toBe('pass');
    expect(res.body.report.trustBoundaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: 'authenticated_partner' }),
        expect.objectContaining({ actor: 'administrator' }),
      ]),
    );
  });
});
