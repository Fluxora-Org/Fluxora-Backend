import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { DlqConsumerReplayState, DlqEntry } from '../../src/routes/dlq.js';

const repoState = vi.hoisted(() => {
  const entries = new Map<string, DlqEntry>();
  const consumers = new Map<string, DlqConsumerReplayState>();
  const hash = (consumerUrl: string): string =>
    `test_${Buffer.from(consumerUrl).toString('hex').slice(0, 16)}`;

  return { entries, consumers, hash };
});

vi.mock('../../src/db/repositories/dlqRepository.js', () => ({
  dlqRepository: {
    async insert(entry: DlqEntry): Promise<void> {
      repoState.entries.set(entry.id, entry);
    },
    async findAll(opts: { limit: number; offset: number; topic?: string }): Promise<{ entries: DlqEntry[]; total: number }> {
      const entries = Array.from(repoState.entries.values())
        .filter((entry) => !opts.topic || entry.topic === opts.topic)
        .sort((a, b) => b.firstFailedAt.localeCompare(a.firstFailedAt));
      return {
        entries: entries.slice(opts.offset, opts.offset + opts.limit),
        total: entries.length,
      };
    },
    async findById(id: string): Promise<DlqEntry | undefined> {
      return repoState.entries.get(id);
    },
    async update(id: string, patch: Partial<Pick<DlqEntry, 'attempts' | 'lastFailedAt'>>): Promise<void> {
      const entry = repoState.entries.get(id);
      if (!entry) return;
      repoState.entries.set(id, { ...entry, ...patch });
    },
    async deleteById(id: string): Promise<boolean> {
      return repoState.entries.delete(id);
    },
    async deleteAll(topic?: string): Promise<number> {
      const ids = Array.from(repoState.entries.values())
        .filter((entry) => !topic || entry.topic === topic)
        .map((entry) => entry.id);
      ids.forEach((id) => repoState.entries.delete(id));
      return ids.length;
    },
    async deleteAllConsumerReplayStates(): Promise<number> {
      const count = repoState.consumers.size;
      repoState.consumers.clear();
      return count;
    },
    async findConsumerReplayState(consumerUrl: string): Promise<DlqConsumerReplayState | undefined> {
      return repoState.consumers.get(consumerUrl);
    },
    async findConsumerReplayStates(consumerUrls: string[]): Promise<Map<string, DlqConsumerReplayState>> {
      const states = new Map<string, DlqConsumerReplayState>();
      consumerUrls.forEach((consumerUrl) => {
        const state = repoState.consumers.get(consumerUrl);
        if (state) states.set(consumerUrl, state);
      });
      return states;
    },
    async recordConsumerReplayFailure(consumerUrl: string, threshold: number): Promise<DlqConsumerReplayState> {
      const previous = repoState.consumers.get(consumerUrl);
      const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
      const suspended = Boolean(previous?.suspended) || consecutiveFailures >= threshold;
      const state: DlqConsumerReplayState = {
        consumerUrl,
        consumerUrlHash: repoState.hash(consumerUrl),
        consecutiveFailures,
        suspended,
        ...(suspended ? { suspendedAt: previous?.suspendedAt ?? new Date().toISOString() } : {}),
        updatedAt: new Date().toISOString(),
      };
      repoState.consumers.set(consumerUrl, state);
      return state;
    },
    async reenableConsumer(consumerUrl: string): Promise<DlqConsumerReplayState | undefined> {
      const previous = repoState.consumers.get(consumerUrl);
      if (!previous) return undefined;
      const state: DlqConsumerReplayState = {
        consumerUrl,
        consumerUrlHash: previous.consumerUrlHash,
        consecutiveFailures: 0,
        suspended: false,
        updatedAt: new Date().toISOString(),
      };
      repoState.consumers.set(consumerUrl, state);
      return state;
    },
  },
}));

import { _resetDlq, dlqRouter, enqueueDeadLetter } from '../../src/routes/dlq.js';
import { generateToken } from '../../src/lib/auth.js';
import { getAuditEntries, _resetAuditLog } from '../../src/lib/auditLog.js';
import { initializeConfig } from '../../src/config/env.js';

let operatorToken: string;
let viewerToken: string;
const app = express();
app.use(express.json());
app.use('/admin/dlq', dlqRouter);

const deadConsumerUrl = 'https://dead.example/webhook';
const healthyConsumerUrl = 'https://healthy.example/webhook';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'a-very-long-secret-key-for-testing-only-12345';
  process.env.DLQ_REPLAY_SUSPEND_THRESHOLD = '2';
  initializeConfig();
  operatorToken = generateToken({ address: 'GOPERATOR', role: 'operator' });
  viewerToken = generateToken({ address: 'GVIEWER', role: 'viewer' });
});

