/**
 * Tests for DLQ admin routes — #43 (inspection) + #349 (consumer suspension).
 *
 * Coverage:
 *  - Auth guards: 401 (no token) and 403 (viewer) for every endpoint
 *  - GET /admin/dlq: list shape, suspendedTopics, pagination boundary values,
 *    malformed/out-of-range parameters
 *  - GET /admin/dlq/:id: entry + consumerSuspended field, 404
 *  - POST /admin/dlq/:id/replay: success, 404, 409 CONSUMER_SUSPENDED (loop guard),
 *    409 ENTRY_ALREADY_REPLAYED, failed=true path, audit events
 *  - POST /admin/dlq/:id/replay with failed=true: increments failures, suspends at threshold
 *  - Failure history: the first cause is retained, later attempt failures are
 *    appended, and the full history is served by GET /admin/dlq/:id
 *  - POST /admin/dlq/consumers/:topic/resume: clears suspension, idempotent, audit
 *  - DELETE /admin/dlq/:id: 200, 404
 *  - DELETE /admin/dlq: bulk purge, topic filter
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// ── Mock dlqRepository before importing app ───────────────────────────────────
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
  replayEntry:             vi.fn(),
  recordFailure:           vi.fn(),
}));

vi.mock('../../src/db/repositories/dlqRepository.js', () => ({
  dlqRepository: mockRepo,
  getSuspensionThreshold: () => 5,
}));

vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(),
  query:   vi.fn(),
  QueryTimeoutError: class QueryTimeoutError extends Error {},
}));

vi.mock('../../src/webhooks/retry.js', () => ({
  attemptWebhookDeliveryWithRateLimit: vi.fn(),
  scheduleWebhookOutboxRetry: vi.fn(),
  calculateNextRetryTime: vi.fn(),
  generateRetrySchedule: vi.fn(),
}));

vi.mock('../../src/openapi/spec.js', () => ({ openApiDocument: {} }));

import { app } from '../../src/app.js';
import type { DlqFailureAttempt } from '../../src/routes/dlq.js';
import { generateToken } from '../../src/lib/auth.js';
import { initializeConfig } from '../../src/config/env.js';
import { _resetAuditLog, getAuditEntries } from '../../src/lib/auditLog.js';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const FIRST_FAILURE = {
  error: 'connection timeout',
  attempt: 1,
  failedAt: '2026-01-01T00:00:00.000Z',
  source: 'enqueue',
};

const ENTRY = {
  id: 'dlq-001',
  topic: 'stream.created',
  payload: { streamId: 'abc' },
  error: 'connection timeout',
  attempts: 3,
  firstFailedAt: '2026-01-01T00:00:00.000Z',
  lastFailedAt:  '2026-01-02T00:00:00.000Z',
  correlationId: 'corr-1',
  status: 'dead' as const,
  failureHistory: [FIRST_FAILURE],
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
  mockRepo.replayEntry.mockResolvedValue(true);
  mockRepo.recordFailure.mockImplementation(
    async (_id: string, failure: DlqFailureAttempt) => ({
      ...ENTRY,
      attempts: (ENTRY.failureHistory?.length ?? 0) + 1,
      failureHistory: [...(ENTRY.failureHistory ?? []), failure],
    }),
  );
});

afterEach(() => {
  _resetAuditLog();
});

// ── Auth guards — every endpoint ──────────────────────────────────────────────

describe('auth guards', () => {
  it('GET /admin/dlq → 401 with no token', async () => {
    const res = await request(app).get('/admin/dlq');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /admin/dlq → 403 with viewer role', async () => {
    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('GET /admin/dlq/:id → 401 with no token', async () => {
    const res = await request(app).get('/admin/dlq/dlq-001');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /admin/dlq/:id → 403 with viewer role', async () => {
    const res = await request(app)
      .get('/admin/dlq/dlq-001')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('POST /admin/dlq/:id/replay → 401 with no token', async () => {
    const res = await request(app).post('/admin/dlq/dlq-001/replay');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('POST /admin/dlq/:id/replay → 403 with viewer role', async () => {
    const res = await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('DELETE /admin/dlq/:id → 401 with no token', async () => {
    const res = await request(app).delete('/admin/dlq/dlq-001');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('DELETE /admin/dlq/:id → 403 with viewer role', async () => {
    const res = await request(app)
      .delete('/admin/dlq/dlq-001')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('DELETE /admin/dlq → 401 with no token', async () => {
    const res = await request(app).delete('/admin/dlq');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('DELETE /admin/dlq → 403 with viewer role', async () => {
    const res = await request(app)
      .delete('/admin/dlq')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('POST /admin/dlq/consumers/:topic/resume → 401 with no token', async () => {
    const res = await request(app).post('/admin/dlq/consumers/stream.created/resume');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('POST /admin/dlq/consumers/:topic/resume → 403 with viewer role', async () => {
    const res = await request(app)
      .post('/admin/dlq/consumers/stream.created/resume')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
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

  // boundary values
  it('accepts limit=1 (min boundary)', async () => {
    const res = await request(app)
      .get('/admin/dlq?limit=1')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(1);
  });

  it('accepts limit=100 (max boundary)', async () => {
    const res = await request(app)
      .get('/admin/dlq?limit=100')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(100);
  });

  it('accepts offset=0 (explicit zero)', async () => {
    const res = await request(app)
      .get('/admin/dlq?offset=0')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.offset).toBe(0);
  });

  // malformed / out-of-range
  it('rejects limit=0 with 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .get('/admin/dlq?limit=0')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects limit=101 (above max) with 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .get('/admin/dlq?limit=101')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects non-numeric limit with 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .get('/admin/dlq?limit=abc')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects negative offset with 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .get('/admin/dlq?offset=-1')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
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

  it('returns 404 NOT_FOUND for unknown entry', async () => {
    const res = await request(app)
      .get('/admin/dlq/no-such-id')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ── POST /admin/dlq/:id/replay ────────────────────────────────────────────────

describe('POST /admin/dlq/:id/replay', () => {
  it('returns 404 NOT_FOUND when entry does not exist', async () => {
    const res = await request(app)
      .post('/admin/dlq/no-such-id/replay')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 409 CONSUMER_SUSPENDED when topic is suspended and does not proceed (#349 loop guard)', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_ACTIVE);

    const res = await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CONSUMER_SUSPENDED');
    expect(res.body.error.message).toContain('stream.created');
    // replayEntry must NOT be called — the suspension gate prevents a replay loop
    expect(mockRepo.replayEntry).not.toHaveBeenCalled();
  });

  it('resets attempt counter and records success on successful replay', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);
    mockRepo.replayEntry.mockResolvedValue(true);

    const res = await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('dlq-001');
    expect(mockRepo.replayEntry).toHaveBeenCalledWith('dlq-001', expect.objectContaining({ attempts: 0 }));
    expect(mockRepo.recordReplaySuccess).toHaveBeenCalledWith('stream.created');
    expect(mockRepo.recordReplayFailure).not.toHaveBeenCalled();
  });

  it('returns 409 ENTRY_ALREADY_REPLAYED when optimistic lock fails', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);
    mockRepo.replayEntry.mockResolvedValue(false);

    const res = await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('ENTRY_ALREADY_REPLAYED');
  });

  it('records failure when failed=true is sent in body', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);
    mockRepo.replayEntry.mockResolvedValue(true);
    mockRepo.recordReplayFailure.mockResolvedValue({ ...SUSPENSION_HEALTHY, consecutiveFailures: 3 });

    const res = await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ failed: true });

    expect(res.status).toBe(200);
    expect(mockRepo.recordReplayFailure).toHaveBeenCalledWith('stream.created');
    expect(mockRepo.recordReplaySuccess).not.toHaveBeenCalled();
  });

  it('treats failed=0 (non-boolean truthy) as false — records success not failure', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);
    mockRepo.replayEntry.mockResolvedValue(true);

    const res = await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ failed: 0 });

    expect(res.status).toBe(200);
    expect(mockRepo.recordReplaySuccess).toHaveBeenCalledWith('stream.created');
    expect(mockRepo.recordReplayFailure).not.toHaveBeenCalled();
  });

  it('emits DLQ_CONSUMER_SUSPENDED audit event when failure threshold is reached (#349)', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);
    mockRepo.replayEntry.mockResolvedValue(true);
    mockRepo.recordReplayFailure.mockResolvedValue({ ...SUSPENSION_ACTIVE, consecutiveFailures: 5 });

    await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ failed: true });

    const audit = getAuditEntries();
    const ev = audit.find((e) => e.action === 'DLQ_CONSUMER_SUSPENDED');
    expect(ev).toBeDefined();
    expect(ev?.resourceId).toBe('stream.created');
    expect(ev?.meta?.consecutiveFailures).toBe(5);
  });

  it('emits DLQ_REPLAYED audit event on success', async () => {
    mockRepo.findById.mockResolvedValue(ENTRY);
    mockRepo.getConsumerSuspension.mockResolvedValue(SUSPENSION_NONE);
    mockRepo.replayEntry.mockResolvedValue(true);

    await request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`);

    const audit = getAuditEntries();
    const ev = audit.find((e) => e.action === 'DLQ_REPLAYED');
    expect(ev).toBeDefined();
    expect(ev?.resourceId).toBe('dlq-001');
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
    const ev = audit.find((e) => e.action === 'DLQ_CONSUMER_RESUMED');
    expect(ev).toBeDefined();
    expect(ev?.resourceId).toBe('stream.created');
  });

  it('returns 200 idempotently when consumer has no suspension record', async () => {
    mockRepo.resumeConsumer.mockResolvedValue(null);

    const res = await request(app)
      .post('/admin/dlq/consumers/unknown-topic/resume')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/no suspension record/);
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

  it('returns 404 NOT_FOUND for unknown entry', async () => {
    const res = await request(app)
      .delete('/admin/dlq/no-such-id')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
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

  it('ignores whitespace-only topic filter (treats as no filter)', async () => {
    mockRepo.deleteAll.mockResolvedValue(5);

    const res = await request(app)
      .delete('/admin/dlq?topic=   ')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    // whitespace-only topic is trimmed to empty → no topic argument passed
    expect(mockRepo.deleteAll).toHaveBeenCalledWith(undefined);
  });
});

// ── Failure history ───────────────────────────────────────────────────────────

/**
 * A dead-lettered item is only actionable if it records why it failed, so the
 * causes of every attempt must survive — including the first one.
 *
 * These tests drive the real route against a stateful stand-in for the
 * repository that mirrors the append-only SQL contract: `recordFailure()`
 * appends to `failureHistory`, increments `attempts`, and never touches
 * `error`.
 */
