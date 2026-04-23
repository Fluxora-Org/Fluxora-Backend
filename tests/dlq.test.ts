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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../src/index.js';
import { webhookDeliveryStore } from '../src/webhooks/store.js';
import { webhookService } from '../src/webhooks/service.js';
import type { WebhookDelivery, WebhookEvent } from '../src/webhooks/types.js';
import { enqueueDeadLetter, _resetDlq } from '../src/routes/dlq.js';
import { getAuditEntries, _resetAuditLog } from '../src/lib/auditLog.js';

// Test tokens (these should match your test setup)
const operatorToken = 'operator-test-token';
const viewerToken = 'viewer-test-token';

// Mock fetch for testing
const originalFetch = global.fetch;
let mockFetchResponses: Map<string, Response> = new Map();

function mockFetch(url: string, options?: RequestInit): Promise<Response> {
  const response = mockFetchResponses.get(url);
  if (response) {
    return Promise.resolve(response.clone());
  }
  return Promise.reject(new Error(`No mock response for ${url}`));
}

describe('Webhook Dead-Letter Queue', () => {
  beforeEach(() => {
    global.fetch = mockFetch as any;
    webhookDeliveryStore.clear();
    mockFetchResponses.clear();
    _resetDlq();
    _resetAuditLog();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    _resetDlq();
    _resetAuditLog();
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

  // Additional tests for audit logging
  it('GET /admin/dlq records audit event', async () => {
    enqueueDeadLetter({ topic: 'test.topic', payload: {}, error: 'err', attempts: 1 });

    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    const auditEntries = getAuditEntries();
    const dlqAuditEntry = auditEntries.find(e => e.action === 'DLQ_LISTED');
    expect(dlqAuditEntry).toBeDefined();
    expect(dlqAuditEntry?.resourceType).toBe('dlq');
    expect(dlqAuditEntry?.resourceId).toBe('list');
    expect(dlqAuditEntry?.meta?.total).toBe(1);
  });

  // Replay endpoint tests
  it('POST /admin/dlq/:id/replay replays entry with audit logging', async () => {
    const entry = enqueueDeadLetter({ 
      topic: 'stream.created', 
      payload: { streamId: 'test' }, 
      error: 'timeout', 
      attempts: 3 
    });

    const res = await request(app)
      .post(`/admin/dlq/${entry.id}/replay`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.message).toBe('DLQ entry replayed');
    expect(res.body.id).toBe(entry.id);
    expect(res.body.topic).toBe('stream.created');

    // Verify audit logging
    const auditEntries = getAuditEntries();
    const replayAuditEntry = auditEntries.find(e => e.action === 'DLQ_REPLAYED');
    expect(replayAuditEntry).toBeDefined();
    expect(replayAuditEntry?.resourceType).toBe('dlq');
    expect(replayAuditEntry?.resourceId).toBe(entry.id);
    expect(replayAuditEntry?.meta?.topic).toBe('stream.created');
  });

  it('POST /admin/dlq/:id/replay resets attempts count', async () => {
    const entry = enqueueDeadLetter({ 
      topic: 'stream.created', 
      payload: {}, 
      error: 'timeout', 
      attempts: 5 
    });

    await request(app)
      .post(`/admin/dlq/${entry.id}/replay`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    // Verify attempts were reset
    const getRes = await request(app)
      .get(`/admin/dlq/${entry.id}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(getRes.body.entry.attempts).toBe(0);
  });

  it('POST /admin/dlq/:id/replay requires operator role', async () => {
    const entry = enqueueDeadLetter({ topic: 'test', payload: {}, error: 'err', attempts: 1 });

    const res = await request(app)
      .post(`/admin/dlq/${entry.id}/replay`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('POST /admin/dlq/:id/replay returns 404 for unknown entry', async () => {
    const res = await request(app)
      .post('/admin/dlq/unknown-id/replay')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // Purge endpoint tests
  it('DELETE /admin/dlq purges all entries with audit logging', async () => {
    enqueueDeadLetter({ topic: 'stream.created', payload: {}, error: 'err1', attempts: 1 });
    enqueueDeadLetter({ topic: 'stream.cancelled', payload: {}, error: 'err2', attempts: 1 });

    const res = await request(app)
      .delete('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.message).toBe('DLQ entries purged');
    expect(res.body.purged).toBe(2);
    expect(res.body.topicFilter).toBe('all');
    expect(res.body.removedIds).toHaveLength(2);

    // Verify audit logging
    const auditEntries = getAuditEntries();
    const purgeAuditEntry = auditEntries.find(e => e.action === 'DLQ_PURGED');
    expect(purgeAuditEntry).toBeDefined();
    expect(purgeAuditEntry?.resourceType).toBe('dlq');
    expect(purgeAuditEntry?.resourceId).toBe('bulk');
    expect(purgeAuditEntry?.meta?.purgedCount).toBe(2);
  });

  it('DELETE /admin/dlq?topic=filter purges filtered entries', async () => {
    enqueueDeadLetter({ topic: 'stream.created', payload: {}, error: 'err1', attempts: 1 });
    enqueueDeadLetter({ topic: 'stream.cancelled', payload: {}, error: 'err2', attempts: 1 });
    enqueueDeadLetter({ topic: 'stream.created', payload: {}, error: 'err3', attempts: 1 });

    const res = await request(app)
      .delete('/admin/dlq?topic=stream.created')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.purged).toBe(2);
    expect(res.body.topicFilter).toBe('stream.created');

    // Verify remaining entries
    const listRes = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(listRes.body.total).toBe(1);
    expect(listRes.body.entries[0].topic).toBe('stream.cancelled');
  });

  it('DELETE /admin/dlq handles empty DLQ gracefully', async () => {
    const res = await request(app)
      .delete('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.message).toBe('No DLQ entries to purge');
    expect(res.body.purged).toBe(0);
  });

  it('DELETE /admin/dlq requires operator role', async () => {
    const res = await request(app)
      .delete('/admin/dlq')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('DELETE /admin/dlq handles no matching entries', async () => {
    enqueueDeadLetter({ topic: 'stream.created', payload: {}, error: 'err', attempts: 1 });

    const res = await request(app)
      .delete('/admin/dlq?topic=nonexistent')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.message).toBe('No DLQ entries to purge');
    expect(res.body.purged).toBe(0);
  });
});
