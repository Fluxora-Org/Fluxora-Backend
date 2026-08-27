/**
 * tests/routes/admin.auth.test.ts
 *
 * Dedicated hardening suite for the `requireAdminAuth` guard as applied
 * to the main adminRouter.
 *
 * Covered edge-cases
 * ------------------
 *
 * ADMIN_API_KEY environment variable
 *   • Unset → every protected route returns 503 (fail-closed)
 *
 * Authorization header format
 *   • Missing header            → 401
 *   • Wrong scheme (Basic)      → 401
 *   • Two-part Bearer but empty token ("Bearer ") → 401
 *   • Non-Bearer two-word prefix → 401
 *   • Oversized header (>8192 B) → 401  (DoS guard)
 *
 * Static key comparison
 *   • Correct static key        → passes (200/202/etc.)
 *   • Wrong static key          → 403
 *   • Key that is one char shorter than correct → 403  (length side-channel)
 *   • Key that is one char longer  → 403
 *
 * JWT fallback path (when static key doesn't match)
 *   • JWT with role=admin                    → passes
 *   • JWT with role=data-protection-officer  → passes
 *   • JWT with role=operator                 → 403
 *   • JWT with role=viewer                   → 403
 *   • Expired JWT                            → 403
 *   • Structurally invalid JWT (random string) → 403
 *   • JWT signed with wrong secret            → 403
 *
 * Public (unauthenticated) endpoint
 *   • GET /api/admin/status/read-only is accessible without any credentials
 *   • GET /api/admin/status/read-only still works when ADMIN_API_KEY is unset
 *
 * Persistence / service errors on protected routes
 *   • PUT /api/admin/pause throws AdminStatePersistenceError → 503
 *   • POST /api/admin/reindex when already running           → 409
 *
 * Audit trail
 *   • Successful auth records an in-memory audit event (PAUSE_FLAGS_UPDATED)
 *
 * Response shape
 *   • Auth failures must use the { error: string } shape (not success envelope)
 *   • Protected success responses use { success: true, data, meta } envelope
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../src/app.js';
import { _resetForTest } from '../../src/state/adminState.js';
import { _resetAuditLog } from '../../src/lib/auditLog.js';
import { initializeConfig } from '../../src/config/env.js';
import { generateToken } from '../../src/lib/auth.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_KEY = 'test-admin-key-for-auth-suite';

// ── Helpers ───────────────────────────────────────────────────────────────────

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

function withToken(req: request.Test, token: string): request.Test {
  return req.set('Authorization', `Bearer ${token}`);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let prevAdminKey: string | undefined;
let prevJwtSecret: string | undefined;

beforeEach(() => {
  prevAdminKey = process.env.ADMIN_API_KEY;
  prevJwtSecret = process.env.JWT_SECRET;

  process.env.ADMIN_API_KEY = ADMIN_KEY;
  // Use a stable secret for deterministic JWT generation in tests.
  process.env.JWT_SECRET = 'test-jwt-secret-for-admin-auth-suite';

  _resetForTest();
  _resetAuditLog();
  initializeConfig();
});

afterEach(() => {
  if (prevAdminKey === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = prevAdminKey;

  if (prevJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = prevJwtSecret;

  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. ADMIN_API_KEY unset
// ─────────────────────────────────────────────────────────────────────────────

describe('ADMIN_API_KEY unset → fail-closed', () => {
  beforeEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it('GET /api/admin/status returns 503', async () => {
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('PUT /api/admin/pause returns 503', async () => {
    const res = await request(app)
      .put('/api/admin/pause')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ streamCreation: true });
    expect(res.status).toBe(503);
  });

  it('POST /api/admin/reindex returns 503', async () => {
    const res = await request(app)
      .post('/api/admin/reindex')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(503);
  });

  it('GET /api/admin/status/read-only still returns 200 (public endpoint bypasses auth)', async () => {
    const res = await request(app).get('/api/admin/status/read-only');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Authorization header format errors
// ─────────────────────────────────────────────────────────────────────────────

describe('Authorization header format errors → 401', () => {
  it('missing Authorization header', async () => {
    const res = await request(app).get('/api/admin/status');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('wrong scheme: Basic', async () => {
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', `Basic ${ADMIN_KEY}`);
    expect(res.status).toBe(401);
  });

  it('non-Bearer two-word prefix (Token scheme)', async () => {
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', `Token ${ADMIN_KEY}`);
    expect(res.status).toBe(401);
  });

  it('empty bearer token: "Bearer " with no token value', async () => {
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
  });

  it('oversized Authorization header (>8192 bytes) → 401 DoS guard', async () => {
    // 8193-byte header — one byte over the MAX_AUTHORIZATION_HEADER_LENGTH limit
    const oversized = `Bearer ${'x'.repeat(8186)}`;
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', oversized);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/too large/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Static key comparison
// ─────────────────────────────────────────────────────────────────────────────

describe('Static key comparison', () => {
  it('correct static key → 200', async () => {
    const res = await authed(request(app).get('/api/admin/status'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('wrong static key → 403', async () => {
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('key that is one character shorter than correct → 403 (no timing leak)', async () => {
    const shorterKey = ADMIN_KEY.slice(0, -1);
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', `Bearer ${shorterKey}`);
    expect(res.status).toBe(403);
  });

  it('key that is one character longer than correct → 403 (no timing leak)', async () => {
    const longerKey = ADMIN_KEY + 'X';
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', `Bearer ${longerKey}`);
    expect(res.status).toBe(403);
  });

  it('empty string key → 401 (missing token)', async () => {
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', 'Bearer');
    // Single-word header without space — header has no token part
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. JWT fallback path
// ─────────────────────────────────────────────────────────────────────────────

describe('JWT fallback: role-based access control', () => {
  it('JWT with role=admin → 200', async () => {
    const token = generateToken({ address: 'addr-admin', role: 'admin' });
    const res = await withToken(request(app).get('/api/admin/status'), token);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('JWT with role=data-protection-officer → 200', async () => {
    const token = generateToken({
      address: 'addr-dpo',
      role: 'data-protection-officer',
    });
    const res = await withToken(request(app).get('/api/admin/status'), token);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('JWT with role=operator → 403', async () => {
    const token = generateToken({ address: 'addr-operator', role: 'operator' });
    const res = await withToken(request(app).get('/api/admin/status'), token);
    expect(res.status).toBe(403);
  });

  it('JWT with role=viewer → 403', async () => {
    const token = generateToken({ address: 'addr-viewer', role: 'viewer' });
    const res = await withToken(request(app).get('/api/admin/status'), token);
    expect(res.status).toBe(403);
  });

  it('expired JWT → 403', async () => {
    // Sign a token that expired 1 second ago
    const secret = process.env.JWT_SECRET!;
    const expired = jwt.sign(
      { address: 'addr-expired', role: 'admin' },
      secret,
      { expiresIn: -1 },
    );
    const res = await withToken(request(app).get('/api/admin/status'), expired);
    expect(res.status).toBe(403);
  });

  it('structurally invalid JWT (random string) → 403', async () => {
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', 'Bearer not.a.valid.jwt.at.all');
    expect(res.status).toBe(403);
  });

  it('JWT signed with wrong secret → 403', async () => {
    const badToken = jwt.sign({ address: 'addr-admin', role: 'admin' }, 'wrong-secret');
    const res = await withToken(request(app).get('/api/admin/status'), badToken);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Public endpoint (no auth required)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/status/read-only — public, no auth required', () => {
  it('returns 200 with no Authorization header', async () => {
    const res = await request(app).get('/api/admin/status/read-only');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns pause flags in data envelope', async () => {
    const res = await request(app).get('/api/admin/status/read-only');
    expect(res.body.data.pauseFlags).toEqual({ streamCreation: false, ingestion: false });
  });

  it('response includes meta.timestamp', async () => {
    const res = await request(app).get('/api/admin/status/read-only');
    expect(res.body.meta).toHaveProperty('timestamp');
    expect(typeof res.body.meta.timestamp).toBe('string');
  });

  it('accessible even with an invalid Bearer token (auth guard is skipped)', async () => {
    const res = await request(app)
      .get('/api/admin/status/read-only')
      .set('Authorization', 'Bearer completely-wrong');
    // Auth guard is NOT applied to this endpoint, so an invalid token is ignored
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Persistence / service error paths
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /api/admin/pause — persistence error → 503', () => {
  it('returns 503 when setPauseFlags throws AdminStatePersistenceError', async () => {
    const adminStateModule = await import('../../src/state/adminState.js');
    const { AdminStatePersistenceError } = adminStateModule;
    const spy = vi.spyOn(adminStateModule, 'setPauseFlags').mockRejectedValue(
      new AdminStatePersistenceError('disk full'),
    );

    const res = await authed(
      request(app).put('/api/admin/pause').send({ streamCreation: true }),
    );

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('PERSISTENCE_ERROR');
    expect(res.body.error.message).toMatch(/persist/i);

    spy.mockRestore();
  });
});

describe('POST /api/admin/reindex — conflict when already running', () => {
  it('returns 409 when a reindex is already in progress', async () => {
    // Trigger first reindex
    await authed(request(app).post('/api/admin/reindex'));
    // Attempt a second one immediately
    const res = await authed(request(app).post('/api/admin/reindex'));
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toMatch(/already in progress/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Audit trail
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit trail — successful admin mutations', () => {
  // These tests spy on `recordAuditEvent` rather than reading back from
  // `getAuditEntries()` so they work correctly even when another test file
  // in the same Vitest worker has replaced the auditLog module with a
  // module-scope vi.mock (e.g. admin.apiKeys.test.ts).

  it('PUT /api/admin/pause calls recordAuditEvent with PAUSE_FLAGS_UPDATED', async () => {
    const auditModule = await import('../../src/lib/auditLog.js');
    const spy = vi.spyOn(auditModule, 'recordAuditEvent');

    await authed(
      request(app).put('/api/admin/pause').send({ streamCreation: true }),
    );

    expect(spy).toHaveBeenCalledWith(
      'PAUSE_FLAGS_UPDATED',
      'pauseFlags',
      'system',
      expect.anything(),  // correlationId
      expect.objectContaining({ updated: expect.any(Object) }),
    );
  });

  it('POST /api/admin/reindex calls recordAuditEvent with REINDEX_TRIGGERED', async () => {
    const auditModule = await import('../../src/lib/auditLog.js');
    const spy = vi.spyOn(auditModule, 'recordAuditEvent');

    await authed(request(app).post('/api/admin/reindex'));

    expect(spy).toHaveBeenCalledWith(
      'REINDEX_TRIGGERED',
      'reindex',
      'system',
      expect.anything(),  // correlationId
      expect.any(Object),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Response shape contract
// ─────────────────────────────────────────────────────────────────────────────

describe('Response shape contract', () => {
  it('401 responses use { error: string } shape — not the success envelope', async () => {
    const res = await request(app).get('/api/admin/status');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect(res.body).not.toHaveProperty('success');
    expect(res.body).not.toHaveProperty('data');
  });

  it('403 responses use { error: string } shape', async () => {
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', 'Bearer bad-key');
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error');
    expect(res.body).not.toHaveProperty('success');
  });

  it('503 (unconfigured) responses use { error: string } shape', async () => {
    delete process.env.ADMIN_API_KEY;
    const res = await request(app)
      .get('/api/admin/status')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty('error');
    expect(res.body).not.toHaveProperty('success');
  });

  it('successful protected responses use the success envelope shape', async () => {
    const res = await authed(request(app).get('/api/admin/status'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: expect.any(Object),
      meta: expect.objectContaining({ timestamp: expect.any(String) }),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Guard applied consistently across all protected routes
// ─────────────────────────────────────────────────────────────────────────────

describe('Guard applied consistently — every protected route rejects without credentials', () => {
  const protectedRoutes: Array<[string, string]> = [
    ['GET',    '/api/admin/status'],
    ['GET',    '/api/admin/pause'],
    ['PUT',    '/api/admin/pause'],
    ['GET',    '/api/admin/reindex'],
    ['POST',   '/api/admin/reindex'],
    ['POST',   '/api/admin/indexer/stall/clear'],
    ['GET',    '/api/admin/deprecations'],
    ['GET',    '/api/admin/ban-store/status'],
    ['POST',   '/api/admin/ws/disconnect'],
    ['GET',    '/api/admin/api-keys'],
    ['POST',   '/api/admin/api-keys'],
    ['GET',    '/api/admin/restore'],
    ['POST',   '/api/admin/streams/bulk-actions'],
  ];

  for (const [method, path] of protectedRoutes) {
    it(`${method} ${path} → 401 when Authorization header is absent`, async () => {
      const req = (request(app) as any)[method.toLowerCase()](path);
      const res = await (method === 'PUT' || method === 'POST'
        ? req.send({})
        : req);
      expect(res.status).toBe(401);
    });

    it(`${method} ${path} → 403 when wrong Bearer token is supplied`, async () => {
      const req = (request(app) as any)[method.toLowerCase()](path);
      const withAuth = req.set('Authorization', 'Bearer totally-wrong-key');
      const res = await (method === 'PUT' || method === 'POST'
        ? withAuth.send({})
        : withAuth);
      expect(res.status).toBe(403);
    });
  }
});