describe('admin DLQ routes', () => {
  beforeEach(async () => {
    process.env.DLQ_REPLAY_SUSPEND_THRESHOLD = '2';
    await _resetDlq();
    _resetAuditLog();
  });

  afterEach(async () => {
    await _resetDlq();
    _resetAuditLog();
  });

  it('rejects unauthenticated GET to DLQ list with 401', async () => {
    const res = await request(app).get('/admin/dlq');
    expect(res.status).toBe(401);
  });

  it('rejects GET with viewer role to DLQ list with 403', async () => {
    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it('allows authenticated GET to DLQ list with 200 and valid shape', async () => {
    await enqueueDeadLetter({
      topic: 'stream.created',
      payload: { endpointUrl: deadConsumerUrl, id: 'test-stream' },
      error: 'timeout error',
      attempts: 1,
    });

    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0].topic).toBe('stream.created');
    expect(res.body.data.entries[0].consumerReplay).toMatchObject({
      consecutiveFailures: 1,
      suspended: false,
    });
  });

  it('surfaces suspended state in the DLQ list after the replay-failure threshold', async () => {
    await enqueueDeadLetter({
      topic: 'stream.created',
      payload: { endpointUrl: deadConsumerUrl, id: 'first-failure' },
      error: 'HTTP 503',
      attempts: 5,
    });
    await enqueueDeadLetter({
      topic: 'stream.created',
      payload: { endpointUrl: deadConsumerUrl, id: 'second-failure' },
      error: 'HTTP 503',
      attempts: 5,
    });

    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(res.body.data.entries).toHaveLength(2);
    expect(res.body.data.entries[0].consumerReplay).toMatchObject({
      consumerUrlHash: repoState.hash(deadConsumerUrl),
      consecutiveFailures: 2,
      suspended: true,
    });

    const suspensionAudit = getAuditEntries().find((entry) => entry.action === 'DLQ_CONSUMER_SUSPENDED');
    expect(suspensionAudit).toBeDefined();
    expect(suspensionAudit?.resourceId).toBe(repoState.hash(deadConsumerUrl));
    expect(suspensionAudit?.meta).toMatchObject({ consecutiveFailures: 2, threshold: 2 });
  });

  it('does not suspend unrelated consumers when one endpoint reaches the threshold', async () => {
    await enqueueDeadLetter({
      topic: 'stream.created',
      payload: { endpointUrl: deadConsumerUrl, id: 'dead-1' },
      error: 'HTTP 503',
      attempts: 5,
    });
    await enqueueDeadLetter({
      topic: 'stream.created',
      payload: { endpointUrl: deadConsumerUrl, id: 'dead-2' },
      error: 'HTTP 503',
      attempts: 5,
    });
    await enqueueDeadLetter({
      topic: 'stream.created',
      payload: { endpointUrl: healthyConsumerUrl, id: 'healthy-1' },
      error: 'timeout',
      attempts: 1,
    });

    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    const healthyEntry = res.body.data.entries.find(
      (entry: { payload: { id: string } }) => entry.payload.id === 'healthy-1',
    );
    expect(healthyEntry.consumerReplay).toMatchObject({
      consumerUrlHash: repoState.hash(healthyConsumerUrl),
      consecutiveFailures: 1,
      suspended: false,
    });
  });

  it('rejects replay for a suspended consumer until an operator re-enables it', async () => {
    const firstEntry = await enqueueDeadLetter({
      topic: 'stream.created',
      payload: { endpointUrl: deadConsumerUrl, id: 'dead-1' },
      error: 'HTTP 503',
      attempts: 5,
    });
    await enqueueDeadLetter({
      topic: 'stream.created',
      payload: { endpointUrl: deadConsumerUrl, id: 'dead-2' },
      error: 'HTTP 503',
      attempts: 5,
    });

    const blocked = await request(app)
      .post(`/admin/dlq/${firstEntry.id}/replay`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(409);

    expect(blocked.body.error.code).toBe('DLQ_CONSUMER_SUSPENDED');
    expect(blocked.body.error.details).toMatchObject({
      consumerUrlHash: repoState.hash(deadConsumerUrl),
      consecutiveFailures: 2,
      suspended: true,
    });

    const reenabled = await request(app)
      .post('/admin/dlq/consumers/reenable')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ consumerUrl: deadConsumerUrl })
      .expect(200);

    expect(reenabled.body.data.consumerReplay).toMatchObject({
      consumerUrlHash: repoState.hash(deadConsumerUrl),
      consecutiveFailures: 0,
      suspended: false,
    });

    const replayed = await request(app)
      .post(`/admin/dlq/${firstEntry.id}/replay`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);

    expect(replayed.body.data.message).toBe('DLQ entry replayed');
    expect(getAuditEntries().some((entry) => entry.action === 'DLQ_CONSUMER_REENABLED')).toBe(true);
    expect(getAuditEntries().some((entry) => entry.action === 'DLQ_REPLAYED')).toBe(true);
  });

  it('requires operator permissions to re-enable a suspended consumer', async () => {
    await enqueueDeadLetter({
      topic: 'stream.created',
      payload: { endpointUrl: deadConsumerUrl },
      error: 'HTTP 503',
      attempts: 5,
    });

    const res = await request(app)
      .post('/admin/dlq/consumers/reenable')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ consumerUrl: deadConsumerUrl });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows authenticated operator to delete DLQ entry with 200', async () => {
    const entry = await enqueueDeadLetter({
      topic: 'stream.created',
      payload: {},
      error: 'some error',
      attempts: 2,
    });

    const res = await request(app)
      .delete(`/admin/dlq/${entry.id}`)
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(entry.id);
  });

  it('returns 404 when deleting a non-existent DLQ entry', async () => {
    const res = await request(app)
      .delete('/admin/dlq/non-existent-id')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
