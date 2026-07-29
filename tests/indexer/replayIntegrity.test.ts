/**
 * tests/indexer/replayIntegrity.test.ts
 *
 * Comprehensive unit tests for the post-replay ledger-sequence integrity check.
 *
 * Covers:
 *  - Gap detection (missing ledgers in sequence)
 *  - Duplicate event detection (same event_id appearing multiple times)
 *  - Clean pass (contiguous, gap-free range)
 *  - Empty range (no events for the contract)
 *  - Range clamping (enforcing MAX_INTEGRITY_RANGE)
 *  - DB error propagation (caught and returned as error field)
 *  - Audit event recording on issue detection
 *  - Prometheus counter increment on issue detection
 *  - Prometheus counter NOT incremented on clean pass
 *  - Huge gap range (detecting many gaps)
 *  - Integration with IndexerService (post-replay hook)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pg from 'pg';
import {
  checkReplayIntegrity,
  __QUERIES,
  type ReplayIntegrityCheckResult,
} from '../../src/indexer/replayIntegrity.js';
import { deRegisterIndexerMetrics } from '../../src/metrics/indexerMetrics.js';
import { _resetAuditLog } from '../../src/lib/auditLog.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

type QueryImpl = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

/** Build a mock pg.Pool whose connect() returns a client with the given query impl. */
function makePool(queryImpl: QueryImpl): pg.Pool {
  return {
    connect: vi.fn(async () => ({
      query: vi.fn().mockImplementation(queryImpl),
      release: vi.fn(),
    })),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  } as unknown as pg.Pool;
}

/**
 * Build a query impl that simulates a `contract_events` table in memory.
 * The store maps (contractId) -> Array<{ eventId, ledger }>.
 */
