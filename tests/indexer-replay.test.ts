/**
 * tests/indexer-replay.test.ts
 *
 * Unit tests for IndexerService.replayEvents per-batch transaction behaviour.
 *
 * Covers:
 *  - Commits one transaction per batch (not one global transaction)
 *  - Releases and re-acquires the connection between every batch
 *  - Crash mid-replay: committed batches survive; re-run completes idempotently
 *  - Concurrent replay rejection
 *  - Pool connection usage bounded to 1 simultaneous connection during replay
 *  - Max-range guard rejects oversized requests before any DB work
 *  - Budget guard aborts replay after the configured wall-clock ms
 *  - Zero-event replay marks cursor complete without any INSERT
 *  - Metrics: batch counter and row counter increment per committed batch
 *  - Structured log: replay_batch_committed event emitted after each commit
 *  - Idempotency: ON CONFLICT DO NOTHING — re-run after partial replay
 *    never double-inserts
 *  - ReplayCursorRepository: findActive, create, advanceOffset, markCompleted
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type pg from 'pg';
import {
  IndexerService,
  ReplayCursorRepository,
  ReplayBudgetExceededError,
  replayLock,
  replayState,
} from '../src/indexer/service.js';
import { deRegisterIndexerMetrics } from '../src/metrics/indexerMetrics.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

/** Build a mock PoolClient with controllable query behaviour. */
function makeClient(queryImpl?: QueryFn): pg.PoolClient {
  return {
    query: vi.fn().mockImplementation(
      queryImpl ??
        (() => Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] })),
    ),
    release: vi.fn(),
  } as unknown as pg.PoolClient;
}

/** Build a mock pg.Pool whose connect() returns the supplied clients in order. */
function makePool(...clients: pg.PoolClient[]): pg.Pool {
  let callCount = 0;
  return {
    connect: vi.fn(async () => {
      const c = clients[callCount % clients.length];
      callCount++;
      return c;
    }),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  } as unknown as pg.Pool;
}

/** Minimal ContractEvent row returned by SELECT from historical_events. */
function makeEvent(eventId: string, blockHeight = 1000) {
  return {
    event_id: eventId,
    contract_id: 'test-contract',
    ledger: 1,
    event_type: 'transfer',
    event_data: { amount: '100' },
    block_height: blockHeight,
    transaction_hash: `tx-${eventId}`,
  };
}

/**
 * Build a mock cursor repository with controllable responses.
 * By default: findActive returns null (no resume), create returns a fake cursor,
 * advanceOffset and markCompleted are no-ops.
 */
function makeCursorRepo(overrides: Partial<ReplayCursorRepository> = {}): ReplayCursorRepository {
  const defaultCursor = {
    id: 'cursor-uuid-001',
    contract_id: 'test-contract',
    ledger: 1,
    from_block: null,
    to_block: null,
    total_rows: 0,
    last_committed_offset: 0,
    started_at: new Date(),
    completed_at: null,
  };

  return {
    findActive: vi.fn(async () => null),
    create: vi.fn(async (_client, _cid, _ledger, _from, _to, totalRows) => ({
      ...defaultCursor,
      total_rows: totalRows,
    })),
    advanceOffset: vi.fn(async () => {}),
    markCompleted: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ReplayCursorRepository;
}

/** Build a service wired to the given pool and cursor repo. */
function makeService(
  pool: pg.Pool,
  cursorRepo: ReplayCursorRepository,
  opts: { batchSize?: number; maxRangeBlocks?: number; replayBudgetMs?: number } = {},
): IndexerService {
  return new IndexerService(
    pool,
    opts.batchSize ?? 2,       // small default so tests cover multi-batch paths
    opts.maxRangeBlocks ?? 0,  // 0 = unlimited
    opts.replayBudgetMs ?? 0,  // 0 = no budget
    cursorRepo,
  );
}

const REQUEST = { contract_id: 'test-contract', ledger: 1 };

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  // Ensure the lock is released before each test
  if (replayLock.isHeld()) (replayLock as unknown as { _isReplaying: boolean })._isReplaying = false;
  replayState.endReplay();
  deRegisterIndexerMetrics();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (replayLock.isHeld()) (replayLock as unknown as { _isReplaying: boolean })._isReplaying = false;
});

