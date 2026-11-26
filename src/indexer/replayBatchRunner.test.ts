import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { ReplayRequest } from '../types/index.js';
import { NoOpLeaderElection } from './leaderElection.js';
import { ReplayForcedStopError } from './replayErrors.js';
import { ReplayBatchRunner } from './replayBatchRunner.js';
import {
  ReplayCursorRepository,
  ReplayProgressCheckpointRepository,
} from './replayCursorRepository.js';
import {
  _resetStopReplay,
  isReplayStopRequested,
  replayLock,
  replayState,
  requestStopReplay,
} from './replayRuntimeState.js';
import { IndexerService } from './service.js';

interface RecordedQuery {
  sql: string;
  values?: unknown[];
}

interface FakeQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

type QueryHandler = (query: RecordedQuery) => FakeQueryResult | Promise<FakeQueryResult>;

const CURSOR_ID = 'cursor-1';
const REPLAY_REQUEST: ReplayRequest = {
  contract_id: 'contract-1',
  ledger: 42,
  from_block: 100,
  to_block: 200,
};
const FORCED_TIMEOUT_MS = 1_000;

function emptyResult(): FakeQueryResult {
  return { rows: [], rowCount: 0 };
}

function resultWithRows(...rows: Record<string, unknown>[]): FakeQueryResult {
  return { rows, rowCount: rows.length };
}

function createFakeClient(handler: QueryHandler = () => emptyResult()) {
  const calls: RecordedQuery[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const call = { sql, values };
    calls.push(call);
    return handler(call);
  });
  const release = vi.fn();

  return {
    client: { query, release } as unknown as pg.PoolClient,
    query,
    release,
    calls,
  };
}

function createPool(...clients: pg.PoolClient[]) {
  const pendingClients = [...clients];
  const connect = vi.fn(async () => {
    const client = pendingClients.shift();
    if (!client) throw new Error('fake pool has no more clients');
    return client;
  });

  return { pool: { connect } as unknown as pg.Pool, connect };
}

function createRunner(
  client: pg.PoolClient,
  batchSize = 250,
  forcedTimeoutMs = FORCED_TIMEOUT_MS,
) {
  const { pool, connect } = createPool(client);
  const runner = new ReplayBatchRunner(
    pool,
    new ReplayCursorRepository(),
    new ReplayProgressCheckpointRepository(),
    batchSize,
    forcedTimeoutMs,
  );
  return { runner, connect };
}

function eventRow(eventId: string, blockHeight = 1): Record<string, unknown> {
  return {
    event_id: eventId,
    contract_id: REPLAY_REQUEST.contract_id,
    ledger: REPLAY_REQUEST.ledger,
    event_type: 'stream.created',
    event_data: { eventId, nested: { enabled: true } },
    block_height: blockHeight,
    transaction_hash: `tx-${eventId}`,
  };
}

function cursorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CURSOR_ID,
    contract_id: REPLAY_REQUEST.contract_id,
    ledger: REPLAY_REQUEST.ledger,
    from_block: null,
    to_block: null,
    total_rows: 10,
    last_committed_offset: 0,
    started_at: new Date('2026-01-01T00:00:00.000Z'),
    completed_at: null,
    ...overrides,
  };
}

function findCall(calls: RecordedQuery[], fragment: string): RecordedQuery {
  const call = calls.find((entry) => entry.sql.includes(fragment));
  expect(call, `missing query containing ${fragment}`).toBeDefined();
  return call!;
}

function classifyBatchQuery(sql: string): string {
  const statement = sql.trim();
  if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
    return statement;
  }
  if (sql.includes('FROM historical_events')) return 'FETCH';
  if (sql.includes('INSERT INTO contract_events')) return 'INSERT';
  if (sql.includes('UPDATE replay_cursors')) return 'CURSOR';
  if (sql.includes('UPDATE indexer_replay_progress')) return 'CHECKPOINT';
  throw new Error(`unexpected batch query: ${sql.slice(0, 80)}`);
}

