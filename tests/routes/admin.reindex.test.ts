/**
 * tests/routes/admin.reindex.test.ts
 *
 * POST / GET / DELETE /api/admin/reindex driving a mocked replay runner.
 *
 * The reindex job no longer simulates work: it hands the requested range to
 * the replay runner (`IndexerService.replayEvents` in production) and takes
 * its progress from the runner's batch results. These tests swap in a fake
 * runner whose batches, failure and cancellation are driven step by step.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import {
  _resetForTest,
  _setReindexRunnerForTest,
  getReindexState,
  type ReindexRunner,
  type ReindexTarget,
} from '../../src/state/adminState.js';
import { generateToken } from '../../src/lib/auth.js';

const ADMIN_KEY = 'test-admin-key-for-reindex-routes';

const TARGET: ReindexTarget = {
  contract_id: 'CCONTRACTREINDEXTEST',
  ledger: 7,
  from_block: 100,
  to_block: 200,
};

/**
 * `/api/admin` sits behind protectRouter's JWT `authenticate` step, which
 * runs before `requireAdminAuth`, so requests authenticate with an admin JWT.
 */
function authed(req: request.Test): request.Test {
  const token = generateToken({ address: 'addr-admin', role: 'admin' });
  return req.set('Authorization', `Bearer ${token}`);
}

type Outcome = { outcome: 'completed' | 'cancelled'; processedRows: number; totalRows: number };

/** A replay runner whose progress, completion and failure the test controls. */
class FakeRunner implements ReindexRunner {
  calls: ReindexTarget[] = [];
  cancelCalls = 0;
  private progress: ((u: { processedRows: number; totalRows: number }) => void) | null = null;
  private resolve: ((o: Outcome) => void) | null = null;
  private reject: ((e: Error) => void) | null = null;
  private processed = 0;
  private total = 0;