// ── ReplayCursorRepository ────────────────────────────────────────────────────

describe('ReplayCursorRepository', () => {
  it('findActive issues parameterized query and returns null when no row found', async () => {
    const client = makeClient(async () => ({ rows: [] }));
    const repo = new ReplayCursorRepository();
    const result = await repo.findActive(client, 'contract-1', 42);
    expect(result).toBeNull();
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE contract_id = $1'),
      ['contract-1', 42],
    );
  });

  it('create issues parameterized INSERT and returns the new cursor', async () => {
    const fakeCursor = {
      id: 'uuid-123',
      contract_id: 'c1',
      ledger: 5,
      from_block: null,
      to_block: null,
      total_rows: 10,
      last_committed_offset: 0,
      started_at: new Date(),
      completed_at: null,
    };
    const client = makeClient(async () => ({ rows: [fakeCursor] }));
    const repo = new ReplayCursorRepository();
    const cursor = await repo.create(client, 'c1', 5, undefined, undefined, 10);
    expect(cursor.id).toBe('uuid-123');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO replay_cursors'),
      ['c1', 5, null, null, 10],
    );
  });

  it('advanceOffset issues parameterized UPDATE', async () => {
    const client = makeClient(async () => ({ rows: [] }));
    const repo = new ReplayCursorRepository();
    await repo.advanceOffset(client, 'cursor-abc', 250, {
      event_id: 'evt-250',
      block_height: 5250,
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE replay_cursors'),
      [250, 'evt-250', 5250, 'cursor-abc'],
    );
  });

  it('findLatestIncomplete returns the newest running checkpoint', async () => {
    const checkpoint = {
      id: 'checkpoint-1',
      contract_id: 'c1',
      ledger: 5,
      from_block: null,
      to_block: null,
      total_rows: 10,
      last_committed_offset: 4,
      last_committed_event_id: 'evt-4',
      last_committed_block_height: 104,
      status: 'running' as const,
      started_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
    };
    const client = makeClient(async () => ({ rows: [checkpoint] }));
    const repo = new ReplayCursorRepository();
    const cursor = await repo.findLatestIncomplete(client);
    expect(cursor?.id).toBe('checkpoint-1');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'running'"),
    );
  });

  it('markCompleted issues parameterized UPDATE setting completed_at', async () => {
    const client = makeClient(async () => ({ rows: [] }));
    const repo = new ReplayCursorRepository();
    await repo.markCompleted(client, 'cursor-abc');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'completed'"),
      ['cursor-abc'],
    );
  });
});

// ── Input validation ──────────────────────────────────────────────────────────

describe('IndexerService — input validation', () => {
  it('throws for empty contract_id', async () => {
    const svc = makeService(makePool(), makeCursorRepo());
    await expect(svc.replayEvents({ contract_id: '', ledger: 1 })).rejects.toThrow('Invalid contract_id');
  });

  it('throws for negative ledger', async () => {
    const svc = makeService(makePool(), makeCursorRepo());
    await expect(svc.replayEvents({ contract_id: 'c1', ledger: -1 })).rejects.toThrow('Invalid ledger');
  });

  it('throws for negative from_block', async () => {
    const svc = makeService(makePool(), makeCursorRepo());
    await expect(
      svc.replayEvents({ contract_id: 'c1', ledger: 1, from_block: -5 }),
    ).rejects.toThrow('Invalid from_block');
  });

  it('throws when from_block > to_block', async () => {
    const svc = makeService(makePool(), makeCursorRepo());
    await expect(
      svc.replayEvents({ contract_id: 'c1', ledger: 1, from_block: 1000, to_block: 500 }),
    ).rejects.toThrow('from_block must be less than or equal to to_block');
  });
});