beforeEach(() => {
  _resetStopReplay();
  replayLock.release();
  replayState.endReplay();
});

afterEach(() => {
  vi.useRealTimers();
  _resetStopReplay();
  replayLock.release();
  replayState.endReplay();
});

describe('ReplayBatchRunner', () => {
  it('inserts every row with sequential placeholders and commits cursor progress atomically', async () => {
    const rows = [eventRow('event-1', 100), eventRow('event-2', 101)];
    const fake = createFakeClient(({ sql }) =>
      sql.includes('FROM historical_events') ? resultWithRows(...rows) : emptyResult(),
    );
    const { runner, connect } = createRunner(fake.client);

    await expect(
      runner.processBatch(CURSOR_ID, REPLAY_REQUEST, 7, 0),
    ).resolves.toEqual({ rowsFetched: 2, aborted: false });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(fake.calls.map(({ sql }) => classifyBatchQuery(sql))).toEqual([
      'BEGIN',
      'FETCH',
      'INSERT',
      'CURSOR',
      'CHECKPOINT',
      'COMMIT',
    ]);

    const fetch = findCall(fake.calls, 'FROM historical_events');
    expect(fetch.values).toEqual([
      REPLAY_REQUEST.contract_id,
      REPLAY_REQUEST.ledger,
      REPLAY_REQUEST.from_block,
      REPLAY_REQUEST.to_block,
      250,
      7,
    ]);
    expect(fetch.sql).toContain('ORDER BY block_height ASC, event_id ASC');
    expect(fetch.sql).toContain('LIMIT $5 OFFSET $6');

    const insert = findCall(fake.calls, 'INSERT INTO contract_events');
    const placeholders = insert.sql.match(/\$\d+/g) ?? [];
    expect(placeholders).toEqual(
      Array.from({ length: 14 }, (_, index) => `$${index + 1}`),
    );
    expect(insert.sql.match(/\(\$\d+(?:, \$\d+){6}\)/g)).toEqual([
      '($1, $2, $3, $4, $5, $6, $7)',
      '($8, $9, $10, $11, $12, $13, $14)',
    ]);
    expect(insert.values).toEqual([
      'event-1',
      REPLAY_REQUEST.contract_id,
      REPLAY_REQUEST.ledger,
      'stream.created',
      JSON.stringify(rows[0]!.event_data),
      100,
      'tx-event-1',
      'event-2',
      REPLAY_REQUEST.contract_id,
      REPLAY_REQUEST.ledger,
      'stream.created',
      JSON.stringify(rows[1]!.event_data),
      101,
      'tx-event-2',
    ]);
    expect(insert.values).toHaveLength(placeholders.length);
    expect(insert.sql).toContain('ON CONFLICT (event_id) DO NOTHING');
    expect(insert.sql).not.toContain('event-1');

    const cursorUpdate = findCall(fake.calls, 'UPDATE replay_cursors');
    expect(cursorUpdate.sql).toContain('GREATEST(last_committed_offset, $1)');
    expect(cursorUpdate.values).toEqual([9, CURSOR_ID]);

    const checkpointUpdate = findCall(fake.calls, 'UPDATE indexer_replay_progress');
    expect(checkpointUpdate.values).toEqual([CURSOR_ID]);
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it('uses a fresh client and exactly one transaction for each batch', async () => {
    const first = createFakeClient(({ sql }) =>
      sql.includes('FROM historical_events')
        ? resultWithRows(eventRow('event-1'))
        : emptyResult(),
    );
    const second = createFakeClient(({ sql }) =>
      sql.includes('FROM historical_events')
        ? resultWithRows(eventRow('event-2'))
        : emptyResult(),
    );
    const { pool, connect } = createPool(first.client, second.client);
    const runner = new ReplayBatchRunner(
      pool,
      new ReplayCursorRepository(),
      new ReplayProgressCheckpointRepository(),
      1,
      FORCED_TIMEOUT_MS,
    );

    await expect(
      runner.processBatch(CURSOR_ID, REPLAY_REQUEST, 0, 0),
    ).resolves.toEqual({ rowsFetched: 1, aborted: false });
    await expect(
      runner.processBatch(CURSOR_ID, REPLAY_REQUEST, 1, 1),
    ).resolves.toEqual({ rowsFetched: 1, aborted: false });

    expect(connect).toHaveBeenCalledTimes(2);
    for (const fake of [first, second]) {
      const kinds = fake.calls.map(({ sql }) => classifyBatchQuery(sql));
      expect(kinds.filter((kind) => kind === 'BEGIN')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'COMMIT')).toHaveLength(1);
      expect(kinds).not.toContain('ROLLBACK');
      expect(fake.release).toHaveBeenCalledTimes(1);
    }
    expect(findCall(first.calls, 'FROM historical_events').values?.slice(-2)).toEqual([1, 0]);
    expect(findCall(second.calls, 'FROM historical_events').values?.slice(-2)).toEqual([1, 1]);
    expect(findCall(first.calls, 'UPDATE replay_cursors').values).toEqual([1, CURSOR_ID]);
    expect(findCall(second.calls, 'UPDATE replay_cursors').values).toEqual([2, CURSOR_ID]);
  });

  it('rolls back an exhausted batch without inserting or advancing progress', async () => {
    const fake = createFakeClient();
    const { runner } = createRunner(fake.client);

    await expect(
      runner.processBatch(CURSOR_ID, REPLAY_REQUEST, 0, 0),
    ).resolves.toEqual({ rowsFetched: 0, aborted: false });

    expect(fake.calls.map(({ sql }) => classifyBatchQuery(sql))).toEqual([
      'BEGIN',
      'FETCH',
      'ROLLBACK',
    ]);
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['begin', 'BEGIN'],
    ['fetch', 'FROM historical_events'],
    ['insert', 'INSERT INTO contract_events'],
    ['cursor advance', 'UPDATE replay_cursors'],
    ['checkpoint update', 'UPDATE indexer_replay_progress'],
    ['commit', 'COMMIT'],
  ])('rolls back and releases the client when %s fails', async (_stage, fragment) => {
    const failure = new Error(`${_stage} failed`);
    const fake = createFakeClient(({ sql }) => {
      if (sql.includes(fragment)) throw failure;
      if (sql.includes('FROM historical_events')) {
        return resultWithRows(eventRow('event-1'));
      }
      return emptyResult();
    });
    const { runner } = createRunner(fake.client);

    await expect(
      runner.processBatch(CURSOR_ID, REPLAY_REQUEST, 0, 0),
    ).rejects.toBe(failure);

    expect(fake.calls.filter(({ sql }) => sql.trim() === 'ROLLBACK')).toHaveLength(1);
    expect(fake.calls.some(({ sql }) => sql.trim() === 'COMMIT')).toBe(
      fragment === 'COMMIT',
    );
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it('preserves the batch error and releases the client if rollback also fails', async () => {
    const batchFailure = new Error('insert failed');
    const fake = createFakeClient(({ sql }) => {
      if (sql.trim() === 'ROLLBACK') throw new Error('rollback failed');
      if (sql.includes('INSERT INTO contract_events')) throw batchFailure;
      if (sql.includes('FROM historical_events')) {
        return resultWithRows(eventRow('event-1'));
      }
      return emptyResult();
    });
    const { runner } = createRunner(fake.client);

    await expect(
      runner.processBatch(CURSOR_ID, REPLAY_REQUEST, 0, 0),
    ).rejects.toBe(batchFailure);
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it('aborts before fetching when a stop was already requested', async () => {
    requestStopReplay();
    const fake = createFakeClient();
    const { runner } = createRunner(fake.client);

    await expect(
      runner.processBatch(CURSOR_ID, REPLAY_REQUEST, 0, 0),
    ).resolves.toEqual({ rowsFetched: 0, aborted: true });

    expect(fake.calls.map(({ sql }) => classifyBatchQuery(sql))).toEqual([
      'BEGIN',
      'ROLLBACK',
    ]);
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it('discards fetched rows when a stop is requested during the fetch', async () => {
    const fake = createFakeClient(({ sql }) => {
      if (sql.includes('FROM historical_events')) {
        requestStopReplay();
        return resultWithRows(eventRow('event-1'));
      }
      return emptyResult();
    });
    const { runner } = createRunner(fake.client);

    await expect(
      runner.processBatch(CURSOR_ID, REPLAY_REQUEST, 0, 0),
    ).resolves.toEqual({ rowsFetched: 0, aborted: true });

    expect(fake.calls.map(({ sql }) => classifyBatchQuery(sql))).toEqual([
      'BEGIN',
      'FETCH',
      'ROLLBACK',
    ]);
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it('force-unwinds a hung fetch after a stop and still rolls back and releases', async () => {
    vi.useFakeTimers();
    const fake = createFakeClient(({ sql }) => {
      if (sql.includes('FROM historical_events')) {
        requestStopReplay();
        return new Promise<FakeQueryResult>(() => undefined);
      }
      return emptyResult();
    });
    const { runner } = createRunner(fake.client, 250, 25);

    const pending = runner.processBatch(CURSOR_ID, REPLAY_REQUEST, 0, 0);
    const rejection = expect(pending).rejects.toBeInstanceOf(ReplayForcedStopError);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(fake.calls.filter(({ sql }) => sql.trim() === 'ROLLBACK')).toHaveLength(1);
    expect(fake.calls.some(({ sql }) => sql.trim() === 'COMMIT')).toBe(false);
    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rolls back inserted rows when a stop is requested immediately before commit', async () => {
    const fake = createFakeClient(({ sql }) => {
      if (sql.includes('FROM historical_events')) {
        return resultWithRows(eventRow('event-1'));
      }
      if (sql.includes('UPDATE indexer_replay_progress')) requestStopReplay();
      return emptyResult();
    });
    const { runner } = createRunner(fake.client);

    await expect(
      runner.processBatch(CURSOR_ID, REPLAY_REQUEST, 0, 0),
    ).resolves.toEqual({ rowsFetched: 0, aborted: true });

    expect(fake.calls.map(({ sql }) => classifyBatchQuery(sql))).toEqual([
      'BEGIN',
      'FETCH',
      'INSERT',
      'CURSOR',
      'CHECKPOINT',
      'ROLLBACK',
    ]);
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'without block bounds',
      request: { contract_id: 'contract-1', ledger: 42 },
      values: ['contract-1', 42],
      clauses: [],
    },
    {
      name: 'with only a lower block bound',
      request: { contract_id: 'contract-1', ledger: 42, from_block: 100 },
      values: ['contract-1', 42, 100],
      clauses: ['AND block_height >= $3'],
    },
    {
      name: 'with only an upper block bound',
      request: { contract_id: 'contract-1', ledger: 42, to_block: 200 },
      values: ['contract-1', 42, 200],
      clauses: ['AND block_height <= $3'],
    },
    {
      name: 'with both block bounds',
      request: REPLAY_REQUEST,
      values: ['contract-1', 42, 100, 200],
      clauses: ['AND block_height >= $3', 'AND block_height <= $4'],
    },
  ])('parameterizes the count query $name', async ({ request, values, clauses }) => {
    const fake = createFakeClient(() => resultWithRows({ count: '12' }));
    const { runner } = createRunner(fake.client);

    await expect(runner.countEventsToReplay(fake.client, request)).resolves.toBe(12);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.values).toEqual(values);
    expect(fake.calls[0]!.sql.match(/AND block_height [<>]= \$\d+/g)).toEqual(clauses);
  });

  it('returns zero when the count query has no row', async () => {
    const fake = createFakeClient();
    const { runner } = createRunner(fake.client);

    await expect(
      runner.countEventsToReplay(fake.client, REPLAY_REQUEST),
    ).resolves.toBe(0);
  });
});

describe('ReplayBatchRunner cancellation lock lifecycle', () => {
  it('releases the indexer lock and clears the stop signal after a mid-batch stop', async () => {
    const setupClient = createFakeClient(({ sql }) =>
      sql.includes('FROM replay_cursors')
        ? resultWithRows(cursorRow({ total_rows: 1 }))
        : emptyResult(),
    );
    const batchClient = createFakeClient(({ sql }) => {
      if (sql.includes('FROM historical_events')) {
        expect(replayLock.isHeld()).toBe(true);
        requestStopReplay();
        return resultWithRows(eventRow('event-1'));
      }
      return emptyResult();
    });
    const { pool } = createPool(setupClient.client, batchClient.client);
    const leaderElection = new NoOpLeaderElection();
    const releaseLease = vi.spyOn(leaderElection, 'release');
    const service = new IndexerService(
      pool,
      10,
      0,
      0,
      undefined,
      leaderElection,
      FORCED_TIMEOUT_MS,
    );

    await expect(service.replayEvents(REPLAY_REQUEST)).resolves.toEqual({
      outcome: 'cancelled',
      processedRows: 0,
      totalRows: 1,
    });

    expect(replayLock.isHeld()).toBe(false);
    expect(replayState.getState().isReplaying).toBe(false);
    expect(isReplayStopRequested()).toBe(false);
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(setupClient.release).toHaveBeenCalledTimes(1);
    expect(batchClient.release).toHaveBeenCalledTimes(1);
    expect(batchClient.calls.some(({ sql }) => sql.trim() === 'COMMIT')).toBe(false);
    expect(batchClient.calls.some(({ sql }) => sql.includes('completed_at = now()'))).toBe(false);
  });

  it('releases the lock and leader lease when a stopped hung batch force-times out', async () => {
    vi.useFakeTimers();
    const setupClient = createFakeClient(({ sql }) =>
      sql.includes('FROM replay_cursors')
        ? resultWithRows(cursorRow({ total_rows: 1 }))
        : emptyResult(),
    );
    const batchClient = createFakeClient(({ sql }) => {
      if (sql.includes('FROM historical_events')) {
        expect(replayLock.isHeld()).toBe(true);
        requestStopReplay();
        return new Promise<FakeQueryResult>(() => undefined);
      }
      return emptyResult();
    });
    const { pool } = createPool(setupClient.client, batchClient.client);
    const leaderElection = new NoOpLeaderElection();
    const releaseLease = vi.spyOn(leaderElection, 'release');
    const service = new IndexerService(
      pool,
      10,
      0,
      0,
      undefined,
      leaderElection,
      25,
    );

    const pending = service.replayEvents(REPLAY_REQUEST);
    const rejection = expect(pending).rejects.toBeInstanceOf(ReplayForcedStopError);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(replayLock.isHeld()).toBe(false);
    expect(replayState.getState().isReplaying).toBe(false);
    expect(isReplayStopRequested()).toBe(false);
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(setupClient.release).toHaveBeenCalledTimes(1);
    expect(batchClient.release).toHaveBeenCalledTimes(1);
    expect(batchClient.calls.some(({ sql }) => sql.trim() === 'COMMIT')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ReplayCursorRepository', () => {
  it('finds and maps the most recently started incomplete cursor', async () => {
    const row = cursorRow({ from_block: 0, to_block: 200, last_committed_offset: 5 });
    const fake = createFakeClient(() => resultWithRows(row));
    const repo = new ReplayCursorRepository();

    await expect(
      repo.findActive(fake.client, REPLAY_REQUEST.contract_id, REPLAY_REQUEST.ledger),
    ).resolves.toEqual(row);

    expect(fake.calls[0]!.values).toEqual([
      REPLAY_REQUEST.contract_id,
      REPLAY_REQUEST.ledger,
    ]);
    expect(fake.calls[0]!.sql).toContain('completed_at IS NULL');
    expect(fake.calls[0]!.sql).toContain('ORDER BY started_at DESC');
  });

  it('returns null when there is no active cursor', async () => {
    const fake = createFakeClient();
    const repo = new ReplayCursorRepository();

    await expect(
      repo.findActive(fake.client, REPLAY_REQUEST.contract_id, REPLAY_REQUEST.ledger),
    ).resolves.toBeNull();
  });

  it('creates a cursor at offset zero and maps undefined block bounds to null', async () => {
    const row = cursorRow({ total_rows: 0 });
    const fake = createFakeClient(() => resultWithRows(row));
    const repo = new ReplayCursorRepository();

    await expect(
      repo.create(
        fake.client,
        REPLAY_REQUEST.contract_id,
        REPLAY_REQUEST.ledger,
        undefined,
        undefined,
        0,
      ),
    ).resolves.toEqual(row);

    expect(fake.calls[0]!.values).toEqual([
      REPLAY_REQUEST.contract_id,
      REPLAY_REQUEST.ledger,
      null,
      null,
      0,
    ]);
    expect(fake.calls[0]!.sql).toContain('last_committed_offset)');
    expect(fake.calls[0]!.sql).toContain('VALUES ($1, $2, $3, $4, $5, 0)');
  });

  it('uses GREATEST for every offset advance so stale updates cannot regress it', async () => {
    let persistedOffset = 20;
    const fake = createFakeClient(({ sql, values }) => {
      if (sql.includes('UPDATE replay_cursors')) {
        expect(sql).toContain('last_committed_offset = GREATEST(last_committed_offset, $1)');
        expect(sql).toContain('WHERE id = $2');
        persistedOffset = Math.max(persistedOffset, Number(values?.[0]));
      }
      return emptyResult();
    });
    const repo = new ReplayCursorRepository();

    await repo.advanceOffset(fake.client, CURSOR_ID, 20);
    await repo.advanceOffset(fake.client, CURSOR_ID, 10);
    await repo.advanceOffset(fake.client, CURSOR_ID, 30);

    expect(fake.calls.map(({ values }) => values)).toEqual([
      [20, CURSOR_ID],
      [10, CURSOR_ID],
      [30, CURSOR_ID],
    ]);
    expect(persistedOffset).toBe(30);
  });

  it('marks only the requested cursor completed', async () => {
    const fake = createFakeClient();
    const repo = new ReplayCursorRepository();

    await repo.markCompleted(fake.client, CURSOR_ID);

    expect(fake.calls[0]!.sql).toContain('SET completed_at = now()');
    expect(fake.calls[0]!.sql).toContain('WHERE id = $1');
    expect(fake.calls[0]!.values).toEqual([CURSOR_ID]);
  });
});

describe('ReplayProgressCheckpointRepository', () => {
  it('upserts a resuming checkpoint as in-progress', async () => {
    const fake = createFakeClient();
    const repo = new ReplayProgressCheckpointRepository();

    await repo.upsertResuming(fake.client, CURSOR_ID, 20);

    expect(fake.calls[0]!.sql).toContain('ON CONFLICT (last_committed_cursor) DO UPDATE');
    expect(fake.calls[0]!.sql).toContain("SET status = 'in-progress', updated_at = now()");
    expect(fake.calls[0]!.values).toEqual([CURSOR_ID, 20, 'in-progress']);
  });

  it('inserts a missing checkpoint without overwriting an existing one', async () => {
    const fake = createFakeClient();
    const repo = new ReplayProgressCheckpointRepository();

    await repo.insertIfAbsent(fake.client, CURSOR_ID, 20);

    expect(fake.calls[0]!.sql).toContain('ON CONFLICT (last_committed_cursor) DO NOTHING');
    expect(fake.calls[0]!.values).toEqual([CURSOR_ID, 20, 'in-progress']);
  });

  it('touches only the matching checkpoint timestamp', async () => {
    const fake = createFakeClient();
    const repo = new ReplayProgressCheckpointRepository();

    await repo.touchUpdatedAt(fake.client, CURSOR_ID);

    expect(fake.calls[0]!.sql).toContain('SET updated_at = now()');
    expect(fake.calls[0]!.sql).toContain('WHERE last_committed_cursor = $1');
    expect(fake.calls[0]!.values).toEqual([CURSOR_ID]);
  });

  it('parameterizes the completed status and cursor id', async () => {
    const fake = createFakeClient();
    const repo = new ReplayProgressCheckpointRepository();

    await repo.markCompleted(fake.client, CURSOR_ID);

    expect(fake.calls[0]!.sql).toContain('SET status = $1, updated_at = now()');
    expect(fake.calls[0]!.sql).toContain('WHERE last_committed_cursor = $2');
    expect(fake.calls[0]!.values).toEqual(['completed', CURSOR_ID]);
  });

  it('maps the most recent in-progress checkpoint and cursor parameters', async () => {
    const fake = createFakeClient(() =>
      resultWithRows({
        last_committed_cursor: CURSOR_ID,
        contract_id: REPLAY_REQUEST.contract_id,
        ledger: '42',
        from_block: '0',
        to_block: null,
      }),
    );
    const repo = new ReplayProgressCheckpointRepository();

    await expect(repo.findMostRecentInProgress(fake.client)).resolves.toEqual({
      cursorId: CURSOR_ID,
      contractId: REPLAY_REQUEST.contract_id,
      ledger: 42,
      fromBlock: 0,
      toBlock: undefined,
    });

    expect(fake.calls[0]!.sql).toContain("WHERE p.status = 'in-progress'");
    expect(fake.calls[0]!.sql).toContain('ORDER BY p.started_at DESC');
  });

  it.each([
    { status: 'in-progress', offset: '4', isReplaying: true, remaining: 6 },
    { status: 'completed', offset: '12', isReplaying: false, remaining: 0 },
  ])('maps latest $status progress without negative remaining rows', async (testCase) => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const updatedAt = new Date('2026-01-01T00:01:00.000Z');
    const fake = createFakeClient(() =>
      resultWithRows({
        status: testCase.status,
        total: '10',
        started_at: startedAt,
        updated_at: updatedAt,
        contract_id: REPLAY_REQUEST.contract_id,
        ledger: '42',
        cursor_id: CURSOR_ID,
        last_committed_offset: testCase.offset,
      }),
    );
    const repo = new ReplayProgressCheckpointRepository();

    await expect(repo.findLatestProgress(fake.client)).resolves.toEqual({
      isReplaying: testCase.isReplaying,
      rowsReplayed: Number(testCase.offset),
      rowsRemaining: testCase.remaining,
      totalRows: 10,
      estimatedCompletion: null,
      startedAt,
      contractId: REPLAY_REQUEST.contract_id,
      ledger: 42,
      replayCursorId: CURSOR_ID,
      currentOffset: Number(testCase.offset),
      status: testCase.status,
    });

    expect(fake.calls[0]!.sql).toContain('ORDER BY p.updated_at DESC');
  });

  it('returns null when no checkpoint can be found', async () => {
    const fake = createFakeClient();
    const repo = new ReplayProgressCheckpointRepository();

    await expect(repo.findMostRecentInProgress(fake.client)).resolves.toBeNull();
    await expect(repo.findLatestProgress(fake.client)).resolves.toBeNull();
  });
});

describe('replay runtime checkpoint monotonicity', () => {
  it('never decreases progress when stale or duplicate offsets arrive', () => {
    replayState.startReplay(100, REPLAY_REQUEST.contract_id, REPLAY_REQUEST.ledger, CURSOR_ID, 20);
    expect(replayState.getState()).toMatchObject({
      rowsReplayed: 20,
      rowsRemaining: 80,
      currentOffset: 20,
    });

    replayState.updateProgress(10, 30);
    expect(replayState.getState()).toMatchObject({
      rowsReplayed: 30,
      rowsRemaining: 70,
      currentOffset: 30,
    });

    replayState.updateProgress(5, 25);
    replayState.updateProgress(0, 30);
    expect(replayState.getState()).toMatchObject({
      rowsReplayed: 30,
      rowsRemaining: 70,
      currentOffset: 30,
    });
  });
});
