/**
 * Dead-Letter Queue (DLQ) API Integration Tests
 *
 * Issue #34 — Supertest integration tests for HTTP API
 * Issue #43 — Dead-letter queue inspection API (admin-only)
 *
 * Coverage areas
 * --------------
 * - 401 when no auth token supplied
 * - 403 when authenticated but role is not 'operator'
 * - 200 list with pagination (limit, offset, has_more)
 * - 200 topic filter
 * - 200 GET single entry
 * - 404 for unknown entry
 * - 200 DELETE (acknowledge) entry
 * - 400 for invalid pagination params
 */
import express from 'express';
import request from 'supertest';
import { dlqRouter, enqueueDeadLetter, _resetDlq } from '../src/routes/dlq.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { requestIdMiddleware } from '../src/errors.js';
import { correlationIdMiddleware } from '../src/middleware/correlationId.js';
import { generateToken } from '../src/lib/auth.js';
import { initializeConfig } from '../src/config/env.js';

// Initialize config before any test module code runs (upstream requirement)
initializeConfig();

function createTestApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(correlationIdMiddleware);
  app.use(express.json());
  app.use('/admin/dlq', dlqRouter);
  app.use(errorHandler);
  return app;
}

const operatorToken = generateToken({ address: 'GADMIN', role: 'operator' });
const viewerToken   = generateToken({ address: 'GVIEWER', role: 'viewer' });

describe('DLQ Admin API', () => {
  let app: any;

  beforeEach(() => {
    app = createTestApp();
    _resetDlq();
  });

  // ── Auth guard tests ──────────────────────────────────────────────────────

  it('GET /admin/dlq → 401 with no token', async () => {
    const res = await request(app).get('/admin/dlq').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /admin/dlq → 403 with viewer role', async () => {
    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('GET /admin/dlq/:id → 401 with no token', async () => {
    const res = await request(app).get('/admin/dlq/anything').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('DELETE /admin/dlq/:id → 401 with no token', async () => {
    const res = await request(app).delete('/admin/dlq/anything').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // ── List endpoint ─────────────────────────────────────────────────────────

  it('GET /admin/dlq → 200 empty list when no entries', async () => {
    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.entries).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.has_more).toBe(false);
  });

  it('GET /admin/dlq → 200 returns all entries', async () => {
    enqueueDeadLetter({ topic: 'stream.created', payload: { id: 'x' }, error: 'timeout', attempts: 3 });
    enqueueDeadLetter({ topic: 'stream.cancelled', payload: { id: 'y' }, error: 'parse error', attempts: 1 });

    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.entries).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.has_more).toBe(false);
  });

  it('GET /admin/dlq?limit=1 → pagination with has_more=true', async () => {
    enqueueDeadLetter({ topic: 'stream.created', payload: {}, error: 'err1', attempts: 1 });
    enqueueDeadLetter({ topic: 'stream.created', payload: {}, error: 'err2', attempts: 2 });

    const res = await request(app)
      .get('/admin/dlq?limit=1')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.entries).toHaveLength(1);
    expect(res.body.has_more).toBe(true);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(0);
  });

  it('GET /admin/dlq?offset=1 → second page', async () => {
    enqueueDeadLetter({ topic: 'stream.created', payload: {}, error: 'e1', attempts: 1 });
    enqueueDeadLetter({ topic: 'stream.created', payload: {}, error: 'e2', attempts: 1 });

    const res = await request(app)
      .get('/admin/dlq?limit=1&offset=1')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.entries).toHaveLength(1);
    expect(res.body.has_more).toBe(false);
    expect(res.body.offset).toBe(1);
  });

  it('GET /admin/dlq?topic=stream.cancelled → filters by topic', async () => {
    enqueueDeadLetter({ topic: 'stream.created',   payload: {}, error: 'e', attempts: 1 });
    enqueueDeadLetter({ topic: 'stream.cancelled', payload: {}, error: 'e', attempts: 1 });

    const res = await request(app)
      .get('/admin/dlq?topic=stream.cancelled')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].topic).toBe('stream.cancelled');
    expect(res.body.total).toBe(1);
  });

  it('GET /admin/dlq?limit=0 → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .get('/admin/dlq?limit=0')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /admin/dlq?limit=101 → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .get('/admin/dlq?limit=101')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /admin/dlq?offset=-1 → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .get('/admin/dlq?offset=-1')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ── Single-entry endpoint ─────────────────────────────────────────────────

  it('GET /admin/dlq/:id → 200 returns specific entry', async () => {
    const entry = enqueueDeadLetter({ topic: 'test.topic', payload: { key: 'val' }, error: 'boom', attempts: 2 });

    const res = await request(app)
      .get(`/admin/dlq/${entry.id}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.entry.id).toBe(entry.id);
    expect(res.body.entry.topic).toBe('test.topic');
    expect(res.body.entry.attempts).toBe(2);
  });

  it('GET /admin/dlq/:id → 404 for unknown id', async () => {
    const res = await request(app)
      .get('/admin/dlq/does-not-exist')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── Delete (acknowledge) endpoint ─────────────────────────────────────────

  it('DELETE /admin/dlq/:id → 200 removes the entry', async () => {
    const entry = enqueueDeadLetter({ topic: 'test.topic', payload: {}, error: 'err', attempts: 1 });

    const del = await request(app)
      .delete(`/admin/dlq/${entry.id}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(del.body.id).toBe(entry.id);

    // Confirm it's gone
    await request(app)
      .get(`/admin/dlq/${entry.id}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(404);
  });

  it('DELETE /admin/dlq/:id → 404 for already-removed entry', async () => {
    const res = await request(app)
      .delete('/admin/dlq/ghost-id')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── DLQ entry shape ───────────────────────────────────────────────────────

  it('DLQ entry has required fields', () => {
    const entry = enqueueDeadLetter({
      topic: 'stream.created',
      payload: { streamId: 'abc' },
      error: 'Connection refused',
      attempts: 5,
      correlationId: 'corr-123',
    });

    expect(entry.id).toMatch(/^dlq-/);
    expect(entry.firstFailedAt).toBeTruthy();
    expect(entry.lastFailedAt).toBeTruthy();
    expect(entry.correlationId).toBe('corr-123');
  });
});