// ── Max-range guard ───────────────────────────────────────────────────────────

describe('IndexerService — max-range guard', () => {
  it('rejects when block range exceeds maxRangeBlocks — no DB calls made', async () => {
    const pool = makePool();
    const svc = makeService(pool, makeCursorRepo(), { maxRangeBlocks: 100 });
    await expect(
      svc.replayEvents({ contract_id: 'c1', ledger: 1, from_block: 0, to_block: 200 }),
    ).rejects.toThrow('exceeds the maximum allowed range');
    // No connection should have been checked out
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('allows a range exactly at the limit', async () => {
    // Set up zero-event replay so it exits immediately
    const cursorRepo = makeCursorRepo({
      create: vi.fn(async (_c, cid, ledger, fb, tb, _total) => ({
        id: 'c1',
        contract_id: cid,
        ledger,
        from_block: fb ?? null,
        to_block: tb ?? null,
        total_rows: 0,
        last_committed_offset: 0,
        started_at: new Date(),
        completed_at: null,
      })),
    });
    const client = makeClient(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    });
    const pool = makePool(client);
    const svc = makeService(pool, cursorRepo, { maxRangeBlocks: 100 });
    // Range = 100 = exactly the limit — should not throw
    await expect(
      svc.replayEvents({ contract_id: 'c1', ledger: 1, from_block: 0, to_block: 100 }),
    ).resolves.toBeUndefined();
  });
});

// ── Concurrent replay ─────────────────────────────────────────────────────────

describe('IndexerService — concurrent replay rejection', () => {
  it('throws when a replay is already in progress', async () => {
    (replayLock as unknown as { _isReplaying: boolean })._isReplaying = true;
    const svc = makeService(makePool(), makeCursorRepo());
    await expect(svc.replayEvents(REQUEST)).rejects.toThrow('already in progress');
  });

  it('releases the lock when replay throws', async () => {
    const client = makeClient(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '5' }] };
      if (sql.trim().startsWith('SELECT')) return { rows: [] }; // findActive
      if (sql.includes('INSERT INTO replay_cursors')) throw new Error('cursor create failed');
      return { rows: [] };
    });
    const cursorRepo = makeCursorRepo({
      create: vi.fn(async () => { throw new Error('cursor create failed'); }),
    });
    const pool = makePool(client);
    const svc = makeService(pool, cursorRepo);

    await expect(svc.replayEvents(REQUEST)).rejects.toThrow('cursor create failed');
    expect(replayLock.isHeld()).toBe(false);
  });
});

// ── Zero-event replay ─────────────────────────────────────────────────────────

describe('IndexerService — zero-event replay', () => {
  it('completes without any INSERT when totalRows = 0', async () => {
    const cursorRepo = makeCursorRepo({
      create: vi.fn(async (_c, cid, ledger) => ({
        id: 'c0',
        contract_id: cid,
        ledger,
        from_block: null,
        to_block: null,
        total_rows: 0,
        last_committed_offset: 0,
        started_at: new Date(),
        completed_at: null,
      })),
    });
    const client = makeClient(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    });
    const pool = makePool(client);
    const svc = makeService(pool, cursorRepo);

    await expect(svc.replayEvents(REQUEST)).resolves.toBeUndefined();
    expect(cursorRepo.markCompleted).toHaveBeenCalledWith(expect.anything(), 'c0');
  });
});

// ── Per-batch commit behaviour ────────────────────────────────────────────────

