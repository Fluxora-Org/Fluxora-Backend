/**
 * Tests for DLQ admin routes — #43 (inspection) + #349 (consumer suspension).
 *
 * Coverage:
 *  - Auth guards: 401 (no token), 403 (viewer), 403 (viewer on resume)
 *  - GET /admin/dlq: list shape, suspendedTopics field, pagination validation
 *  - GET /admin/dlq/:id: entry + consumerSuspended field, 404
 *  - POST /admin/dlq/:id/replay: success, 404, 409 when suspended
 *  - POST /admin/dlq/:id/replay with failed=true: increments failures, suspends at threshold
 *  - POST /admin/dlq/consumers/:topic/resume: clears suspension, 401/403, idempotent
 *  - DELETE /admin/dlq/:id: 200, 404
 *  - DELETE /admin/dlq: bulk purge
 *  - Audit events emitted for replay, suspension, resume
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// ── Mock dlqRepository before importing app ───────────────────────────────────
// vi.mock is hoisted; use vi.hoisted() so mockRepo is in scope when the factory runs.
const mockRepo = vi.hoisted(() => ({
  insert:                  vi.fn(),
  findAll:                 vi.fn(),
  findById:                vi.fn(),
  update:                  vi.fn(),
  deleteById:              vi.fn(),
  deleteAll:               vi.fn(),
  getConsumerSuspension:   vi.fn(),
  listSuspendedConsumers:  vi.fn(),
  recordReplayFailure:     vi.fn(),
  recordReplaySuccess:     vi.fn(),
  resumeConsumer:          vi.fn(),
}));

vi.mock('../../src/db/repositories/dlqRepository.js', () => ({
  dlqRepository: mockRepo,
  getSuspensionThreshold: () => 5,
}));

// ── Also mock the pool so the app doesn't try to connect to Postgres ──────────
vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(),
  query:   vi.fn(),
  QueryTimeoutError: class QueryTimeoutError extends Error {},
}));

// ── Mock webhooks retry module (pre-existing duplicate export bug) ────────────
vi.mock('../../src/webhooks/retry.js', () => ({
  attemptWebhookDeliveryWithRateLimit: vi.fn(),
  scheduleWebhookOutboxRetry: vi.fn(),
  calculateNextRetryTime: vi.fn(),
  generateRetrySchedule: vi.fn(),
}));

// ── Mock openapi spec (pre-existing syntax error with unescaped apostrophe) ───
vi.mock('../../src/openapi/spec.js', () => ({ openApiDocument: {} }));

import { app } from '../../src/app.js';
import { generateToken } from '../../src/lib/auth.js';
import { initializeConfig } from '../../src/config/env.js';
import { _resetAuditLog, getAuditEntries } from '../../src/lib/auditLog.js';

// ── Shared fixtures ───────────────────────────────────────────────────────────

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
const SUSPENSION_ACTIVE = {
  topic: 'stream.created',
  consecutiveFailures: 5,
  suspended: true,
  suspendedAt: '2026-01-03T00:00:00.000Z',
  resumedAt: null,
  updatedAt: '2026-01-03T00:00:00.000Z',
};
const SUSPENSION_HEALTHY = {
  topic: 'stream.created',
  consecutiveFailures: 2,
  suspended: false,
  suspendedAt: null,
  resumedAt: null,
  updatedAt: '2026-01-02T00:00:00.000Z',
};

let operatorToken: string;
let viewerToken: string;

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
  // Sensible defaults so tests only override what they care about
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

afterEach(() => {
  _resetAuditLog();
});

// ── Auth guards ───────────────────────────────────────────────────────────────

describe('auth guards', () => {
  it('GET /admin/dlq → 401 with no token', async () => {
    const res = await request(app).get('/admin/dlq');
    expect(res.status).toBe(401);
  });

  it('GET /admin/dlq → 403 with viewer role', async () => {
    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it('POST /admin/dlq/:id/replay → 401 with no token', async () => {
    const res = await request(app).post('/admin/dlq/dlq-001/replay');
    expect(res.status).toBe(401);
  });

  it('POST /admin/dlq/consumers/:topic/resume → 401 with no token', async () => {
    const res = await request(app).post('/admin/dlq/consumers/stream.created/resume');
    expect(res.status).toBe(401);
  });

  it('POST /admin/dlq/consumers/:topic/resume → 403 with viewer role', async () => {
    const res = await request(app)
      .post('/admin/dlq/consumers/stream.created/resume')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });
});

// ── GET /admin/dlq ────────────────────────────────────────────────────────────

describe('GET /admin/dlq', () => {
  it('returns entries + pagination shape', async () => {
    mockRepo.findAll.mockResolvedValue({ entries: [ENTRY], total: 1 });

    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0].id).toBe('dlq-001');
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.has_more).toBe(false);
  });

  it('surfaces suspendedTopics in the list response (#349)', async () => {
    mockRepo.listSuspendedConsumers.mockResolvedValue([SUSPENSION_ACTIVE]);

    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.suspendedTopics).toHaveLength(1);
    expect(res.body.data.suspendedTopics[0].topic).toBe('stream.created');
    expect(res.body.data.suspendedTopics[0].consecutiveFailures).toBe(5);
  });

  it('returns empty suspendedTopics when all consumers are healthy', async () => {
    mockRepo.listSuspendedConsumers.mockResolvedValue([SUSPENSION_HEALTHY]);

    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.suspendedTopics).toHaveLength(0);
  });

  it('rejects invalid limit with 400', async () => {
    const res = await request(app)
      .get('/admin/dlq?limit=999')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(400);
  });

  it('rejects negative offset with 400', async () => {
    const res = await request(app)
      .get('/admin/dlq?offset=-1')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(400);
  });
});

// ── GET /admin/dlq/:id ────────────────────────────────────────────────────────

describe('GET /admin/dlq/:id', () => {
  it('returns entry with consumerSuspended=false when healthy', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_HEALTHY);

    const res = await request(app)
      .get('/admin/dlq/dlq-001')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.entry.id).toBe('dlq-001');
    expect(res.body.data.consumerSuspended).toBe(false);
    expect(res.body.data.consecutiveFailures).toBe(2);
  });

  it('returns consumerSuspended=true when consumer is suspended (#349)', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_ACTIVE);

    const res = await request(app)
      .get('/admin/dlq/dlq-001')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.consumerSuspended).toBe(true);
    expect(res.body.data.consecutiveFailures).toBe(5);
  });

  it('returns 404 for unknown entry', async () => {
    const res = await request(app)
      .get('/admin/dlq/no-such-id')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ── POST /admin/dlq/:id/replay ────────────────────────────────────────────────

describe('POST /admin/dlq/:id/replay', () => {
  it('returns 404 when entry does not exist', async () => {
    const res = await request(app)
      .post('/admin/dlq/no-such-id/replay')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 409 CONSUMER_SUSPENDED when topic is suspended (#349)', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_ACTIVE);

    const res = await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONSUMER_SUSPENDED');
    expect(res.body.error.message).toContain('stream.created');
    // Replay must NOT proceed when suspended
    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it('resets attempt counter and records success on successful replay', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);

    const res = await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('dlq-001');
    expect(mockRepo.update).toHaveBeenCalledWith('dlq-001', expect.objectContaining({ attempts: 0 }));
    expect(mockRepo.recordReplaySuccess).toHaveBeenCalledWith('stream.created');
    expect(mockRepo.recordReplayFailure).not.toHaveBeenCalled();
  });

  it('records failure and emits audit when failed=true (#349)', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);
    mockRepo.recordReplayFailure.mockResolvedValue({
      ...SUSPENSION_HEALTHY,
      consecutiveFailures: 3,
    });

    const res = await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ failed: true });

    expect(res.status).toBe(200);
    expect(mockRepo.recordReplayFailure).toHaveBeenCalledWith('stream.created');
    expect(mockRepo.recordReplaySuccess).not.toHaveBeenCalled();
  });

  it('emits DLQ_CONSUMER_SUSPENDED audit event when threshold is reached (#349)', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);
    // Simulate threshold being reached on this failure
    mockRepo.recordReplayFailure.mockResolvedValue({
      ...SUSPENSION_ACTIVE,
      consecutiveFailures: 5,
    });

    await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ failed: true });

    const audit = getAuditEntries();
    const suspendEvent = audit.find((e) => e.action === 'DLQ_CONSUMER_SUSPENDED');
    expect(suspendEvent).toBeDefined();
    expect(suspendEvent?.resourceId).toBe('stream.created');
    expect(suspendEvent?.meta?.consecutiveFailures).toBe(5);
  });

  it('emits DLQ_REPLAYED audit event on success', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);

    await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`);

    const audit = getAuditEntries();
    const replayEvent = audit.find((e) => e.action === 'DLQ_REPLAYED');
    expect(replayEvent).toBeDefined();
    expect(replayEvent?.resourceId).toBe('dlq-001');
  });
});

// ── POST /admin/dlq/consumers/:topic/resume ───────────────────────────────────

describe('POST /admin/dlq/consumers/:topic/resume', () => {
  it('clears suspension and returns 200 (#349)', async () => {
    mockRepo.resumeConsumer.mockResolvedValue({
      topic: 'stream.created',
      consecutiveFailures: 0,
      suspended: false,
      suspendedAt: '2026-01-03T00:00:00.000Z',
      resumedAt: '2026-01-04T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/admin/dlq/consumers/stream.created/resume')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.topic).toBe('stream.created');
    expect(res.body.data.resumedAt).toBeDefined();
    expect(mockRepo.resumeConsumer).toHaveBeenCalledWith('stream.created');
  });

  it('emits DLQ_CONSUMER_RESUMED audit event (#349)', async () => {
    mockRepo.resumeConsumer.mockResolvedValue({
      topic: 'stream.created',
      consecutiveFailures: 0,
      suspended: false,
      suspendedAt: '2026-01-03T00:00:00.000Z',
      resumedAt: '2026-01-04T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
    });

    await request(app)
      .post('/admin/dlq/consumers/stream.created/resume')
      .set('Authorization', `Bearer ${operatorToken}`);

    const audit = getAuditEntries();
    const resumeEvent = audit.find((e) => e.action === 'DLQ_CONSUMER_RESUMED');
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent?.resourceId).toBe('stream.created');
  });

  it('returns 200 idempotently when consumer has no suspension record', async () => {
    mockRepo.resumeConsumer.mockResolvedValue(null);

    const res = await request(app)
      .post('/admin/dlq/consumers/unknown-topic/resume')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/no suspension record/);
  });

  it('viewer cannot resume suspended consumer (403)', async () => {
    const res = await request(app)
      .post('/admin/dlq/consumers/stream.created/resume')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });
});

// ── DELETE /admin/dlq/:id ─────────────────────────────────────────────────────

describe('DELETE /admin/dlq/:id', () => {
  it('acknowledges (removes) an entry', async () => {
    mockRepo.deleteById.mockResolvedValue(true);

    const res = await request(app)
      .delete('/admin/dlq/dlq-001')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('dlq-001');
  });

  it('returns 404 for unknown entry', async () => {
    const res = await request(app)
      .delete('/admin/dlq/no-such-id')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ── DELETE /admin/dlq (bulk purge) ────────────────────────────────────────────

describe('DELETE /admin/dlq', () => {
  it('purges all entries and returns count', async () => {
    mockRepo.deleteAll.mockResolvedValue(7);

    const res = await request(app)
      .delete('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.purged).toBe(7);
  });

  it('purges by topic filter when provided', async () => {
    mockRepo.deleteAll.mockResolvedValue(3);

    const res = await request(app)
      .delete('/admin/dlq?topic=stream.created')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(mockRepo.deleteAll).toHaveBeenCalledWith('stream.created');
  });
});
