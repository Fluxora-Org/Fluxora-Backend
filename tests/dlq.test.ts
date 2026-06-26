/**
 * Dead-Letter Queue (DLQ) API Integration Tests
 *
 * Issue #34 — Supertest integration tests for HTTP API
 * Issue #43 — Dead-letter queue inspection API (admin-only)
 *
 * All tests mock dlqRepository so no real DB is needed.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import request from 'supertest';

// ── Mock dlqRepository ────────────────────────────────────────────────────────
const mockRepo = vi.hoisted(() => ({
  insert:                 vi.fn(),
  findAll:                vi.fn(),
  findById:               vi.fn(),
  update:                 vi.fn(),
  deleteById:             vi.fn(),
  deleteAll:              vi.fn(),
  getConsumerSuspension:  vi.fn(),
  listSuspendedConsumers: vi.fn(),
  recordReplayFailure:    vi.fn(),
  recordReplaySuccess:    vi.fn(),
  resumeConsumer:         vi.fn(),
}));

vi.mock('../src/db/repositories/dlqRepository.js', () => ({
  dlqRepository: mockRepo,
  getSuspensionThreshold: () => 5,
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: vi.fn(),
  query:   vi.fn(),
  QueryTimeoutError: class QueryTimeoutError extends Error {},
}));

// ── Mock webhooks retry module (pre-existing duplicate export bug) ────────────
vi.mock('../src/webhooks/retry.js', () => ({
  attemptWebhookDeliveryWithRateLimit: vi.fn(),
  scheduleWebhookOutboxRetry: vi.fn(),
  calculateNextRetryTime: vi.fn(),
  generateRetrySchedule: vi.fn(),
}));

// ── Mock openapi spec (pre-existing syntax error with unescaped apostrophe) ───
vi.mock('../src/openapi/spec.js', () => ({ openApiDocument: {} }));

import { app } from '../src/app.js';
import { getAuditEntries, _resetAuditLog } from '../src/lib/auditLog.js';
import { generateToken } from '../src/lib/auth.js';
import { initializeConfig } from '../src/config/env.js';

let operatorToken: string;
let viewerToken: string;

const ENTRY = {
  id: 'dlq-001',
  topic: 'stream.created',
  payload: { streamId: 'abc' },
  error: 'connection timeout',
  attempts: 3,
  firstFailedAt: '2026-01-01T00:00:00.000Z',
  lastFailedAt:  '2026-01-02T00:00:00.000Z',
  correlationId: 'corr-1',
};

const SUSPENSION_NONE = null;
const SUSPENSION_HEALTHY = { topic: 'stream.created', consecutiveFailures: 2, suspended: false, suspendedAt: null, resumedAt: null, updatedAt: '2026-01-01T00:00:00.000Z' };
const SUSPENSION_ACTIVE  = { topic: 'stream.created', consecutiveFailures: 5, suspended: true,  suspendedAt: '2026-01-03T00:00:00.000Z', resumedAt: null, updatedAt: '2026-01-03T00:00:00.000Z' };

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'a-very-long-secret-key-for-testing-only-12345';
  initializeConfig();
  operatorToken = generateToken({ address: 'GOPERATOR', role: 'operator' });
  viewerToken   = generateToken({ address: 'GVIEWER',   role: 'viewer' });
});

beforeEach(() => {
  vi.clearAllMocks();
  _resetAuditLog();
  mockRepo.findAll.mockResolvedValue({ entries: [], total: 0 });
  mockRepo.listSuspendedConsumers.mockResolvedValue([]);
  mockRepo.findById.mockResolvedValue(undefined);
  mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);
  mockRepo.update.mockResolvedValue(undefined);
  mockRepo.deleteById.mockResolvedValue(false);
  mockRepo.deleteAll.mockResolvedValue(0);
  mockRepo.recordReplaySuccess.mockResolvedValue(undefined);
  mockRepo.recordReplayFailure.mockResolvedValue(SUSPENSION_HEALTHY);
  mockRepo.resumeConsumer.mockResolvedValue(null);
  mockRepo.insert.mockResolvedValue(undefined);
});

afterEach(() => { _resetAuditLog(); });

describe('Webhook Dead-Letter Queue', () => {

  // ── Auth guards ─────────────────────────────────────────────────────────────

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

  // ── List endpoint ───────────────────────────────────────────────────────────

  it('GET /admin/dlq → 200 empty list', async () => {
    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.data.entries).toEqual([]);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.has_more).toBe(false);
    expect(Array.isArray(res.body.data.suspendedTopics)).toBe(true);
  });

  it('GET /admin/dlq → 200 returns entries', async () => {
    mockRepo.findAll.mockResolvedValue({ entries: [ENTRY, { ...ENTRY, id: 'dlq-002' }], total: 2 });

    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.data.entries).toHaveLength(2);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.has_more).toBe(false);
  });

  it('GET /admin/dlq?limit=1 → pagination with has_more=true', async () => {
    mockRepo.findAll.mockResolvedValue({ entries: [ENTRY], total: 2 });

    const res = await request(app)
      .get('/admin/dlq?limit=1')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.has_more).toBe(true);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.limit).toBe(1);
    expect(res.body.data.offset).toBe(0);
  });

  it('GET /admin/dlq?limit=0 → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .get('/admin/dlq?limit=0')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /admin/dlq?limit=101 → 400 VALIDATION_ERROR', async () => {
    await request(app)
      .get('/admin/dlq?limit=101')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(400);
  });

  it('GET /admin/dlq?offset=-1 → 400 VALIDATION_ERROR', async () => {
    await request(app)
      .get('/admin/dlq?offset=-1')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(400);
  });

  it('GET /admin/dlq records DLQ_LISTED audit event', async () => {
    await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    const audit = getAuditEntries();
    expect(audit.find((e) => e.action === 'DLQ_LISTED')).toBeDefined();
  });

  // ── Single-entry endpoint ───────────────────────────────────────────────────

  it('GET /admin/dlq/:id → 200 returns entry + consumerSuspended', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_HEALTHY);

    const res = await request(app)
      .get('/admin/dlq/dlq-001')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.data.entry.id).toBe('dlq-001');
    expect(res.body.data.consumerSuspended).toBe(false);
    expect(res.body.data.consecutiveFailures).toBe(2);
  });

  it('GET /admin/dlq/:id → consumerSuspended=true when suspended', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_ACTIVE);

    const res = await request(app)
      .get('/admin/dlq/dlq-001')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.data.consumerSuspended).toBe(true);
  });

  it('GET /admin/dlq/:id → 404 for unknown id', async () => {
    const res = await request(app)
      .get('/admin/dlq/does-not-exist')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── Replay endpoint ─────────────────────────────────────────────────────────

  it('POST /admin/dlq/:id/replay → 200 resets attempts', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);

    const res = await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.data.message).toBe('DLQ entry replayed');
    expect(mockRepo.update).toHaveBeenCalledWith('dlq-001', expect.objectContaining({ attempts: 0 }));
    expect(mockRepo.recordReplaySuccess).toHaveBeenCalledWith('stream.created');
  });

  it('POST /admin/dlq/:id/replay → 409 when consumer is suspended', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_ACTIVE);

    const res = await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(409);

    expect(res.body.error.code).toBe('CONSUMER_SUSPENDED');
    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it('POST /admin/dlq/:id/replay → 404 for unknown entry', async () => {
    await request(app)
      .post('/admin/dlq/unknown-id/replay')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(404);
  });

  it('POST /admin/dlq/:id/replay requires operator role', async () => {
    const res = await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('POST /admin/dlq/:id/replay with failed=true increments failures', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);
    mockRepo.recordReplayFailure.mockResolvedValue({ ...SUSPENSION_HEALTHY, consecutiveFailures: 3 });

    await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ failed: true })
      .expect(200);

    expect(mockRepo.recordReplayFailure).toHaveBeenCalledWith('stream.created');
    expect(mockRepo.recordReplaySuccess).not.toHaveBeenCalled();
  });

  it('POST replay emits DLQ_REPLAYED audit event', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);

    await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    const audit = getAuditEntries();
    const ev = audit.find((e) => e.action === 'DLQ_REPLAYED');
    expect(ev).toBeDefined();
    expect(ev?.resourceId).toBe('dlq-001');
    expect(ev?.meta?.topic).toBe('stream.created');
  });

  // ── Delete (acknowledge) ────────────────────────────────────────────────────

  it('DELETE /admin/dlq/:id → 200 removes entry', async () => {
    mockRepo.deleteById.mockResolvedValue(true);

    const res = await request(app)
      .delete('/admin/dlq/dlq-001')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.data.id).toBe('dlq-001');
  });

  it('DELETE /admin/dlq/:id → 404 for unknown entry', async () => {
    const res = await request(app)
      .delete('/admin/dlq/ghost-id')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── Bulk purge ──────────────────────────────────────────────────────────────

  it('DELETE /admin/dlq → 200 purges all entries', async () => {
    mockRepo.deleteAll.mockResolvedValue(3);

    const res = await request(app)
      .delete('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.data.purged).toBe(3);
  });

  it('DELETE /admin/dlq?topic=t → purges by topic filter', async () => {
    mockRepo.deleteAll.mockResolvedValue(2);

    const res = await request(app)
      .delete('/admin/dlq?topic=stream.created')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(mockRepo.deleteAll).toHaveBeenCalledWith('stream.created');
    expect(res.body.data.purged).toBe(2);
  });

  it('DELETE /admin/dlq requires operator role', async () => {
    const res = await request(app)
      .delete('/admin/dlq')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