describe('IndexerService — per-batch commits', () => {
  /**
   * Scenario: 4 source events, batchSize = 2 → 2 batches.
   * Asserts:
   *  - BEGIN called twice (once per batch)
   *  - COMMIT called twice
   *  - advanceOffset called twice with incremented offsets
   *  - client.release called after each batch
   */
  it('commits once per batch and releases the connection between batches', async () => {
    const events = [
      makeEvent('e1', 100),
      makeEvent('e2', 200),
      makeEvent('e3', 300),
      makeEvent('e4', 400),
    ];

    // Cursor client (used for findActive + create)
    const cursorClient = makeClient(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '4' }] };
      if (sql.includes('INSERT INTO replay_cursors')) {
        return {
          rows: [
            {
              id: 'cursor-1',
              contract_id: 'test-contract',
              ledger: 1,
              from_block: null,
              to_block: null,
              total_rows: 4,
              last_committed_offset: 0,
              started_at: new Date(),
              completed_at: null,
            },
          ],
        };
      }
      return { rows: [] }; // findActive returns null
    });

    // Batch clients — one per batch
    const batch1Client = makeClient(async (sql) => {
      if (sql.includes('SELECT') && sql.includes('FROM historical_events')) {
        return { rows: events.slice(0, 2) };
      }
      return { rows: [] };
    });
    const batch2Client = makeClient(async (sql) => {
      if (sql.includes('SELECT') && sql.includes('FROM historical_events')) {
        return { rows: events.slice(2, 4) };
      }
      return { rows: [] };
    });
    // completeCursor connection
    const completeClient = makeClient(async () => ({ rows: [] }));

    const cursorRepo = makeCursorRepo({
      findActive: vi.fn(async () => null),
      create: vi.fn(async (_c, cid, ledger) => ({
        id: 'cursor-1',
        contract_id: cid,
        ledger,
        from_block: null,
        to_block: null,
        total_rows: 4,
        last_committed_offset: 0,
        started_at: new Date(),
        completed_at: null,
      })),
    });

    // Pool returns: cursorClient (resolve), batch1Client, batch2Client, completeClient
    const pool = makePool(cursorClient, batch1Client, batch2Client, completeClient);
    const svc = makeService(pool, cursorRepo, { batchSize: 2 });

    await svc.replayEvents(REQUEST);

    // Two batch connections acquired
    expect(batch1Client.query).toHaveBeenCalledWith('BEGIN');
    expect(batch1Client.query).toHaveBeenCalledWith('COMMIT');
    expect(batch1Client.release).toHaveBeenCalledTimes(1);

    expect(batch2Client.query).toHaveBeenCalledWith('BEGIN');
    expect(batch2Client.query).toHaveBeenCalledWith('COMMIT');
    expect(batch2Client.release).toHaveBeenCalledTimes(1);

    // advanceOffset called with correct increments
    expect(cursorRepo.advanceOffset).toHaveBeenCalledTimes(2);
    expect(cursorRepo.advanceOffset).toHaveBeenNthCalledWith(
      1,
      batch1Client,
      'cursor-1',
      2,
      expect.objectContaining({ event_id: 'e2', block_height: 200 }),
    );
    expect(cursorRepo.advanceOffset).toHaveBeenNthCalledWith(
      2,
      batch2Client,
      'cursor-1',
      4,
      expect.objectContaining({ event_id: 'e4', block_height: 400 }),
    );

    // Cursor marked complete
    expect(cursorRepo.markCompleted).toHaveBeenCalledWith(expect.anything(), 'cursor-1');
  });

  it('does NOT issue a single BEGIN before the loop', async () => {
    const cursorClient = makeClient(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '1' }] };
      return { rows: [] };
    });
    const batchClient = makeClient(async (sql) => {
      if (sql.includes('FROM historical_events')) return { rows: [makeEvent('e1')] };
      return { rows: [] };
    });
    const completeClient = makeClient(async () => ({ rows: [] }));
    const cursorRepo = makeCursorRepo({
      create: vi.fn(async (_c, cid, ledger) => ({
        id: 'c2',
        contract_id: cid,
        ledger,
        from_block: null,
        to_block: null,
        total_rows: 1,
        last_committed_offset: 0,
        started_at: new Date(),
        completed_at: null,
      })),
    });
    const pool = makePool(cursorClient, batchClient, completeClient);
    const svc = makeService(pool, cursorRepo);

    await svc.replayEvents(REQUEST);

    // The cursorClient should NEVER see a BEGIN/COMMIT — it's only for cursor ops
    const cursorCalls = (cursorClient.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(cursorCalls).not.toContain('BEGIN');
    expect(cursorCalls).not.toContain('COMMIT');
  });
});

