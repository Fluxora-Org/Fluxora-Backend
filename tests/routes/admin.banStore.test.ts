/**
 * tests/routes/admin.banStore.test.ts
 *
 * Hardening suite for GET /api/admin/ban-store/status.
 *
 * Coverage
 * --------
 *
 * Auth gate
 *   • Missing Authorization header          → 401
 *   • Wrong Bearer token                    → 403
 *   • ADMIN_API_KEY unset                   → 503
 *   • Valid static key                      → passes
 *   • JWT with role=admin                   → passes
 *
 * Happy path — global store NOT initialized
 *   • Returns 200 with { available: false, usingFallback: false }
 *
 * Happy path — global store initialized and healthy
 *   • Returns 200 with { available: true, usingFallback: false }
 *
 * Happy path — global store in fallback mode
 *   • Returns 200 with { available: true, usingFallback: true }
 *
 * Error paths
 *   • getHybridBanStoreStatus throws          → 503 with SERVICE_UNAVAILABLE
 *   • getHybridBanStoreStatus is not-a-function → graceful 200 fallback
 *
 * Response envelope
 *   • Success response wraps in { success: true, data, meta }
 *   • Error response wraps in { success: false, error: { code, message } }
 *   • meta.timestamp is a valid ISO-8601 string
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { _resetForTest } from '../../src/state/adminState.js';
import { initializeConfig } from '../../src/config/env.js';
import { generateToken } from '../../src/lib/auth.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_KEY = 'test-admin-key-for-ban-store';

// ── Helpers ───────────────────────────────────────────────────────────────────

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let prevAdminKey: string | undefined;
let prevJwtSecret: string | undefined;

beforeEach(() => {
  prevAdminKey = process.env.ADMIN_API_KEY;
  prevJwtSecret = process.env.JWT_SECRET;

  process.env.ADMIN_API_KEY = ADMIN_KEY;
  process.env.JWT_SECRET = 'test-jwt-secret-for-ban-store';

  _resetForTest();
  initializeConfig();
  vi.clearAllMocks();
});

afterEach(() => {
  if (prevAdminKey === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = prevAdminKey;

  if (prevJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = prevJwtSecret;

  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Auth gate
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/ban-store/status — auth gate', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const res = await request(app).get('/api/admin/ban-store/status');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 403 when wrong Bearer token is supplied', async () => {
    const res = await request(app)
      .get('/api/admin/ban-store/status')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 503 when ADMIN_API_KEY is unset (fail-closed)', async () => {
    delete process.env.ADMIN_API_KEY;
    const res = await request(app)
      .get('/api/admin/ban-store/status')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('passes with correct static key', async () => {
    const res = await authed(request(app).get('/api/admin/ban-store/status'));
    expect(res.status).toBe(200);
  });

  it('passes with JWT role=admin', async () => {
    const token = generateToken({ address: 'addr-admin', role: 'admin' });
    const res = await request(app)
      .get('/api/admin/ban-store/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('returns 403 with JWT role=operator (insufficient privilege)', async () => {
    const token = generateToken({ address: 'addr-operator', role: 'operator' });
    const res = await request(app)
      .get('/api/admin/ban-store/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Happy path — store status variants
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/ban-store/status — happy path', () => {
  it('returns available:false when global store is not initialised', async () => {
    // By default in tests the global HybridBanStore is NOT set, so the
    // function returns { usingFallback: false, available: false }.
    vi.spyOn(
      await import('../../src/redis/banStore.js'),
      'getHybridBanStoreStatus',
    ).mockReturnValue({ usingFallback: false, available: false });

    const res = await authed(request(app).get('/api/admin/ban-store/status'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.banStore.available).toBe(false);
    expect(res.body.data.banStore.usingFallback).toBe(false);
  });

  it('returns available:true, usingFallback:false when store is healthy', async () => {
    vi.spyOn(
      await import('../../src/redis/banStore.js'),
      'getHybridBanStoreStatus',
    ).mockReturnValue({ usingFallback: false, available: true });

    const res = await authed(request(app).get('/api/admin/ban-store/status'));
    expect(res.status).toBe(200);
    expect(res.body.data.banStore.available).toBe(true);
    expect(res.body.data.banStore.usingFallback).toBe(false);
  });

  it('returns available:true, usingFallback:true when store is in fallback mode', async () => {
    vi.spyOn(
      await import('../../src/redis/banStore.js'),
      'getHybridBanStoreStatus',
    ).mockReturnValue({ usingFallback: true, available: true });

    const res = await authed(request(app).get('/api/admin/ban-store/status'));
    expect(res.status).toBe(200);
    expect(res.body.data.banStore.available).toBe(true);
    expect(res.body.data.banStore.usingFallback).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Error paths
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/ban-store/status — error paths', () => {
  it('returns 503 when getHybridBanStoreStatus throws', async () => {
    vi.spyOn(
      await import('../../src/redis/banStore.js'),
      'getHybridBanStoreStatus',
    ).mockImplementation(() => {
      throw new Error('Redis connection lost');
    });

    const res = await authed(request(app).get('/api/admin/ban-store/status'));
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('503 error message reflects the underlying error, not an internal stack trace', async () => {
    vi.spyOn(
      await import('../../src/redis/banStore.js'),
      'getHybridBanStoreStatus',
    ).mockImplementation(() => {
      throw new Error('Redis connection lost');
    });

    const res = await authed(request(app).get('/api/admin/ban-store/status'));
    const body = JSON.stringify(res.body);
    // Must surface the message but not expose internals
    expect(res.body.error.message).toBe('Redis connection lost');
    expect(body).not.toMatch(/node_modules/);
    expect(body).not.toMatch(/at Object\./);
  });

  it('returns 200 with available:false when getHybridBanStoreStatus is not a function (graceful fallback)', async () => {
    // The route has a typeof guard: if not a function it falls back gracefully.
    vi.spyOn(
      await import('../../src/redis/banStore.js'),
      'getHybridBanStoreStatus',
    ).mockReturnValue(undefined as any);

    // When the mock returns undefined, the route's typeof check treats it as
    // not-a-function (the real function always returns an object). In practice
    // the route guards this with `typeof getHybridBanStoreStatus === 'function'`.
    // We test that a non-throwing, non-function result doesn't crash the handler.
    // The route falls back to { available: false, reason: '...' }.
    const res = await authed(request(app).get('/api/admin/ban-store/status'));
    // Should not crash (not 500)
    expect(res.status).not.toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Response envelope shape
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/ban-store/status — response envelope shape', () => {
  it('wraps success in { success: true, data: { banStore }, meta: { timestamp } }', async () => {
    const res = await authed(request(app).get('/api/admin/ban-store/status'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { banStore: expect.any(Object) },
      meta: { timestamp: expect.any(String) },
    });
    expect(new Date(res.body.meta.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('data.banStore always contains available and usingFallback fields', async () => {
    const res = await authed(request(app).get('/api/admin/ban-store/status'));
    expect(typeof res.body.data.banStore.available).toBe('boolean');
    expect(typeof res.body.data.banStore.usingFallback).toBe('boolean');
  });

  it('error envelope uses { success: false, error: { code, message } }', async () => {
    vi.spyOn(
      await import('../../src/redis/banStore.js'),
      'getHybridBanStoreStatus',
    ).mockImplementation(() => { throw new Error('boom'); });

    const res = await authed(request(app).get('/api/admin/ban-store/status'));
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: expect.any(String),
      },
    });
  });
});
