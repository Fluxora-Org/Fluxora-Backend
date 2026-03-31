import request from 'supertest';

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
    databasePoolSize: 10,
    databaseConnectionTimeout: 5000,
    redisUrl: 'redis://localhost:6379',
    redisEnabled: false,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    horizonNetworkPassphrase: 'Test SDF Network ; September 2015',
    jwtSecret: 'dev-secret-key-change-in-production',
    jwtExpiresIn: '24h',
    logLevel: 'info',
    metricsEnabled: true,
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
    expect(res.body.dependencies.indexer).toBeDefined();
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

describe('health readiness and parity', () => {
  it('returns 503 from /health/ready when a dependency is unhealthy', async () => {
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
    expect(res.body.status).toBe('not_ready');
    expect(res.body.dependencyHealth.status).toBe('unhealthy');
  });

  it('rejects unauthenticated access to /health/live when admin auth is required', async () => {
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