// ── Crash-resume (partial commit) ─────────────────────────────────────────────

describe('IndexerService — crash-resume semantics', () => {
  /**
   * Scenario: A previous run committed batch 0 (offset 0→2) then crashed.
   * The cursor has last_committed_offset = 2.
   * A re-run should start from offset 2 and commit only batches 1+.
   */
  it('resumes from last_committed_offset when an existing cursor is found', async () => {
    const events = [
      makeEvent('e3', 300),
      makeEvent('e4', 400),
    ];

    const existingCursor = {
      id: 'cursor-resumed',
      contract_id: 'test-contract',
      ledger: 1,
      from_block: null,
      to_block: null,
      total_rows: 4,
      last_committed_offset: 2, // batch 0 already committed
      started_at: new Date(),
      completed_at: null,
    };

    const cursorClient = makeClient(async () => ({ rows: [] }));
    const batchClient = makeClient(async (sql) => {
      if (sql.includes('FROM historical_events')) return { rows: events };
      return { rows: [] };
    });
    const completeClient = makeClient(async () => ({ rows: [] }));

    const cursorRepo = makeCursorRepo({
      findActive: vi.fn(async () => existingCursor),
    });

    const pool = makePool(cursorClient, batchClient, completeClient);
    const svc = makeService(pool, cursorRepo, { batchSize: 2 });

    await svc.replayEvents(REQUEST);

    // Should not create a new cursor
    expect(cursorRepo.create).not.toHaveBeenCalled();

    // Should advance from offset 2 to offset 4
    expect(cursorRepo.advanceOffset).toHaveBeenCalledWith(
      batchClient,
      'cursor-resumed',
      4,
      expect.objectContaining({ event_id: 'e4', block_height: 400 }),
    );

    // Only 1 batch was processed (events e3, e4)
    expect(batchClient.query).toHaveBeenCalledWith('BEGIN');
    expect(batchClient.query).toHaveBeenCalledWith('COMMIT');
  });

  /**
   * Scenario: Batch 1 fails mid-flight.
   * Asserts that ROLLBACK is issued, the connection is released, and the
   * error propagates so the caller knows the replay failed.
   */
  it('rolls back the failing batch and releases the connection on error', async () => {
    const cursorRepo = makeCursorRepo({
      create: vi.fn(async (_c, cid, ledger) => ({
        id: 'c-err',
        contract_id: cid,
        ledger,
        from_block: null,
        to_block: null,
        total_rows: 2,
        last_committed_offset: 0,
        started_at: new Date(),
        completed_at: null,
      })),
    });

    const cursorClient = makeClient(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '2' }] };
      return { rows: [] };
    });

    // This batch client throws during INSERT
    const failingBatchClient = makeClient(async (sql) => {
      if (sql.trim() === 'BEGIN') return { rows: [] };
      if (sql.includes('FROM historical_events')) return { rows: [makeEvent('e1'), makeEvent('e2')] };
      if (sql.includes('INSERT INTO contract_events')) throw new Error('simulated DB failure');
      return { rows: [] };
    });

    const pool = makePool(cursorClient, failingBatchClient);
    const svc = makeService(pool, cursorRepo, { batchSize: 2 });

    await expect(svc.replayEvents(REQUEST)).rejects.toThrow('simulated DB failure');

    expect(failingBatchClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(failingBatchClient.release).toHaveBeenCalled();
    expect(replayLock.isHeld()).toBe(false);
  });

  it('idempotent re-run: uses ON CONFLICT DO NOTHING in INSERT', async () => {
    const cursorRepo = makeCursorRepo({
      create: vi.fn(async (_c, cid, ledger) => ({
        id: 'c-idem',
        contract_id: cid,
        ledger,
        from_block: null,
        to_block: null,
        total_rows: 2,
        last_committed_offset: 0,
        started_at: new Date(),
        completed_at: null,
      })),
    });

    const cursorClient = makeClient(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '2' }] };
      return { rows: [] };
    });

    const insertSqls: string[] = [];
    const batchClient = makeClient(async (sql) => {
      if (sql.includes('FROM historical_events')) return { rows: [makeEvent('e1'), makeEvent('e2')] };
      if (sql.includes('INSERT INTO contract_events')) {
        insertSqls.push(sql);
        return { rows: [], rowCount: 0 }; // 0 rows inserted (conflict)
      }
      return { rows: [] };
    });

    const completeClient = makeClient(async () => ({ rows: [] }));
    const pool = makePool(cursorClient, batchClient, completeClient);
    const svc = makeService(pool, cursorRepo, { batchSize: 2 });

    await svc.replayEvents(REQUEST);

    // Every INSERT must carry ON CONFLICT DO NOTHING
    expect(insertSqls.length).toBeGreaterThan(0);
    for (const sql of insertSqls) {
      expect(sql).toContain('ON CONFLICT (event_id) DO NOTHING');
    }
  });
});

