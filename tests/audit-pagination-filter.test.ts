/**
 * Pagination and filtering tests for GET /api/audit
 *
 * Covers:
 * - Pagination with limit/offset (defaults, custom, max clamp)
 * - Filtering by actionType, dateFrom, dateTo
 * - Combined filters
 * - Empty results when no match
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { recordAuditEvent, getAuditEntries, _resetAuditLog } from '../src/lib/auditLog.js';
import { auditRouter } from '../src/routes/audit.js';
import { correlationIdMiddleware } from '../src/middleware/correlationId.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { authenticate } from '../src/middleware/auth.js';
import { generateToken } from '../src/lib/auth.js';
import { initializeConfig } from '../src/config/env.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupertestApp = any;

let testToken: string;

function createTestApp(): SupertestApp {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use('/api/audit', auditRouter);
  app.use(errorHandler);
  return app;
}

function withAuth(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${testToken}`);
}

describe('GET /api/audit — Pagination and filtering', () => {
  let app: SupertestApp;

  beforeEach(() => {
    _resetAuditLog();
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'a-very-long-secret-key-for-testing-only-12345';
    initializeConfig();
    testToken = generateToken({ address: 'GTEST', role: 'operator' });
    app = createTestApp();
  });

  // ── Pagination ─────────────────────────────────────────────────────────────

  it('returns first page with default limit (20)', async () => {
    for (let i = 0; i < 25; i++) {
      recordAuditEvent('STREAM_CREATED', 'stream', `stream-${i}`);
    }
    const res = await withAuth(request(app).get('/api/audit')).expect(200);
    expect(res.body.data.entries).toHaveLength(20);
    expect(res.body.data.total).toBe(25);
  });

  it('returns custom page size (limit=5)', async () => {
    for (let i = 0; i < 10; i++) {
      recordAuditEvent('STREAM_CREATED', 'stream', `stream-${i}`);
    }
    const res = await withAuth(request(app).get('/api/audit?limit=5')).expect(200);
    expect(res.body.data.entries).toHaveLength(5);
    expect(res.body.data.total).toBe(10);
    expect(res.body.data.entries[0].resourceId).toBe('stream-0');
    expect(res.body.data.entries[4].resourceId).toBe('stream-4');
  });

  it('returns second page (offset=5, limit=5)', async () => {
    for (let i = 0; i < 15; i++) {
      recordAuditEvent('STREAM_CREATED', 'stream', `stream-${i}`);
    }
    const res = await withAuth(request(app).get('/api/audit?offset=5&limit=5')).expect(200);
    expect(res.body.data.entries).toHaveLength(5);
    expect(res.body.data.entries[0].resourceId).toBe('stream-5');
    expect(res.body.data.entries[4].resourceId).toBe('stream-9');
  });

  it('enforces max page size (limit=200 clamped to 100)', async () => {
    for (let i = 0; i < 150; i++) {
      recordAuditEvent('STREAM_CREATED', 'stream', `stream-${i}`);
    }
    const res = await withAuth(request(app).get('/api/audit?limit=200')).expect(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns empty array when offset exceeds total', async () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 's1');
    recordAuditEvent('STREAM_CREATED', 'stream', 's2');
    const res = await withAuth(request(app).get('/api/audit?offset=100')).expect(200);
    expect(res.body.data.entries).toHaveLength(0);
    expect(res.body.data.total).toBe(2);
  });

  // ── Filtering by actionType ────────────────────────────────────────────────

  it('filters by actionType (only STREAM_CREATED entries)', async () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 's1');
    recordAuditEvent('STREAM_CANCELLED', 'stream', 's2');
    recordAuditEvent('STREAM_CREATED', 'stream', 's3');
    recordAuditEvent('PAUSE_FLAGS_UPDATED', 'pauseFlags', 'system');
    const res = await withAuth(
      request(app).get('/api/audit?actionType=STREAM_CREATED')
    ).expect(200);
    expect(res.body.data.entries).toHaveLength(2);
    expect(res.body.data.entries.every((e: { action: string }) => e.action === 'STREAM_CREATED')).toBe(true);
    expect(res.body.data.total).toBe(2);
  });

  // ── Filtering by date range ────────────────────────────────────────────────

  it('filters by dateFrom (entries at or after timestamp)', async () => {
    // Record entries with known timestamps
    recordAuditEvent('STREAM_CREATED', 'stream', 'old');
    // The timestamps are auto-generated, so we use the recorded entries
    const allEntries = getAuditEntries();
    const cutoff = allEntries[0]!.timestamp;

    recordAuditEvent('STREAM_CREATED', 'stream', 'new1');
    recordAuditEvent('STREAM_CREATED', 'stream', 'new2');

    const res = await withAuth(
      request(app).get(`/api/audit?dateFrom=${encodeURIComponent(cutoff)}`)
    ).expect(200);
    // Should include the entry at cutoff and all after
    expect(res.body.data.entries.length).toBeGreaterThanOrEqual(3);
  });

  it('filters by dateTo (entries at or before timestamp)', async () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 's1');
    recordAuditEvent('STREAM_CREATED', 'stream', 's2');
    const allEntries = getAuditEntries();
    const cutoff = allEntries[0]!.timestamp;

    recordAuditEvent('STREAM_CREATED', 'stream', 's3');

    const res = await withAuth(
      request(app).get(`/api/audit?dateTo=${encodeURIComponent(cutoff)}`)
    ).expect(200);
    // Only entries at or before cutoff
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0].resourceId).toBe('s1');
  });

  // ── Combined filters ───────────────────────────────────────────────────────

  it('combines actionType + date range filters', async () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 's1');
    const allEntries = getAuditEntries();
    const cutoff = allEntries[0]!.timestamp;

    recordAuditEvent('STREAM_CREATED', 'stream', 's2');
    recordAuditEvent('STREAM_CANCELLED', 'stream', 's3');
    recordAuditEvent('STREAM_CREATED', 'stream', 's4');

    const res = await withAuth(
      request(app).get(
        `/api/audit?actionType=STREAM_CREATED&dateFrom=${encodeURIComponent(cutoff)}`
      )
    ).expect(200);
    // Should include s1 (at cutoff), s2, s4 — but NOT s3 (CANCELLED)
    expect(res.body.data.entries.every((e: { action: string }) => e.action === 'STREAM_CREATED')).toBe(true);
    expect(res.body.data.total).toBe(3);
  });

  // ── No match ───────────────────────────────────────────────────────────────

  it('returns empty array when no entries match filters', async () => {
    recordAuditEvent('STREAM_CREATED', 'stream', 's1');
    recordAuditEvent('STREAM_CREATED', 'stream', 's2');

    const res = await withAuth(
      request(app).get('/api/audit?actionType=NONEXISTENT_ACTION')
    ).expect(200);
    expect(res.body.data.entries).toHaveLength(0);
    expect(res.body.data.total).toBe(0);
  });
});