describe('DLQ failure history', () => {
  /** Install the stateful repository stand-in and return the mutable entry. */
  function useStatefulRepo() {
    const state = {
      ...ENTRY,
      attempts: 1,
      failureHistory: [FIRST_FAILURE],
    };

    mockRepo.findById.mockImplementation(async (id: string) => (id === state.id ? { ...state } : undefined));
    mockRepo.findAll.mockImplementation(async () => ({ entries: [{ ...state }], total: 1 }));
    mockRepo.replayEntry.mockResolvedValue(true);
    mockRepo.recordReplayFailure.mockResolvedValue({ ...SUSPENSION_HEALTHY, consecutiveFailures: 1 });
    mockRepo.recordFailure.mockImplementation(async (_id: string, failure: DlqFailureAttempt) => {
      state.attempts = Math.max(0, state.attempts) + 1;
      state.failureHistory = [...state.failureHistory, { ...failure, attempt: state.attempts }];
      return { ...state };
    });

    return state;
  }

  const replay = (body: Record<string, unknown>) =>
    request(app)
      .post('/admin/dlq/dlq-001/replay')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send(body);

  const read = () =>
    request(app)
      .get('/admin/dlq/dlq-001')
      .set('Authorization', `Bearer ${operatorToken}`);

  it('retains every cause when an item is failed repeatedly with different errors', async () => {
    useStatefulRepo();

    const laterCauses = ['TLS handshake timeout', 'upstream returned 503', 'signature mismatch'];
    for (const cause of laterCauses) {
      await replay({ failed: true, error: cause }).expect(200);
    }

    const res = await read().expect(200);
    const history = res.body.data.entry.failureHistory as Array<{ error: string; attempt: number; failedAt: string }>;

    // Every cause is retained, oldest first — the first one included.
    expect(history.map((f) => f.error)).toEqual(['connection timeout', ...laterCauses]);
    // The first cause is still the entry's own error: it was never replaced.
    expect(res.body.data.entry.error).toBe('connection timeout');
    expect(res.body.data.firstFailure).toBe('connection timeout');
    expect(res.body.data.latestFailure).toBe('signature mismatch');
    expect(res.body.data.failureCount).toBe(4);
    // Attempt count and a timestamp per attempt are recorded.
    expect(history.map((f) => f.attempt)).toEqual([1, 2, 3, 4]);
    for (const failure of history) {
      expect(failure.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('appends a placeholder cause when a failed replay reports no reason', async () => {
    useStatefulRepo();

    const res = await replay({ failed: true }).expect(200);

    expect(res.body.data.failureHistory).toHaveLength(2);
    expect(res.body.data.failureHistory[1].error).toMatch(/reason not reported/);
    expect(res.body.data.failureHistory[1].source).toBe('replay');
  });

  it('records only the reported cause, not the whole request body', async () => {
    useStatefulRepo();

    await replay({ failed: true, error: '  connection reset by peer  ' }).expect(200);

    expect(mockRepo.recordFailure).toHaveBeenCalledWith(
      'dlq-001',
      expect.objectContaining({ error: 'connection reset by peer', source: 'replay' }),
    );
  });

  it('rejects a non-string reported cause without changing any state', async () => {
    useStatefulRepo();

    const res = await replay({ failed: true, error: { nested: 'object' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockRepo.replayEntry).not.toHaveBeenCalled();
    expect(mockRepo.recordFailure).not.toHaveBeenCalled();
  });

  it('bounds the length of a reported cause', async () => {
    useStatefulRepo();

    await replay({ failed: true, error: 'x'.repeat(5_000) }).expect(200);

    const recorded = mockRepo.recordFailure.mock.calls[0]![1] as DlqFailureAttempt;
    expect(recorded.error).toHaveLength(2_000);
  });

  it('does not record a cause for a successful replay', async () => {
    useStatefulRepo();

    await replay({}).expect(200);

    expect(mockRepo.recordFailure).not.toHaveBeenCalled();
    expect(mockRepo.recordReplaySuccess).toHaveBeenCalledWith('stream.created');
  });

  it('exposes the history on the list endpoint too', async () => {
    useStatefulRepo();

    await replay({ failed: true, error: 'deadline exceeded' }).expect(200);
    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    const history = res.body.data.entries[0].failureHistory as Array<{ error: string }>;
    expect(history.map((f) => f.error)).toEqual(['connection timeout', 'deadline exceeded']);
  });

  it('still reports the first cause for an entry stored without a history', async () => {
    mockRepo.findById.mockResolvedValue({ ...ENTRY, failureHistory: undefined });

    const res = await read().expect(200);

    expect(res.body.data.failureHistory).toEqual([]);
    expect(res.body.data.firstFailure).toBe('connection timeout');
  });
});