// ── Budget guard ──────────────────────────────────────────────────────────────

describe('IndexerService — budget guard', () => {
  it('throws ReplayBudgetExceededError when budget is exceeded', async () => {
    let mockTime = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => mockTime);

    const cursorRepo = makeCursorRepo({
      create: vi.fn(async (_c, cid, ledger) => {
        mockTime = 6000; // Advance time to exceed budget before checking it in the loop
        return {
          id: 'budget-cursor',
          contract_id: cid,
          ledger,
          from_block: null,
          to_block: null,
          total_rows: 10,
          last_committed_offset: 0,
          started_at: new Date(),
          completed_at: null,
        };
      }),
    });

    const client = makeClient(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '10' }] };
      return { rows: [] };
    });
    const pool = makePool(client, client, client);
    const svc = makeService(pool, cursorRepo, { replayBudgetMs: 5000 });

    await expect(svc.replayEvents(REQUEST)).rejects.toBeInstanceOf(ReplayBudgetExceededError);
    expect(replayLock.isHeld()).toBe(false);
  });
});

// ── Pool connection bounds ─────────────────────────────────────────────────────

describe('IndexerService — pool connection usage', () => {
  it('holds at most 1 connection at a time during a multi-batch replay', async () => {
    let concurrentConnections = 0;
    let maxConcurrentConnections = 0;

    // Track concurrent checkouts via a wrapping pool
    const events = [makeEvent('e1'), makeEvent('e2'), makeEvent('e3'), makeEvent('e4')];
    let batchCallCount = 0;

    const pool = {
      connect: vi.fn(async () => {
        concurrentConnections++;
        if (concurrentConnections > maxConcurrentConnections) {
          maxConcurrentConnections = concurrentConnections;
        }
        const batchIdx = batchCallCount;
        batchCallCount++;
        return {
          query: vi.fn(async (sql: string) => {
            if (sql.includes('COUNT')) return { rows: [{ count: '4' }] };
            if (sql.includes('FROM historical_events')) {
              const slice = events.slice(batchIdx * 2, batchIdx * 2 + 2);
              return { rows: slice };
            }
            return { rows: [] };
          }),
          release: vi.fn(() => {
            concurrentConnections--;
          }),
        } as unknown as pg.PoolClient;
      }),
    } as unknown as pg.Pool;

    const cursorRepo = makeCursorRepo({
      create: vi.fn(async (_c, cid, ledger) => ({
        id: 'pool-test-cursor',
        contract_id: cid,
        ledger,
        from_block: null,
        to_block: null,
        total_rows: 4,
        last_committed_offset: 0,
        started_at: new Date(),
        completed_at: null,
      })),
    });

    const svc = makeService(pool, cursorRepo, { batchSize: 2 });
    await svc.replayEvents(REQUEST);

    expect(maxConcurrentConnections).toBeLessThanOrEqual(1);
  });
});

// ── Metrics ───────────────────────────────────────────────────────────────────

