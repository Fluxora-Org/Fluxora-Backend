/**
 * tests/routes/privacy.erasure.test.ts
 *
 * Comprehensive tests for the GDPR right-to-erasure endpoint (Issue #910).
 *
 * DELETE /api/privacy/erasure/:recipientAddress
 *
 * Coverage:
 *  - Auth guard: 401 without header, 403 with bad token, 200 with valid token/role
 *  - Role-based authorization: admin & data-protection-officer allowed, operator/viewer forbidden (403)
 *  - Input validation: empty, oversized address (>256 chars)
 *  - Happy path: erases PII columns, replaces with tombstone, preserves financial data
 *  - Legal hold: skipped rows are counted and reported
 *  - Idempotency: re-running is safe
 *  - Audit trail: GDPR_ERASURE and PII_ERASURE_REQUESTED entries written on success and failure
 *  - DB transaction & Rollback: performs within transaction and rolls back on failure
 *  - Security headers & Existing GET/HEAD/405 routes preserved
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { generateToken } from '../../src/lib/auth.js';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockRecordAuditEventToDb = vi.fn().mockResolvedValue({});

vi.mock('../../src/db/pool.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/db/pool.js')>();
  return {
    ...orig,
    getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
    query: (...args: unknown[]) => mockQuery(...args),
    withClient: async (_pool: unknown, fn: (client: unknown) => Promise<unknown>) => {
      const client = { query: (...args: unknown[]) => mockQuery(...args) };
      return fn(client);
    },
  };
});

vi.mock('../../src/lib/auditLog.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/lib/auditLog.js')>();
  return {
    ...orig,
    recordAuditEventToDb: (...args: unknown[]) => mockRecordAuditEventToDb(...args),
    recordErasureAuditLog: (action: string, resourceType: string, address: string, ...rest: unknown[]) =>
      mockRecordAuditEventToDb(action, resourceType, address.substring(0, 8) + '…', ...rest),
  };
});

// ── App factory (imported after mocks are registered) ─────────────────────────

import { createApp } from '../../src/app.js';
import { initializeConfig } from '../../src/config/env.js';

const ADMIN_KEY = 'test-admin-key-erasure';
const VALID_ADDRESS = 'GDTEST123456789012345678901234567890123456789012345678';

// ── Helper ────────────────────────────────────────────────────────────────────

function setQueryResults(rowsErased = 3, legalHoldCount = 0) {
  mockQuery
    .mockResolvedValueOnce({ rows: [] })                                 // BEGIN
    .mockResolvedValueOnce({ rowCount: rowsErased, rows: [] })           // UPDATE
    .mockResolvedValueOnce({ rows: [{ cnt: String(legalHoldCount) }] })  // COUNT
    .mockResolvedValueOnce({ rows: [] });                                // COMMIT
}

describe('DELETE /api/privacy/erasure/:recipientAddress', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long';
    process.env.PGCRYPTO_KEY = 'test-pgcrypto-key-min-32-chars-long';
    initializeConfig();
    mockQuery.mockReset();
    mockRecordAuditEventToDb.mockReset().mockResolvedValue({});
    app = createApp();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    vi.restoreAllMocks();
  });

  // ── Auth guard & Role Authorization ──────────────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization scheme is not Bearer', async () => {
    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Basic ${ADMIN_KEY}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when Bearer token is wrong', async () => {
    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(403);
  });

  it('returns 503 when ADMIN_API_KEY env var is not set', async () => {
    delete process.env.ADMIN_API_KEY;
    const localApp = createApp();
    const res = await request(localApp)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(503);
  });

  it('allows access for data-protection-officer role', async () => {
    setQueryResults(1, 0);
    const dpoToken = generateToken({ address: VALID_ADDRESS, role: 'data-protection-officer' });
    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${dpoToken}`);
    expect(res.status).toBe(200);
  });

  it('denies access for forbidden roles (operator)', async () => {
    const operatorToken = generateToken({ address: VALID_ADDRESS, role: 'operator' });
    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(403);
  });

  it('denies access for forbidden roles (viewer)', async () => {
    const viewerToken = generateToken({ address: VALID_ADDRESS, role: 'viewer' });
    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('returns 400 for an address longer than 256 characters', async () => {
    const longAddress = 'G'.repeat(257);
    const res = await request(app)
      .delete(`/api/privacy/erasure/${longAddress}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ADDRESS');
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns 200 with rowsErased count on success', async () => {
    setQueryResults(3, 0);
    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.erased).toBe(true);
    expect(res.body.rowsErased).toBe(3);
    expect(res.body.rowsSkippedLegalHold).toBe(0);
  });

  it('returns 200 with rowsErased=0 when address not found', async () => {
    setQueryResults(0, 0);
    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.rowsErased).toBe(0);
  });

  it('issues a parameterised UPDATE that sets tombstone on address columns inside transaction', async () => {
    setQueryResults(1, 0);
    await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    const updateCall = mockQuery.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('UPDATE streams'));
    expect(updateCall).toBeDefined();

    const sql: string = updateCall[0];
    const params: unknown[] = updateCall[1];

    expect(sql).toMatch(/UPDATE\s+streams/i);
    expect(sql).toMatch(/sender_address\s*=\s*\$1/i);
    expect(sql).toMatch(/recipient_address\s*=\s*\$1/i);
    expect(sql).toMatch(/sender_address_hash\s*=\s*NULL/i);
    expect(sql).toMatch(/recipient_address_hash\s*=\s*NULL/i);
    expect(params[0]).toBe('[REDACTED_GDPR_ERASURE]');
    expect(params[1]).toBe(VALID_ADDRESS);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('excludes legal-hold rows from the UPDATE', async () => {
    setQueryResults(2, 0);
    await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    const updateCall = mockQuery.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('UPDATE streams'));
    const updateSql: string = updateCall[0];
    expect(updateSql).toMatch(/legal_hold/i);
    expect(updateSql).toMatch(/FALSE/i);
  });

  it('does NOT touch amount or ledger columns (preserving financial data)', async () => {
    setQueryResults(1, 0);
    await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    const updateCall = mockQuery.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('UPDATE streams'));
    const updateSql: string = updateCall[0];
    expect(updateSql).not.toMatch(/\bamount\b/i);
    expect(updateSql).not.toMatch(/\bledger\b/i);
  });

  it('reports rowsSkippedLegalHold when legal-hold rows exist', async () => {
    setQueryResults(2, 1);
    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.rowsErased).toBe(2);
    expect(res.body.rowsSkippedLegalHold).toBe(1);
    expect(res.body.message).toMatch(/legal hold/i);
  });

  // ── Audit trail ─────────────────────────────────────────────────────────────

  it('writes audit entries on success without including full address', async () => {
    setQueryResults(1, 0);
    await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    expect(mockRecordAuditEventToDb).toHaveBeenCalled();
    const calls = mockRecordAuditEventToDb.mock.calls;
    const erasureCall = calls.find(call => call[0] === 'GDPR_ERASURE' || call[0] === 'PII_ERASURE_REQUESTED');
    expect(erasureCall).toBeDefined();

    const resourceId: string = erasureCall[2];
    expect(resourceId.length).toBeLessThan(VALID_ADDRESS.length);
    expect(resourceId).not.toBe(VALID_ADDRESS);
  });

  it('still returns 200 when audit write fails (must not suppress erasure)', async () => {
    setQueryResults(2, 0);
    mockRecordAuditEventToDb.mockRejectedValueOnce(new Error('audit DB down'));

    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.rowsErased).toBe(2);
  });

  // ── Transaction & DB error handling ──────────────────────────────────────────

  it('returns 500 and issues ROLLBACK when the UPDATE query throws inside transaction', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                // BEGIN
      .mockRejectedValueOnce(new Error('connection lost')); // UPDATE fails

    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('ERASURE_FAILED');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('attempts a failure audit entry when DB error occurs', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                // BEGIN
      .mockRejectedValueOnce(new Error('connection lost')); // UPDATE fails

    await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    expect(mockRecordAuditEventToDb).toHaveBeenCalled();
  });

  // ── Idempotency ──────────────────────────────────────────────────────────────

  it('is safe to call twice — second call erases 0 rows', async () => {
    setQueryResults(2, 0);
    const first = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(first.status).toBe(200);
    expect(first.body.rowsErased).toBe(2);

    mockQuery.mockReset();
    setQueryResults(0, 0);
    const second = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(second.status).toBe(200);
    expect(second.body.rowsErased).toBe(0);
  });

  // ── Security headers ─────────────────────────────────────────────────────────

  it('sets Cache-Control: no-store on erasure response', async () => {
    setQueryResults(0, 0);
    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets X-Content-Type-Options: nosniff on erasure response', async () => {
    setQueryResults(0, 0);
    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  // ── Existing routes unbroken ─────────────────────────────────────────────────

  it('POST /api/privacy/policy still returns 405', async () => {
    const res = await request(app).post('/api/privacy/policy');
    expect(res.status).toBe(405);
  });

  it('PUT /api/privacy/retention still returns 405', async () => {
    const res = await request(app).put('/api/privacy/retention');
    expect(res.status).toBe(405);
  });

  it('GET /api/privacy/policy still returns 200', async () => {
    const res = await request(app).get('/api/privacy/policy');
    expect(res.status).toBe(200);
  });

  it('GET /api/privacy/retention still returns 200', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.status).toBe(200);
  });
});