  run(target: ReindexTarget, onProgress: (u: { processedRows: number; totalRows: number }) => void) {
    this.calls.push(target);
    this.progress = onProgress;
    return new Promise<Outcome>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  /** The replay counted its source rows. */
  start(totalRows: number): void {
    this.total = totalRows;
    this.progress?.({ processedRows: 0, totalRows });
  }

  /** One batch of `rows` committed. */
  batch(rows: number): void {
    this.processed += rows;
    this.progress?.({ processedRows: this.processed, totalRows: this.total });
  }

  finish(): void {
    this.resolve?.({ outcome: 'completed', processedRows: this.processed, totalRows: this.total });
  }

  fail(message: string): void {
    this.reject?.(new Error(message));
  }

  /** Like the real replay: a stop request ends the run at the next batch boundary. */
  cancel(): void {
    this.cancelCalls++;
    this.resolve?.({ outcome: 'cancelled', processedRows: this.processed, totalRows: this.total });
  }
}

/** Let the job's promise callbacks run. */
const flush = () => new Promise((r) => setImmediate(r));

let runner: FakeRunner;
let originalKey: string | undefined;

beforeEach(() => {
  originalKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  _resetForTest();
  runner = new FakeRunner();
  _setReindexRunnerForTest(runner);
});

afterEach(() => {
  _setReindexRunnerForTest(null);
  _resetForTest();
  if (originalKey !== undefined) process.env.ADMIN_API_KEY = originalKey;
  else delete process.env.ADMIN_API_KEY;
});

describe('admin reindex routes — auth', () => {
  it('rejects unauthenticated POST to reindex with 401', async () => {
    const res = await request(app).post('/api/admin/reindex').send(TARGET);
    expect(res.status).toBe(401);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects a non-admin JWT with 403', async () => {
    const token = generateToken({ address: 'addr-operator', role: 'operator' });
    const res = await request(app)
      .post('/api/admin/reindex')
      .set('Authorization', `Bearer ${token}`)
      .send(TARGET);
    expect(res.status).toBe(403);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('POST /api/admin/reindex — validation', () => {
  it('rejects a request with no replay range instead of reporting success', async () => {
    const res = await authed(request(app).post('/api/admin/reindex'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(runner.calls).toHaveLength(0);
    expect(getReindexState().status).toBe('idle');
  });

  it.each([
    [{ ledger: 7 }, 'missing contract_id'],
    [{ contract_id: 'C1' }, 'missing ledger'],
    [{ contract_id: 'C1', ledger: -1 }, 'negative ledger'],
    [{ contract_id: 'C1', ledger: 1, from_block: 10, to_block: 5 }, 'from_block > to_block'],
    [{ contract_id: 'C1', ledger: 1, stream: 'x' }, 'unknown field'],
  ])('rejects %j (%s) with 400', async (body) => {
    const res = await authed(request(app).post('/api/admin/reindex')).send(body);
    expect(res.status).toBe(400);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('POST /api/admin/reindex — replay', () => {
  it('starts the replay for the requested range and answers 202 running', async () => {
    const res = await authed(request(app).post('/api/admin/reindex')).send(TARGET);

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toBe('Reindex started.');
    expect(res.body.data.reindex).toMatchObject({
      status: 'running',
      processedItems: 0,
      totalItems: null,
      target: TARGET,
    });
    expect(runner.calls).toEqual([TARGET]);
  });

  it('takes processedItems / totalItems from batch results and completes only when the replay does', async () => {
    await authed(request(app).post('/api/admin/reindex')).send(TARGET);

    runner.start(250);
    runner.batch(100);
    let res = await authed(request(app).get('/api/admin/reindex'));
    expect(res.body.data).toMatchObject({ status: 'running', processedItems: 100, totalItems: 250 });

    runner.batch(100);
    runner.batch(50);
    res = await authed(request(app).get('/api/admin/reindex'));
    // All batches committed but the replay has not returned yet: still running.
    expect(res.body.data).toMatchObject({ status: 'running', processedItems: 250, totalItems: 250 });

    runner.finish();
    await flush();
    res = await authed(request(app).get('/api/admin/reindex'));
    expect(res.body.data).toMatchObject({
      status: 'completed',
      processedItems: 250,
      totalItems: 250,
      error: null,
    });
    expect(res.body.data.completedAt).toBeTruthy();
  });

  it('reports failed with the replay error and keeps the progress reached', async () => {
    await authed(request(app).post('/api/admin/reindex')).send(TARGET);
    runner.start(300);
    runner.batch(100);

    runner.fail('Replay budget of 1000ms exceeded');
    await flush();

    const res = await authed(request(app).get('/api/admin/reindex'));
    expect(res.body.data).toMatchObject({
      status: 'failed',
      error: 'Replay budget of 1000ms exceeded',
      processedItems: 100,
      totalItems: 300,
    });
    expect(res.body.data.completedAt).toBeTruthy();
  });

  it('returns 409 while a reindex is running and does not start a second replay', async () => {
    await authed(request(app).post('/api/admin/reindex')).send(TARGET);
    const res = await authed(request(app).post('/api/admin/reindex')).send({ ...TARGET, ledger: 8 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(runner.calls).toHaveLength(1);
  });

  it('allows a new reindex once the previous one has finished', async () => {
    await authed(request(app).post('/api/admin/reindex')).send(TARGET);
    runner.start(0);
    runner.finish();
    await flush();

    const next = new FakeRunner();
    _setReindexRunnerForTest(next);
    const res = await authed(request(app).post('/api/admin/reindex')).send({ ...TARGET, ledger: 8 });
    expect(res.status).toBe(202);
    expect(next.calls).toEqual([{ ...TARGET, ledger: 8 }]);
  });

  it('still allows a reindex while pause flags are active', async () => {
    await authed(request(app).put('/api/admin/pause')).send({ streamCreation: true, ingestion: true });

    const res = await authed(request(app).post('/api/admin/reindex')).send(TARGET);
    expect(res.status).toBe(202);
    expect(res.body.data.reindex.status).toBe('running');
  });
});

describe('DELETE /api/admin/reindex — cancellation', () => {
  it('stops the replay and reports cancelled with the progress committed so far', async () => {
    await authed(request(app).post('/api/admin/reindex')).send(TARGET);
    runner.start(500);
    runner.batch(200);

    const res = await authed(request(app).delete('/api/admin/reindex'));
    expect(res.status).toBe(202);
    expect(res.body.data.message).toBe('Reindex cancellation requested.');
    expect(runner.cancelCalls).toBe(1);

    await flush();
    const state = await authed(request(app).get('/api/admin/reindex'));
    expect(state.body.data).toMatchObject({
      status: 'cancelled',
      processedItems: 200,
      totalItems: 500,
      error: null,
    });
    expect(state.body.data.completedAt).toBeTruthy();
  });

  it('returns 409 when no reindex is running', async () => {
    const res = await authed(request(app).delete('/api/admin/reindex'));
    expect(res.status).toBe(409);
    expect(runner.cancelCalls).toBe(0);
  });

  it('a cancelled job can be followed by a fresh reindex', async () => {
    await authed(request(app).post('/api/admin/reindex')).send(TARGET);
    await authed(request(app).delete('/api/admin/reindex'));
    await flush();

    _setReindexRunnerForTest(new FakeRunner());
    const res = await authed(request(app).post('/api/admin/reindex')).send(TARGET);
    expect(res.status).toBe(202);
    expect(res.body.data.reindex).toMatchObject({ status: 'running', processedItems: 0 });
  });
});