describe('IndexerService — Prometheus metrics', () => {
  it('increments batch counter once per committed batch', async () => {
    const { indexerReplayBatchesCommittedTotal } = await import(
      '../src/metrics/indexerMetrics.js'
    );

    const before = (await indexerReplayBatchesCommittedTotal.get()).values
      .find((v: { labels: { contract_id?: string } }) => v.labels?.contract_id === 'test-contract')
      ?.value ?? 0;

    const cursorRepo = makeCursorRepo({
      create: vi.fn(async (_c, cid, ledger) => ({
        id: 'metrics-cursor',
        contract_id: cid,
        ledger,
        from_block: null,
        to_block: null,
        total_rows: 2,
        last_committed_offset: 0,
        started_at: new Date(),
        completed_at: null,
      })),
    });

    const cursorClient = makeClient(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '2' }] };
      return { rows: [] };
    });
    const batchClient = makeClient(async (sql) => {
      if (sql.includes('FROM historical_events')) return { rows: [makeEvent('e1'), makeEvent('e2')] };
      return { rows: [] };
    });
    const completeClient = makeClient(async () => ({ rows: [] }));

    const pool = makePool(cursorClient, batchClient, completeClient);
    const svc = makeService(pool, cursorRepo, { batchSize: 2 });

    await svc.replayEvents(REQUEST);

    const after = (await indexerReplayBatchesCommittedTotal.get()).values
      .find((v: { labels: { contract_id?: string } }) => v.labels?.contract_id === 'test-contract')
      ?.value ?? 0;

    expect(after - before).toBe(1);
  });

  it('increments rows counter by the number of rows in the batch', async () => {
    const { indexerReplayRowsCommittedTotal } = await import(
      '../src/metrics/indexerMetrics.js'
    );

    const before = (await indexerReplayRowsCommittedTotal.get()).values
      .find((v: { labels: { contract_id?: string } }) => v.labels?.contract_id === 'test-contract')
      ?.value ?? 0;

    const cursorRepo = makeCursorRepo({
      create: vi.fn(async (_c, cid, ledger) => ({
        id: 'rows-cursor',
        contract_id: cid,
        ledger,
        from_block: null,
        to_block: null,
        total_rows: 2,
        last_committed_offset: 0,
        started_at: new Date(),
        completed_at: null,
      })),
    });

    const cursorClient = makeClient(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '2' }] };
      return { rows: [] };
    });
    const batchClient = makeClient(async (sql) => {
      if (sql.includes('FROM historical_events')) return { rows: [makeEvent('e1'), makeEvent('e2')] };
      return { rows: [] };
    });
    const completeClient = makeClient(async () => ({ rows: [] }));

    const pool = makePool(cursorClient, batchClient, completeClient);
    const svc = makeService(pool, cursorRepo, { batchSize: 2 });

    await svc.replayEvents(REQUEST);

    const after = (await indexerReplayRowsCommittedTotal.get()).values
      .find((v: { labels: { contract_id?: string } }) => v.labels?.contract_id === 'test-contract')
      ?.value ?? 0;

    expect(after - before).toBe(2);
  });
});

// ── Structured logging ────────────────────────────────────────────────────────