function makeInMemoryStore(
  initialData: Array<{ contractId: string; eventId: string; ledger: number }>,
): QueryImpl {
  // Clone so tests don't share mutation
  const rows = initialData.map((r) => ({ ...r }));

  return (sql: string, params?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    // RANGE_QUERY: MIN/MAX ledger for a contract in range
    if (normalized.includes('MIN(ledger)') && normalized.includes('MAX(ledger)')) {
      const [contractId] = params as [string];
      const filtered = rows.filter(
        (r) => r.contractId === contractId,
      );
      if (filtered.length === 0) {
        return { rows: [{ min_ledger: null, max_ledger: null }] };
      }
      const ledgers = filtered.map((r) => r.ledger);
      return {
        rows: [
          {
            min_ledger: Math.min(...ledgers),
            max_ledger: Math.max(...ledgers),
          },
        ],
      };
    }

    // GAP_QUERY: generate_series to find missing ledgers
    if (normalized.includes('generate_series')) {
      const [fromLedger, toLedger, contractId] = params as [number, number, string];
      const actualLedgers = new Set(
        rows.filter((r) => r.contractId === contractId).map((r) => r.ledger),
      );
      const gaps: number[] = [];
      for (let l = fromLedger; l <= toLedger; l++) {
        if (!actualLedgers.has(l)) gaps.push(l);
      }
      return {
        rows: gaps.map((g) => ({ gap_ledger: g })),
      };
    }

    // DUPLICATE_QUERY: GROUP BY event_id, ledger HAVING COUNT(*) > 1
    if (normalized.includes('GROUP BY event_id, ledger') && normalized.includes('HAVING COUNT(*) > 1')) {
      const [contractId, fromLedger, toLedger] = params as [string, number, number];
      const grouped = new Map<string, { eventId: string; ledger: number; count: number }>();
      for (const r of rows) {
        if (r.contractId !== contractId) continue;
        if (r.ledger < fromLedger || r.ledger > toLedger) continue;
        const key = `${r.eventId}|${r.ledger}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.count++;
        } else {
          grouped.set(key, { eventId: r.eventId, ledger: r.ledger, count: 1 });
        }
      }
      const duplicates = Array.from(grouped.values()).filter((g) => g.count > 1);
      return {
        rows: duplicates.map((d) => ({
          event_id: d.eventId,
          ledger: d.ledger,
          occurrence_count: d.count,
        })),
      };
    }

    return { rows: [] };
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  deRegisterIndexerMetrics();
  _resetAuditLog();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Clean pass ────────────────────────────────────────────────────────────────

describe('checkReplayIntegrity — clean pass', () => {
  it('returns hasIssues:false for a contiguous gap-free range', async () => {
    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 10 },
      { contractId: 'c1', eventId: 'e2', ledger: 11 },
      { contractId: 'c1', eventId: 'e3', ledger: 12 },
    ]);
    const pool = makePool(store);

    const result = await checkReplayIntegrity(pool, 'c1', 10, 12);
    expect(result.hasIssues).toBe(false);
    expect(result.gaps).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.checkedRange).toEqual({ fromLedger: 10, toLedger: 12 });
    expect(result.contractId).toBe('c1');
  });

  it('handles single event (no range)', async () => {
    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 42 },
    ]);
    const pool = makePool(store);

    const result = await checkReplayIntegrity(pool, 'c1', 42, 42);
    expect(result.hasIssues).toBe(false);
    expect(result.gaps).toEqual([]);
    expect(result.duplicates).toEqual([]);
  });
});

// ── Gap detection ─────────────────────────────────────────────────────────────

describe('checkReplayIntegrity — gap detection', () => {
  it('detects a single missing ledger', async () => {
    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 10 },
      { contractId: 'c1', eventId: 'e2', ledger: 12 }, // ledger 11 missing
    ]);
    const pool = makePool(store);

    const result = await checkReplayIntegrity(pool, 'c1', 10, 12);
    expect(result.hasIssues).toBe(true);
    expect(result.gaps).toEqual([11]);
  });

  it('detects multiple missing ledgers', async () => {
    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 10 },
      { contractId: 'c1', eventId: 'e2', ledger: 15 },
    ]);
    const pool = makePool(store);

    const result = await checkReplayIntegrity(pool, 'c1', 10, 15);
    expect(result.hasIssues).toBe(true);
    expect(result.gaps).toEqual([11, 12, 13, 14]);
  });

  it('detects gaps only for the requested contract, not others', async () => {
    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 10 },
      { contractId: 'c1', eventId: 'e2', ledger: 12 }, // gap at 11
      { contractId: 'c2', eventId: 'e3', ledger: 10 },
      { contractId: 'c2', eventId: 'e4', ledger: 11 },
    ]);
    const pool = makePool(store);

    const resultC1 = await checkReplayIntegrity(pool, 'c1', 10, 12);
    expect(resultC1.hasIssues).toBe(true);
    expect(resultC1.gaps).toEqual([11]);

    const resultC2 = await checkReplayIntegrity(pool, 'c2', 10, 11);
    expect(resultC2.hasIssues).toBe(false);
    expect(resultC2.gaps).toEqual([]);
  });

  it('reports no gaps when all expected ledgers are present with multiple events per ledger', async () => {
    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 10 },
      { contractId: 'c1', eventId: 'e2', ledger: 10 },
      { contractId: 'c1', eventId: 'e3', ledger: 11 },
      { contractId: 'c1', eventId: 'e4', ledger: 11 },
    ]);
    const pool = makePool(store);

    const result = await checkReplayIntegrity(pool, 'c1', 10, 11);
    expect(result.hasIssues).toBe(false);
    expect(result.gaps).toEqual([]);
  });
});

// ── Duplicate detection ───────────────────────────────────────────────────────

describe('checkReplayIntegrity — duplicate detection', () => {
  it('detects duplicate event entries (same event_id, same ledger)', async () => {
    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'dup-event', ledger: 10 },
      { contractId: 'c1', eventId: 'dup-event', ledger: 10 }, // duplicate
      { contractId: 'c1', eventId: 'e2', ledger: 11 },
    ]);
    const pool = makePool(store);

    const result = await checkReplayIntegrity(pool, 'c1', 10, 11);
    expect(result.hasIssues).toBe(true);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]).toMatchObject({
      eventId: 'dup-event',
      ledger: 10,
      count: 2,
    });
  });

  it('detects multiple duplicates across ledgers', async () => {
    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 10 },
      { contractId: 'c1', eventId: 'e1', ledger: 10 }, // dup
      { contractId: 'c1', eventId: 'e2', ledger: 11 },
      { contractId: 'c1', eventId: 'e2', ledger: 11 }, // dup
    ]);
    const pool = makePool(store);

    const result = await checkReplayIntegrity(pool, 'c1', 10, 11);
    expect(result.hasIssues).toBe(true);
    expect(result.duplicates).toHaveLength(2);
  });

  it('does NOT flag unique events as duplicates even if same ledger', async () => {
    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 10 },
      { contractId: 'c1', eventId: 'e2', ledger: 10 },
      { contractId: 'c1', eventId: 'e3', ledger: 10 },
    ]);
    const pool = makePool(store);

    const result = await checkReplayIntegrity(pool, 'c1', 10, 10);
    expect(result.hasIssues).toBe(false);
    expect(result.duplicates).toEqual([]);
  });
});

// ── Empty range ───────────────────────────────────────────────────────────────

describe('checkReplayIntegrity — empty range', () => {
  it('returns hasIssues:false when no events exist for the contract', async () => {
    const store = makeInMemoryStore([
      { contractId: 'other', eventId: 'e1', ledger: 42 },
    ]);
    const pool = makePool(store);

    const result = await checkReplayIntegrity(pool, 'c1', 1, 100);
    expect(result.hasIssues).toBe(false);
    expect(result.gaps).toEqual([]);
    expect(result.duplicates).toEqual([]);
  });
});

// ── Range clamping ────────────────────────────────────────────────────────────

describe('checkReplayIntegrity — range clamping', () => {
  it('clamps to MAX_INTEGRITY_RANGE and logs a warning', async () => {
    // Spy on logger.warn
    const { logger } = await import('../../src/lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    const MAX = __QUERIES.MAX_INTEGRITY_RANGE;
    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 1 },
      { contractId: 'c1', eventId: 'e2', ledger: MAX + 100 },
    ]);
    const pool = makePool(store);

    const result = await checkReplayIntegrity(pool, 'c1', 1, MAX + 100);
    // The range should be clamped; the check result shows the clamped range
    expect(warnSpy).toHaveBeenCalledWith(
      'replay_integrity_range_clamped',
      undefined,
      expect.objectContaining({
        event: 'replay_integrity_range_clamped',
      }),
    );
    // Result should still work on the clamped range
    expect(result.checkedRange.fromLedger).toBeGreaterThanOrEqual(1);
  });
});

// ── DB error handling ─────────────────────────────────────────────────────────

describe('checkReplayIntegrity — DB error handling', () => {
  it('catches DB errors and returns them in the error field', async () => {
    const pool = makePool(async () => {
      throw new Error('connection lost');
    });

    const result = await checkReplayIntegrity(pool, 'c1', 1, 10);
    expect(result.hasIssues).toBe(false);
    expect(result.error).toBe('connection lost');
  });

  it('logs a warning when the query fails', async () => {
    const { logger } = await import('../../src/lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    const pool = makePool(async () => {
      throw new Error('timeout');
    });

    await checkReplayIntegrity(pool, 'c1', 1, 10);
    expect(warnSpy).toHaveBeenCalledWith(
      'replay_integrity_query_failed',
      undefined,
      expect.objectContaining({
        event: 'replay_integrity_query_failed',
        error: 'timeout',
      }),
    );
  });
});

// ── Audit event recording ─────────────────────────────────────────────────────

describe('checkReplayIntegrity — audit event', () => {
  it('writes an audit entry when gaps are detected', async () => {
    const auditMock = vi
      .spyOn(await import('../../src/lib/auditLog.js'), 'recordAuditEventToDb')
      .mockResolvedValue({
        seq: 1,
        timestamp: new Date().toISOString(),
        action: 'REPLAY_INTEGRITY_ISSUE',
        resourceType: 'contract_events',
        resourceId: 'c1',
      } as any);

    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 10 },
      { contractId: 'c1', eventId: 'e2', ledger: 12 }, // gap at 11
    ]);
    const pool = makePool(store);

    await checkReplayIntegrity(pool, 'c1', 10, 12);

    expect(auditMock).toHaveBeenCalledWith(
      'REPLAY_INTEGRITY_ISSUE',
      'contract_events',
      'c1',
      undefined,
      expect.objectContaining({
        gapCount: 1,
        duplicateCount: 0,
        ledgerRange: { from: 10, to: 12 },
        gaps: [11],
      }),
    );
  });

  it('does NOT write an audit entry on clean pass', async () => {
    const auditMock = vi
      .spyOn(await import('../../src/lib/auditLog.js'), 'recordAuditEventToDb')
      .mockResolvedValue({
        seq: 1,
        timestamp: new Date().toISOString(),
        action: 'REPLAY_INTEGRITY_ISSUE',
        resourceType: 'contract_events',
        resourceId: 'c1',
      } as any);

    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 10 },
      { contractId: 'c1', eventId: 'e2', ledger: 11 },
    ]);
    const pool = makePool(store);

    await checkReplayIntegrity(pool, 'c1', 10, 11);

    expect(auditMock).not.toHaveBeenCalled();
  });

  it('does not throw when audit writing fails', async () => {
    const auditMock = vi
      .spyOn(await import('../../src/lib/auditLog.js'), 'recordAuditEventToDb')
      .mockRejectedValue(new Error('audit DB error'));

    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 10 },
      { contractId: 'c1', eventId: 'e2', ledger: 12 }, // gap at 11
    ]);
    const pool = makePool(store);

    // Should not throw despite audit failure
    const result = await checkReplayIntegrity(pool, 'c1', 10, 12);
    expect(result.hasIssues).toBe(true);
    expect(result.gaps).toEqual([11]);
  });
});

// ── Prometheus counter increment ──────────────────────────────────────────────

describe('checkReplayIntegrity — Prometheus counters', () => {
  it('increments gap counter when gaps are found', async () => {
    const { indexerReplayIntegrityGapsTotal } = await import(
      '../../src/metrics/indexerMetrics.js'
    );

    const before =
      (await indexerReplayIntegrityGapsTotal.get()).values
        .find((v: { labels: { contract_id?: string } }) => v.labels?.contract_id === 'c1')
        ?.value ?? 0;

    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 10 },
      { contractId: 'c1', eventId: 'e2', ledger: 12 },
    ]);
    const pool = makePool(store);

    // Suppress audit DB write for this test
    vi.spyOn(await import('../../src/lib/auditLog.js'), 'recordAuditEventToDb').mockResolvedValue(
      {} as any,
    );

    await checkReplayIntegrity(pool, 'c1', 10, 12);

    const after =
      (await indexerReplayIntegrityGapsTotal.get()).values
        .find((v: { labels: { contract_id?: string } }) => v.labels?.contract_id === 'c1')
        ?.value ?? 0;

    // 1 gap (ledger 11)
    expect(after - before).toBe(1);
  });

  it('increments duplicate counter when duplicates are found', async () => {
    const { indexerReplayIntegrityDuplicatesTotal } = await import(
      '../../src/metrics/indexerMetrics.js'
    );

    const before =
      (await indexerReplayIntegrityDuplicatesTotal.get()).values
        .find((v: { labels: { contract_id?: string } }) => v.labels?.contract_id === 'c1')
        ?.value ?? 0;

    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'dup', ledger: 10 },
      { contractId: 'c1', eventId: 'dup', ledger: 10 },
    ]);
    const pool = makePool(store);

    // Suppress audit DB write for this test
    vi      .spyOn(await import('../../src/lib/auditLog.js'), 'recordAuditEventToDb').mockResolvedValue(
      {} as any,
    );

    await checkReplayIntegrity(pool, 'c1', 10, 10);

    const after =
      (await indexerReplayIntegrityDuplicatesTotal.get()).values
        .find((v: { labels: { contract_id?: string } }) => v.labels?.contract_id === 'c1')
        ?.value ?? 0;

    expect(after - before).toBe(1);
  });

  it('does NOT increment counters on clean pass', async () => {
    const { indexerReplayIntegrityGapsTotal, indexerReplayIntegrityDuplicatesTotal } = await import(
      '../../src/metrics/indexerMetrics.js'
    );

    const gapsBefore =
      (await indexerReplayIntegrityGapsTotal.get()).values.reduce(
        (sum, v) => sum + v.value,
        0,
      );
    const dupsBefore =
      (await indexerReplayIntegrityDuplicatesTotal.get()).values.reduce(
        (sum, v) => sum + v.value,
        0,
      );

    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 10 },
      { contractId: 'c1', eventId: 'e2', ledger: 11 },
    ]);
    const pool = makePool(store);

    await checkReplayIntegrity(pool, 'c1', 10, 11);

    const gapsAfter =
      (await indexerReplayIntegrityGapsTotal.get()).values.reduce(
        (sum, v) => sum + v.value,
        0,
      );
    const dupsAfter =
      (await indexerReplayIntegrityDuplicatesTotal.get()).values.reduce(
        (sum, v) => sum + v.value,
        0,
      );

    expect(gapsAfter - gapsBefore).toBe(0);
    expect(dupsAfter - dupsBefore).toBe(0);
  });
});

// ── Large gap range ───────────────────────────────────────────────────────────

describe('checkReplayIntegrity — large gap range', () => {
  it('detects many consecutive gaps', async () => {
    const store = makeInMemoryStore([
      { contractId: 'c1', eventId: 'e1', ledger: 1 },
      { contractId: 'c1', eventId: 'e2', ledger: 100 },
    ]);
    const pool = makePool(store);

    // Suppress audit DB write
    vi      .spyOn(await import('../../src/lib/auditLog.js'), 'recordAuditEventToDb').mockResolvedValue(
      {} as any,
    );

    const result = await checkReplayIntegrity(pool, 'c1', 1, 100);
    expect(result.hasIssues).toBe(true);
    expect(result.gaps).toHaveLength(98); // ledgers 2..99
    expect(result.gaps[0]).toBe(2);
    expect(result.gaps[result.gaps.length - 1]).toBe(99);
  });
});

// ── Contract ID slicing for metric labels ─────────────────────────────────────

describe('checkReplayIntegrity — contract_id label safety', () => {
  it('truncates contract_id to 64 chars for metric labels', async () => {
    const longId = 'c'.repeat(128);
    const store = makeInMemoryStore([
      { contractId: longId, eventId: 'e1', ledger: 10 },
      { contractId: longId, eventId: 'e2', ledger: 12 }, // gap at 11
    ]);
    const pool = makePool(store);

    // Suppress audit DB write
    vi.spyOn(await import('../../src/lib/auditLog.js'), 'recordAuditEventToDb').mockResolvedValue(
      {} as any,
    );

    const { indexerReplayIntegrityGapsTotal } = await import(
      '../../src/metrics/indexerMetrics.js'
    );

    await checkReplayIntegrity(pool, longId, 10, 12);

    // The metric should be registered with truncated ID
    const metricValue = (await indexerReplayIntegrityGapsTotal.get()).values.find(
      (v) => v.labels.contract_id === longId.slice(0, 64),
    );
    expect(metricValue).toBeDefined();
    expect(metricValue!.value).toBe(1);
  });
});

// ── Integration with IndexerService ───────────────────────────────────────────

describe('checkReplayIntegrity — IndexerService integration', () => {
  it('is called after replayEvents completes', async () => {
    const { IndexerService } = await import('../../src/indexer/service.js');
    const integritySpy = vi
      .spyOn(IndexerService.prototype as any, 'runPostReplayIntegrityCheck')
      .mockResolvedValue(undefined);

    // Mock the DB to return 2 events so the replay loop runs
    const cursorClient = makeClientImpl(async (sql) => {
      if (sql.includes('COUNT')) return { rows: [{ count: '2' }] };
      return { rows: [] };
    });
    const batchClient = makeClientImpl(async (sql) => {
      if (sql.includes('FROM historical_events')) {
        return { rows: [{ event_id: 'e1' }, { event_id: 'e2' }] };
      }
      return { rows: [] };
    });
    const completeClient = makeClientImpl();

    const cursorRepo = makeCursorRepoImpl();
    const pool = makePoolImpl(cursorClient, batchClient, completeClient);
    const svc = new IndexerService(pool, 2, 0, 0, cursorRepo);

    await svc.replayEvents({ contract_id: 'test-contract', ledger: 1 });

    expect(integritySpy).toHaveBeenCalledWith(
      expect.objectContaining({ contract_id: 'test-contract', ledger: 1 }),
    );
  });
});

// ── Minimal helpers (inline to avoid import complexity) ──────────────────────

function makeClientImpl(
  queryImpl?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>,
): pg.PoolClient {
  return {
    query: vi.fn().mockImplementation(
      queryImpl ??
        (() => Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] })),
    ),
    release: vi.fn(),
  } as unknown as pg.PoolClient;
}

function makePoolImpl(...clients: pg.PoolClient[]): pg.Pool {
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

function makeCursorRepoImpl(overrides: Record<string, unknown> = {}): any {
  const defaultCursor = {
    id: 'cursor-int-001',
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
    create: vi.fn(async (_c: any, _cid: string, _ledger: number) => ({ ...defaultCursor })),
    advanceOffset: vi.fn(async () => {}),
    markCompleted: vi.fn(async () => {}),
    ...overrides,
  };
}
