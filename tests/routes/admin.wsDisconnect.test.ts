/**
 * tests/routes/admin.wsDisconnect.test.ts
 *
 * Hardening suite for POST /api/admin/ws/disconnect.
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
 *   • JWT with role=operator                → 403 (insufficient privilege)
 *
 * Input validation
 *   • stream_id field missing entirely      → 400
 *   • stream_id is null                     → 400
 *   • stream_id is a number                 → 400
 *   • stream_id is a boolean                → 400
 *   • stream_id is an empty string ""       → 400
 *   • stream_id is whitespace only ("  ")   → 400
 *   • Validation errors use VALIDATION_ERROR code
 *
 * Hub not initialised
 *   • When getStreamHub returns null        → 503 with SERVICE_UNAVAILABLE
 *
 * Audit persistence failure
 *   • When recordAuditEventToDb rejects     → 503 with PERSISTENCE_ERROR
 *   • disconnectedCount is still present in 503 error details
 *
 * Happy path
 *   • Returns 200 with success envelope containing stream_id, disconnectedCount, message
 *   • disconnectedCount matches the number of sockets closed by hub
 *   • Works when hub has no subscribers for the given stream_id (disconnectedCount: 0)
 *   • Emits ADMIN_WS_DISCONNECT audit entry via recordAuditEventToDb
 *
 * Response envelope
 *   • Success uses { success: true, data, meta }
 *   • Errors use { success: false, error: { code, message } }
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { _resetForTest } from '../../src/state/adminState.js';
import { _resetAuditLog } from '../../src/lib/auditLog.js';
import { initializeConfig } from '../../src/config/env.js';
import { generateToken } from '../../src/lib/auth.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_KEY = 'test-admin-key-for-ws-disconnect';
const STREAM_ID = 'stream-abc-123';

// ── Helpers ───────────────────────────────────────────────────────────────────

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

function postDisconnect(body: Record<string, unknown>): request.Test {
  return authed(request(app).post('/api/admin/ws/disconnect').send(body));
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let prevAdminKey: string | undefined;
let prevJwtSecret: string | undefined;

beforeEach(() => {
  prevAdminKey = process.env.ADMIN_API_KEY;
  prevJwtSecret = process.env.JWT_SECRET;

  process.env.ADMIN_API_KEY = ADMIN_KEY;
  process.env.JWT_SECRET = 'test-jwt-secret-for-ws-disconnect';

  _resetForTest();
  _resetAuditLog();
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

describe('POST /api/admin/ws/disconnect — auth gate', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const res = await request(app)
      .post('/api/admin/ws/disconnect')
      .send({ stream_id: STREAM_ID });
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 403 when wrong Bearer token is supplied', async () => {
    const res = await request(app)
      .post('/api/admin/ws/disconnect')
      .set('Authorization', 'Bearer wrong-key')
      .send({ stream_id: STREAM_ID });
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 503 when ADMIN_API_KEY is unset (fail-closed)', async () => {
    delete process.env.ADMIN_API_KEY;
    const res = await request(app)
      .post('/api/admin/ws/disconnect')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ stream_id: STREAM_ID });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('passes with correct static key', async () => {
    // Hub not initialised → 503 SERVICE_UNAVAILABLE (not an auth error)
    const res = await postDisconnect({ stream_id: STREAM_ID });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('passes with JWT role=admin', async () => {
    const token = generateToken({ address: 'addr-admin', role: 'admin' });
    const res = await request(app)
      .post('/api/admin/ws/disconnect')
      .set('Authorization', `Bearer ${token}`)
      .send({ stream_id: STREAM_ID });
    // Should reach the endpoint (not blocked by auth). Hub may or may not be
    // initialised — but either 200 or 503 means auth passed.
    expect([200, 503]).toContain(res.status);
  });

  it('returns 403 with JWT role=operator (insufficient privilege)', async () => {
    const token = generateToken({ address: 'addr-operator', role: 'operator' });
    const res = await request(app)
      .post('/api/admin/ws/disconnect')
      .set('Authorization', `Bearer ${token}`)
      .send({ stream_id: STREAM_ID });
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/ws/disconnect — input validation', () => {
  it('returns 400 when stream_id is missing from body', async () => {
    const res = await postDisconnect({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/stream_id/i);
  });

  it('returns 400 when stream_id is null', async () => {
    const res = await postDisconnect({ stream_id: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when stream_id is a number', async () => {
    const res = await postDisconnect({ stream_id: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when stream_id is a boolean', async () => {
    const res = await postDisconnect({ stream_id: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when stream_id is an empty string', async () => {
    const res = await postDisconnect({ stream_id: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/stream_id/i);
  });

  it('returns 400 when stream_id is whitespace only', async () => {
    const res = await postDisconnect({ stream_id: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when stream_id is an object', async () => {
    const res = await postDisconnect({ stream_id: { id: 'stream-1' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('validation error response uses success envelope format', async () => {
    const res = await postDisconnect({});
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.any(String),
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Hub not initialised → 503
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/ws/disconnect — hub not initialised', () => {
  it('returns 503 with SERVICE_UNAVAILABLE when getStreamHub returns null', async () => {
    // In the test environment the StreamHub singleton is not created,
    // so getStreamHub() already returns null.
    const res = await postDisconnect({ stream_id: STREAM_ID });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.message).toMatch(/hub.*not initialized|not initialized.*hub/i);
  });

  it('503 response does not leak stack traces or internal paths', async () => {
    const res = await postDisconnect({ stream_id: STREAM_ID });
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/Error:/);
    expect(body).not.toMatch(/at Object\./);
    expect(body).not.toMatch(/node_modules/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Happy path — hub mock present
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/ws/disconnect — happy path (mocked hub)', () => {
  beforeEach(async () => {
    // Provide a mock hub that reports 3 disconnected sockets.
    const hubModule = await import('../../src/ws/hub.js');
    vi.spyOn(hubModule, 'getStreamHub').mockReturnValue({
      disconnectByStreamId: vi.fn().mockReturnValue(3),
    } as any);

    // Stub out the DB audit write so tests don't need a live Postgres pool.
    const auditModule = await import('../../src/lib/auditLog.js');
    vi.spyOn(auditModule, 'recordAuditEventToDb').mockResolvedValue({
      seq: 1,
      timestamp: new Date().toISOString(),
      action: 'ADMIN_WS_DISCONNECT',
      resourceType: 'stream',
      resourceId: STREAM_ID,
    });
  });

  it('returns 200 with success envelope on valid request', async () => {
    const res = await postDisconnect({ stream_id: STREAM_ID });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('message');
    expect(res.body.data).toHaveProperty('stream_id', STREAM_ID);
    expect(res.body.data).toHaveProperty('disconnectedCount', 3);
  });

  it('trims leading/trailing whitespace from stream_id before processing', async () => {
    const res = await postDisconnect({ stream_id: `  ${STREAM_ID}  ` });
    expect(res.status).toBe(200);
    expect(res.body.data.stream_id).toBe(STREAM_ID);
  });

  it('response includes meta.timestamp', async () => {
    const res = await postDisconnect({ stream_id: STREAM_ID });
    expect(res.body.meta).toHaveProperty('timestamp');
    expect(typeof res.body.meta.timestamp).toBe('string');
    expect(new Date(res.body.meta.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('calls disconnectByStreamId with the exact (trimmed) stream_id', async () => {
    const hubModule = await import('../../src/ws/hub.js');
    const mockHub = hubModule.getStreamHub()!;

    await postDisconnect({ stream_id: `  ${STREAM_ID}  ` });

    expect((mockHub as any).disconnectByStreamId).toHaveBeenCalledWith(STREAM_ID);
  });

  it('works when hub has no subscribers (disconnectedCount: 0)', async () => {
    const hubModule = await import('../../src/ws/hub.js');
    vi.spyOn(hubModule, 'getStreamHub').mockReturnValue({
      disconnectByStreamId: vi.fn().mockReturnValue(0),
    } as any);

    const res = await postDisconnect({ stream_id: STREAM_ID });
    expect(res.status).toBe(200);
    expect(res.body.data.disconnectedCount).toBe(0);
  });

  it('calls recordAuditEventToDb with ADMIN_WS_DISCONNECT and correct payload', async () => {
    const auditModule = await import('../../src/lib/auditLog.js');

    await postDisconnect({ stream_id: STREAM_ID });

    expect(auditModule.recordAuditEventToDb).toHaveBeenCalledWith(
      'ADMIN_WS_DISCONNECT',
      'stream',
      STREAM_ID,
      expect.any(String), // correlationId
      expect.objectContaining({
        disconnectedCount: 3,
        closeCode: 4000,
        closeReason: 'admin-forced-disconnect',
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Audit persistence failure → 503
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/ws/disconnect — audit persistence failure', () => {
  beforeEach(async () => {
    const hubModule = await import('../../src/ws/hub.js');
    vi.spyOn(hubModule, 'getStreamHub').mockReturnValue({
      disconnectByStreamId: vi.fn().mockReturnValue(2),
    } as any);

    const auditModule = await import('../../src/lib/auditLog.js');
    vi.spyOn(auditModule, 'recordAuditEventToDb').mockRejectedValue(
      new Error('DB write failed'),
    );
  });

  it('returns 503 with PERSISTENCE_ERROR when audit write fails', async () => {
    const res = await postDisconnect({ stream_id: STREAM_ID });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('PERSISTENCE_ERROR');
  });

  it('includes disconnectedCount in the 503 error details', async () => {
    const res = await postDisconnect({ stream_id: STREAM_ID });
    expect(res.status).toBe(503);
    // The route attaches disconnectedCount to details even on persistence failure
    expect(res.body.error.details).toMatchObject({ disconnectedCount: 2 });
  });

  it('503 error message mentions audit persistence', async () => {
    const res = await postDisconnect({ stream_id: STREAM_ID });
    expect(res.body.error.message).toMatch(/audit|persist/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Response envelope shape
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/ws/disconnect — response envelope shape', () => {
  it('400 validation error uses { success: false, error: { code, message } }', async () => {
    const res = await postDisconnect({ stream_id: null });
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
    });
  });

  it('503 hub-unavailable uses { success: false, error: { code, message } }', async () => {
    const res = await postDisconnect({ stream_id: STREAM_ID });
    // Hub not initialised in this describe scope
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: expect.any(String) },
    });
  });
});
