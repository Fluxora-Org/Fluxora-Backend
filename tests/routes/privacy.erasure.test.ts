/**
 * tests/routes/privacy.erasure.test.ts
 *
 * Comprehensive tests for the GDPR right-to-erasure endpoint (issue #730).
 *
 * DELETE /api/privacy/erasure/:recipientAddress
 *
 * Coverage:
 *  - Auth guard: 401 without header, 403 with bad token, 200 with valid token
 *  - Input validation: empty, oversized address
 *  - Happy path: erases PII columns, preserves financial data, returns counts
 *  - Legal hold: skipped rows are counted and reported
 *  - Idempotency: re-running is safe
 *  - Audit trail: PII_ERASURE_REQUESTED entry written on success and failure
 *  - DB error: returns 500, still attempts audit entry
 *  - Existing GET/HEAD routes are not broken
 *  - Method guard: POST/PUT on policy/retention returns 405
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockRecordAuditEventToDb = vi.fn().mockResolvedValue({});

vi.mock('../../src/db/pool.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/db/pool.js')>();
  return {
    ...orig,
    getPool: () => ({}),
    query: (...args: unknown[]) => mockQuery(...args),
  };
});

vi.mock('../../src/lib/auditLog.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/lib/auditLog.js')>();
  return {
    ...orig,
    recordAuditEventToDb: (...args: unknown[]) => mockRecordAuditEventToDb(...args),
  };
});

// ── App factory (imported after mocks are registered) ─────────────────────────

import { createApp } from '../../src/app.js';

const ADMIN_KEY = 'test-admin-key-erasure';
const VALID_ADDRESS = 'GDTEST123456789012345678901234567890123456789012345678';

// ── Helper ────────────────────────────────────────────────────────────────────

function setQueryResults(rowsErased = 3, legalHoldCount = 0) {
  mockQuery
    .mockResolvedValueOnce({ rowCount: rowsErased, rows: [] })       // UPDATE
    .mockResolvedValueOnce({ rows: [{ cnt: String(legalHoldCount) }] }); // COUNT
}

describe('DELETE /api/privacy/erasure/:recipientAddress', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    mockQuery.mockReset();
    mockRecordAuditEventToDb.mockReset().mockResolvedValue({});
    app = createApp();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    vi.restoreAllMocks();
  });

  // ── Auth guard ──────────────────────────────────────────────────────────────

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

  it('issues a parameterised UPDATE that sets tombstone on address columns', async () => {
    setQueryResults(1, 0);
    await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    const updateCall = mockQuery.mock.calls[0];
    const sql: string = updateCall[1];
    const params: unknown[] = updateCall[2];

    expect(sql).toMatch(/UPDATE\s+streams/i);
    expect(sql).toMatch(/sender_address\s*=\s*\$1/i);
    expect(sql).toMatch(/recipient_address\s*=\s*\$1/i);
    expect(sql).toMatch(/sender_address_hash\s*=\s*NULL/i);
    expect(sql).toMatch(/recipient_address_hash\s*=\s*NULL/i);
    expect(params[0]).toBe('[REDACTED:GDPR-17]');
    expect(params[1]).toBe(VALID_ADDRESS);
  });

  it('excludes legal-hold rows from the UPDATE', async () => {
    setQueryResults(2, 0);
    await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    const updateSql: string = mockQuery.mock.calls[0][1];
    expect(updateSql).toMatch(/legal_hold/i);
    expect(updateSql).toMatch(/FALSE/i);
  });

  it('does NOT touch amount or ledger columns', async () => {
    setQueryResults(1, 0);
    await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    const updateSql: string = mockQuery.mock.calls[0][1];
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

  it('writes a PII_ERASURE_REQUESTED audit entry on success', async () => {
    setQueryResults(1, 0);
    await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    expect(mockRecordAuditEventToDb).toHaveBeenCalled();
    const [action, resourceType] = mockRecordAuditEventToDb.mock.calls[0];
    expect(action).toBe('PII_ERASURE_REQUESTED');
    expect(resourceType).toBe('streams');
  });

  it('includes rowsErased in audit meta', async () => {
    setQueryResults(5, 0);
    await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    const meta = mockRecordAuditEventToDb.mock.calls[0][4];
    expect(meta.rowsErased).toBe(5);
  });

  it('does not include the full address in audit resourceId (truncated)', async () => {
    setQueryResults(1, 0);
    await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    const resourceId: string = mockRecordAuditEventToDb.mock.calls[0][2];
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

  // ── DB error handling ────────────────────────────────────────────────────────

  it('returns 500 when the UPDATE query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));
    const res = await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('ERASURE_FAILED');
  });

  it('attempts a failure audit entry when DB error occurs', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));
    await request(app)
      .delete(`/api/privacy/erasure/${VALID_ADDRESS}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    expect(mockRecordAuditEventToDb).toHaveBeenCalled();
    const meta = mockRecordAuditEventToDb.mock.calls[0][4];
    expect(meta.outcome).toBe('failed');
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