describe('IndexerService — structured logging', () => {
  it('emits replay_batch_committed log after each committed batch', async () => {
    const { logger } = await import('../src/lib/logger.js');
    const infoSpy = vi.spyOn(logger, 'info');

    const cursorRepo = makeCursorRepo({
      create: vi.fn(async (_c, cid, ledger) => ({
        id: 'log-cursor',
        contract_id: cid,
        ledger,
        from_block: null,
        to_block: null,
        total_rows: 2,
        last_committed_offset: 0,
        started_at: new Date(),
        completed_at: null,
      })),
    });

    const cursorClient = makeClient(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '2' }] };
      return { rows: [] };
    });
    const batchClient = makeClient(async (sql) => {
      if (sql.includes('FROM historical_events')) return { rows: [makeEvent('e1'), makeEvent('e2')] };
      return { rows: [] };
    });
    const completeClient = makeClient(async () => ({ rows: [] }));

    const pool = makePool(cursorClient, batchClient, completeClient);
    const svc = makeService(pool, cursorRepo, { batchSize: 2 });

    await svc.replayEvents(REQUEST);

    const batchLogs = infoSpy.mock.calls
      .filter((c) => c[0] === 'replay_batch_committed')
      .map((c) => c[2]);

    expect(batchLogs.length).toBe(1);
    expect(batchLogs[0]).toMatchObject({
      event: 'replay_batch_committed',
      batch_index: 0,
      rows_in_batch: 2,
      offset: 2,
      total_rows: 2,
      rows_remaining: 0,
    });
  });

  it('emits replay_completed log at the end', async () => {
    const { logger } = await import('../src/lib/logger.js');
    const infoSpy = vi.spyOn(logger, 'info');

    const cursorRepo = makeCursorRepo({
      create: vi.fn(async (_c, cid, ledger) => ({
        id: 'log-done-cursor',
        contract_id: cid,
        ledger,
        from_block: null,
        to_block: null,
        total_rows: 1,
        last_committed_offset: 0,
        started_at: new Date(),
        completed_at: null,
      })),
    });

    const cursorClient = makeClient(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '1' }] };
      return { rows: [] };
    });
    const batchClient = makeClient(async (sql) => {
      if (sql.includes('FROM historical_events')) return { rows: [makeEvent('e1')] };
      return { rows: [] };
    });
    const completeClient = makeClient(async () => ({ rows: [] }));

    const pool = makePool(cursorClient, batchClient, completeClient);
    const svc = makeService(pool, cursorRepo, { batchSize: 2 });

    await svc.replayEvents(REQUEST);

    const completeLogs = infoSpy.mock.calls
      .filter((c) => c[2] && (c[2] as Record<string, unknown>).event === 'replay_completed')
      .map((c) => c[2]);

    expect(completeLogs.length).toBe(1);
    expect(completeLogs[0]).toMatchObject({
      event: 'replay_completed',
      contract_id: 'test-contract',
      total_rows: 1,
    });
  });
});

// ── getReplayProgress ──────────────────────────────────────────────────────────

describe('IndexerService — getReplayProgress', () => {
  it('returns isReplaying: false when idle', () => {
    const svc = makeService(makePool(), makeCursorRepo());
    expect(svc.getReplayProgress().isReplaying).toBe(false);
  });

  it('returns the latest durable checkpoint when memory state is idle', async () => {
    const checkpoint = {
      id: 'cursor-after-restart',
      contract_id: 'contract-after-restart',
      ledger: 42,
      from_block: null,
      to_block: null,
      total_rows: 10,
      last_committed_offset: 6,
      last_committed_event_id: 'evt-6',
      last_committed_block_height: 9006,
      status: 'running' as const,
      started_at: new Date('2026-06-20T10:00:00.000Z'),
      updated_at: new Date('2026-06-20T10:05:00.000Z'),
      completed_at: null,
    };
    const cursorClient = makeClient(async () => ({ rows: [checkpoint] }));
    const cursorRepo = makeCursorRepo({
      findLatestIncomplete: vi.fn(async () => checkpoint),
    });
    const svc = makeService(makePool(cursorClient), cursorRepo);

    const progress = await svc.getReplayProgressSnapshot();

    expect(progress).toMatchObject({
      isReplaying: true,
      rowsReplayed: 6,
      rowsRemaining: 4,
      totalRows: 10,
      contractId: 'contract-after-restart',
      ledger: 42,
      status: 'running',
      replayCursorId: 'cursor-after-restart',
      currentOffset: 6,
      lastCommittedEventId: 'evt-6',
      lastCommittedBlockHeight: 9006,
    });
    expect(cursorRepo.findLatestIncomplete).toHaveBeenCalledWith(cursorClient);
    expect(cursorClient.release).toHaveBeenCalled();
  });
});
