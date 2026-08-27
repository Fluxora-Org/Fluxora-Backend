/**
 * Tests for GET /api/admin/diagnostics — #1214
 *
 * Coverage:
 *  - Auth guards: 401 (no token), 403 (bad credentials)
 *  - Successful diagnostics response with full report shape
 *  - Sub-check error states (timeout, error)
 *  - Service-unavailable fallback when diagnostics throws
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// ── Mock the diagnostics service before importing app ──────────────────────────
const mockReport = vi.hoisted(() => ({
  timestamp: '2026-07-29T12:00:00.000Z',
  dbPool:     { status: 'ok', latencyMs: 2, value: { active: 3, idle: 5, waiting: 0 } },
  redis:      { status: 'ok', latencyMs: 1, value: { pingMs: 0.5 } },
  circuitBreaker: {
    status: 'ok',
    latencyMs: 0,
    value: { state: 'CLOSED', transitionedAt: null, failureCount: 0, degraded: false },
  },
  indexer: {
    status: 'ok',
    latencyMs: 0,
    value: { lagSeconds: 0, isReplaying: false, rowsReplayed: 0, totalRows: 0 },
  },
}));

const mockRunDiagnostics = vi.fn().mockResolvedValue(mockReport);

vi.mock('../../src/services/diagnostics.js', () => ({
  getDiagnosticsService: () => ({ runDiagnostics: mockRunDiagnostics }),
  setDiagnosticsService: vi.fn(),
}));

// ── Mock downstream dependencies that the app tries to initialise ──────────────
vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(),
  query: vi.fn(),
  QueryTimeoutError: class QueryTimeoutError extends Error {},
  getPoolMetrics: vi.fn(() => ({ total: 8, idle: 5, waiting: 0 })),
}));

vi.mock('../../src/webhooks/retry.js', () => ({
  attemptWebhookDeliveryWithRateLimit: vi.fn(),
  scheduleWebhookOutboxRetry: vi.fn(),
  calculateNextRetryTime: vi.fn(),
  generateRetrySchedule: vi.fn(),
}));

vi.mock('../../src/openapi/spec.js', () => ({ openApiDocument: {} }));

import { app } from '../../src/app.js';
import { initializeConfig } from '../../src/config/env.js';

const ADMIN_KEY = 'test-admin-key-for-diagnostics';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

describe('GET /api/admin/diagnostics', () => {
  let originalKey: string | undefined;

  beforeAll(() => {
    initializeConfig();
  });

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    mockRunDiagnostics.mockResolvedValue(mockReport);
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  // ── Auth guards ──────────────────────────────────────────────────────────

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/admin/diagnostics');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing Authorization header.' });
  });

  it('rejects requests with bad credentials with 403', async () => {
    const res = await request(app)
      .get('/api/admin/diagnostics')
      .set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(403);
  });

  it('fails closed with 503 when admin auth is unconfigured', async () => {
    delete process.env.ADMIN_API_KEY;

    const res = await request(app).get('/api/admin/diagnostics');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'Admin API is not configured. Set ADMIN_API_KEY to enable admin access.',
    });
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it('returns a successful diagnostics report in the standard envelope', async () => {
    const res = await authed(request(app).get('/api/admin/diagnostics'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toHaveProperty('timestamp');

    const data = res.body.data;
    expect(data).toHaveProperty('timestamp');
    expect(data).toHaveProperty('dbPool');
    expect(data).toHaveProperty('redis');
    expect(data).toHaveProperty('circuitBreaker');
    expect(data).toHaveProperty('indexer');
  });

  it('dbPool sub-check has active, idle, and waiting counts', async () => {
    const res = await authed(request(app).get('/api/admin/diagnostics'));
    const dbPool = res.body.data.dbPool;

    expect(dbPool).toMatchObject({
      status: 'ok',
      value: expect.objectContaining({
        active: expect.any(Number),
        idle: expect.any(Number),
        waiting: expect.any(Number),
      }),
    });
    expect(typeof dbPool.latencyMs).toBe('number');
  });

  it('redis sub-check has pingMs value', async () => {
    const res = await authed(request(app).get('/api/admin/diagnostics'));
    const redis = res.body.data.redis;

    expect(redis).toMatchObject({
      status: 'ok',
      value: expect.objectContaining({
        pingMs: expect.any(Number),
      }),
    });
  });

  it('circuitBreaker sub-check has state, transitionedAt, failureCount, and degraded', async () => {
    const res = await authed(request(app).get('/api/admin/diagnostics'));
    const cb = res.body.data.circuitBreaker;

    expect(cb).toMatchObject({
      status: 'ok',
      value: expect.objectContaining({
        state: expect.stringMatching(/^(CLOSED|OPEN|HALF_OPEN)$/),
        failureCount: expect.any(Number),
        degraded: expect.any(Boolean),
      }),
    });
    // transitionedAt can be null (never tripped) or number (epoch ms when tripped)
    expect(
      cb.value.transitionedAt === null || typeof cb.value.transitionedAt === 'number',
    ).toBe(true);
  });

  it('indexer sub-check has lagSeconds and replay status', async () => {
    const res = await authed(request(app).get('/api/admin/diagnostics'));
    const indexer = res.body.data.indexer;

    expect(indexer).toMatchObject({
      status: 'ok',
      value: expect.objectContaining({
        lagSeconds: expect.any(Number),
        isReplaying: expect.any(Boolean),
      }),
    });
  });

  it('returns diagnostics even when some sub-checks have non-lethal errors', async () => {
    const errorReport = {
      timestamp: '2026-07-29T12:00:00.000Z',
      dbPool:     { status: 'ok', latencyMs: 2, value: { active: 3, idle: 5, waiting: 0 } },
      redis:      { status: 'error', latencyMs: 1000, error: 'Connection refused' },
      circuitBreaker: {
        status: 'ok',
        latencyMs: 0,
        value: { state: 'OPEN', transitionedAt: 1700000000000, failureCount: 7, degraded: true },
      },
      indexer: {
        status: 'timeout',
        latencyMs: 5000,
        error: 'indexer_lag timed out after 5000ms',
      },
    };
    mockRunDiagnostics.mockResolvedValue(errorReport);

    const res = await authed(request(app).get('/api/admin/diagnostics'));

    expect(res.status).toBe(200);
    expect(res.body.data.dbPool.status).toBe('ok');
    expect(res.body.data.redis.status).toBe('error');
    expect(res.body.data.circuitBreaker.status).toBe('ok');
    expect(res.body.data.indexer.status).toBe('timeout');
  });

  // ── Error handling ───────────────────────────────────────────────────────

  it('returns 503 when the diagnostics service throws', async () => {
    mockRunDiagnostics.mockRejectedValue(new Error('Unexpected diagnostics failure'));

    const res = await authed(request(app).get('/api/admin/diagnostics'));

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'DIAGNOSTICS_ERROR',
      },
    });
  });

  it('does not invoke diagnostics when not authenticated', async () => {
    await request(app).get('/api/admin/diagnostics');

    expect(mockRunDiagnostics).not.toHaveBeenCalled();
  });
});
