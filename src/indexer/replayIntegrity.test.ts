import { beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

const { loggerMock, recordAuditEventToDbMock, gapsTotalMock, duplicatesTotalMock } = vi.hoisted(
  () => ({
    loggerMock: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    recordAuditEventToDbMock: vi.fn(),
    gapsTotalMock: { inc: vi.fn() },
    duplicatesTotalMock: { inc: vi.fn() },
  })
);

vi.mock('../lib/logger.js', () => ({ logger: loggerMock }));
vi.mock('../lib/auditLog.js', () => ({ recordAuditEventToDb: recordAuditEventToDbMock }));
vi.mock('../metrics/indexerMetrics.js', () => ({
  indexerReplayIntegrityGapsTotal: gapsTotalMock,
  indexerReplayIntegrityDuplicatesTotal: duplicatesTotalMock,
}));

import { checkReplayIntegrity, MAX_INTEGRITY_RANGE, __QUERIES } from './replayIntegrity.js';

// ── Fake pool helpers ──────────────────────────────────────────────────────────────────────────────

type QueryKind = 'range' | 'gap' | 'dup';

function classify(sql: string): QueryKind {
  if (sql.includes('MIN(ledger)')) return 'range';
  if (sql.includes('generate_series')) return 'gap';
  if (sql.includes('HAVING COUNT(*) > 1')) return 'dup';
  throw new Error(`unexpected query passed to fake pool: ${sql.slice(0, 60)}`);
}

interface Route {
  /** Rows returned when the route does not fail. */
  rows?: (params: unknown[]) => Record<string, unknown>[];
  /** Fail the first N attempts for this query kind. */
  failTimes?: number;
  /** Fail every attempt for this query kind. */
  alwaysFail?: boolean;
  /** Fail only for chunk bounds matching these bounds. */
  failFromLedger?: number;
  /** Value the query rejects with. */
  error?: unknown;
}

interface PoolCall {
  kind: QueryKind;
  params: unknown[];
}

function createPool(routes: Partial<Record<QueryKind, Route>> = {}) {
  const calls: PoolCall[] = [];
  const attempts: Record<QueryKind, number> = { range: 0, gap: 0, dup: 0 };

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const kind = classify(sql);
    calls.push({ kind, params });
    attempts[kind] += 1;

    const route = routes[kind];
    if (route) {
      const chunkFail =
        route.failFromLedger !== undefined &&
        Number(kind === 'gap' ? params[0] : params[1]) === route.failFromLedger;
      const fail =
        route.alwaysFail === true ||
        (route.failTimes !== undefined && attempts[kind] <= route.failTimes) ||
        chunkFail;
      if (fail) throw route.error ?? new Error(`${kind} query failed`);
      if (route.rows) return { rows: route.rows(params) };
    }
    return { rows: [] };
  });

  return { pool: { query } as unknown as pg.Pool, query, calls, attempts };
}

function rangeRows(min: number | null, max: number | null) {
  return () => [{ min_ledger: min, max_ledger: max }];
}

function gapRows(gaps: number[]) {
  return () => gaps.map((ledger) => ({ gap_ledger: ledger }));
}

function dupRows(dups: Array<{ eventId: string; ledger: number; count: number }>) {
  return () =>
    dups.map((d) => ({ event_id: d.eventId, ledger: d.ledger, occurrence_count: d.count }));
}

function ofKind(calls: PoolCall[], kind: QueryKind): unknown[][] {
  return calls.filter((c) => c.kind === kind).map((c) => c.params);
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAuditEventToDbMock.mockResolvedValue(undefined);
});

// ── Normal path ────────────────────────────────────────────────────────────────────────────────────

describe('checkReplayIntegrity — normal path', () => {
  it('returns a clean result for a contiguous, duplicate-free sequence', async () => {
    const { pool, calls } = createPool({
      range: { rows: rangeRows(10, 20) },
      gap: { rows: gapRows([]) },
      dup: { rows: dupRows([]) },
    });

    const result = await checkReplayIntegrity(pool, 'contract-clean', 10, 20);

    expect(result).toEqual({
      hasIssues: false,
      gaps: [],
      duplicates: [],
      checkedRange: { fromLedger: 10, toLedger: 20 },
      contractId: 'contract-clean',
      error: undefined,
    });
    expect(result.error).toBeUndefined();

    // Both checks are scoped to the requested contract and range.
    expect(ofKind(calls, 'range')).toEqual([['contract-clean', 10, 20]]);
    expect(ofKind(calls, 'gap')).toEqual([[10, 20, 'contract-clean']]);
    expect(ofKind(calls, 'dup')).toEqual([['contract-clean', 10, 20]]);

    // Clean pass must stay silent: no audit, no metrics, no warning.
    expect(recordAuditEventToDbMock).not.toHaveBeenCalled();
    expect(gapsTotalMock.inc).not.toHaveBeenCalled();
    expect(duplicatesTotalMock.inc).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      'replay_integrity_issues_detected',
      expect.anything(),
      expect.anything()
    );
  });

  it('detects gaps and duplicates and records audit, metrics and a structured log', async () => {
    const { pool } = createPool({
      range: { rows: rangeRows(100, 110) },
      gap: { rows: gapRows([103, 107]) },
      dup: { rows: dupRows([{ eventId: 'evt-1', ledger: 105, count: 2 }]) },
    });

    const result = await checkReplayIntegrity(pool, 'contract-a', 100, 110);

    expect(result.hasIssues).toBe(true);
    expect(result.gaps).toEqual([103, 107]);
    expect(result.duplicates).toEqual([{ eventId: 'evt-1', ledger: 105, count: 2 }]);
    expect(result.checkedRange).toEqual({ fromLedger: 100, toLedger: 110 });
    expect(result.contractId).toBe('contract-a');

    // Structured audit entry.
    expect(recordAuditEventToDbMock).toHaveBeenCalledTimes(1);
    expect(recordAuditEventToDbMock).toHaveBeenCalledWith(
      'REPLAY_INTEGRITY_ISSUE',
      'contract_events',
      'contract-a',
      undefined,
      {
        gapCount: 2,
        duplicateCount: 1,
        ledgerRange: { from: 100, to: 110 },
        gaps: [103, 107],
        duplicates: [{ eventId: 'evt-1', ledger: 105 }],
      }
    );

    // Prometheus counters, one increment per issue type.
    expect(gapsTotalMock.inc).toHaveBeenCalledTimes(1);
    expect(gapsTotalMock.inc).toHaveBeenCalledWith({ contract_id: 'contract-a' }, 2);
    expect(duplicatesTotalMock.inc).toHaveBeenCalledTimes(1);
    expect(duplicatesTotalMock.inc).toHaveBeenCalledWith({ contract_id: 'contract-a' }, 1);

    // Structured warning.
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'replay_integrity_issues_detected',
      undefined,
      expect.objectContaining({
        event: 'replay_integrity_issues_detected',
        contractId: 'contract-a',
        gapCount: 2,
        duplicateCount: 1,
        ledgerRange: { from: 100, to: 110 },
        gaps: '103, 107',
        duplicates: ['2x evt-1@105'],
      })
    );
  });

  it('sorts gaps and duplicates deterministically regardless of row order', async () => {
    const { pool } = createPool({
      range: { rows: rangeRows(1, 20) },
      gap: { rows: gapRows([17, 3, 9]) },
      dup: {
        rows: dupRows([
          { eventId: 'b-event', ledger: 15, count: 2 },
          { eventId: 'a-event', ledger: 15, count: 3 },
          { eventId: 'z-event', ledger: 4, count: 2 },
        ]),
      },
    });

    const result = await checkReplayIntegrity(pool, 'contract-sort', 1, 20);

    expect(result.gaps).toEqual([3, 9, 17]);
    expect(result.duplicates).toEqual([
      { eventId: 'z-event', ledger: 4, count: 2 },
      { eventId: 'a-event', ledger: 15, count: 3 },
      { eventId: 'b-event', ledger: 15, count: 2 },
    ]);
  });

  it('caps audit payloads for very large issue lists while reporting full results', async () => {
    const gaps = Array.from({ length: 150 }, (_, i) => i + 1);
    const duplicates = Array.from({ length: 60 }, (_, i) => ({
      eventId: `evt-${String(i).padStart(3, '0')}`,
      ledger: 1_000 + i,
      count: 2,
    }));
    const { pool } = createPool({
      range: { rows: rangeRows(1, 1_100) },
      gap: { rows: gapRows(gaps) },
      dup: { rows: dupRows(duplicates) },
    });

    const result = await checkReplayIntegrity(pool, 'contract-big', 1, 1_100);

    expect(result.gaps).toHaveLength(150);
    expect(result.duplicates).toHaveLength(60);

    const meta = recordAuditEventToDbMock.mock.calls[0][4] as Record<string, unknown>;
    expect(meta.gapCount).toBe(150);
    expect(meta.duplicateCount).toBe(60);
    expect(meta.gaps as number[]).toHaveLength(100);
    expect(meta.duplicates as unknown[]).toHaveLength(50);
  });

  it('keeps audit metadata focused when only one issue type is present', async () => {
    const { pool } = createPool({
      range: { rows: rangeRows(1, 50) },
      gap: { rows: gapRows([7]) },
      dup: { rows: dupRows([]) },
    });

    await checkReplayIntegrity(pool, 'contract-gaps-only', 1, 50);

    const meta = recordAuditEventToDbMock.mock.calls[0][4] as Record<string, unknown>;
    expect(meta.gaps).toEqual([7]);
    expect(meta.duplicates).toBeUndefined();
    expect(duplicatesTotalMock.inc).not.toHaveBeenCalled();
  });

  it('summarises large gap lists in the structured warning', async () => {
    const gaps = Array.from({ length: 30 }, (_, i) => i + 1);
    const { pool } = createPool({
      range: { rows: rangeRows(1, 30) },
      gap: { rows: gapRows(gaps) },
    });

    const result = await checkReplayIntegrity(pool, 'contract-log', 1, 30);

    expect(result.gaps).toHaveLength(30);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'replay_integrity_issues_detected',
      undefined,
      expect.objectContaining({ gaps: expect.stringMatching(/^30 gaps \(first 20: /) })
    );
  });
});

// ── Empty / zero / maximum boundaries ──────────────────────────────────────────────────────────────

describe('checkReplayIntegrity — boundary inputs', () => {
  it('returns an empty result when the range holds no events', async () => {
    const { pool, calls } = createPool({
      range: { rows: rangeRows(null, null) },
    });

    const result = await checkReplayIntegrity(pool, 'contract-empty', 10, 20);

    expect(result).toEqual({
      hasIssues: false,
      gaps: [],
      duplicates: [],
      checkedRange: { fromLedger: 10, toLedger: 20 },
      contractId: 'contract-empty',
      error: undefined,
    });
    // The expensive checks are skipped entirely.
    expect(ofKind(calls, 'gap')).toEqual([]);
    expect(ofKind(calls, 'dup')).toEqual([]);
    expect(recordAuditEventToDbMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('treats an empty rows array from the range query as no events', async () => {
    const { pool } = createPool({ range: { rows: () => [] } });

    const result = await checkReplayIntegrity(pool, 'contract-no-rows', 5, 5);

    expect(result.hasIssues).toBe(false);
    expect(result.checkedRange).toEqual({ fromLedger: 5, toLedger: 5 });
  });

  it('handles a zero ledger range', async () => {
    const { pool, calls } = createPool({ range: { rows: rangeRows(null, null) } });

    const result = await checkReplayIntegrity(pool, 'contract-zero', 0, 0);

    expect(result.checkedRange).toEqual({ fromLedger: 0, toLedger: 0 });
    expect(ofKind(calls, 'range')).toEqual([['contract-zero', 0, 0]]);
  });

  it('normalises an inverted ledger range before querying', async () => {
    const { pool, calls } = createPool({ range: { rows: rangeRows(100, 500) } });

    const result = await checkReplayIntegrity(pool, 'contract-inverted', 500, 100);

    expect(ofKind(calls, 'range')).toEqual([['contract-inverted', 100, 500]]);
    expect(result.checkedRange).toEqual({ fromLedger: 100, toLedger: 500 });
  });

  it('checks a single-ledger range as a one-element sequence', async () => {
    const { pool, calls } = createPool({
      range: { rows: rangeRows(42, 42) },
      gap: { rows: gapRows([]) },
      dup: { rows: dupRows([]) },
    });

    const result = await checkReplayIntegrity(pool, 'contract-single', 42, 42);

    expect(result.hasIssues).toBe(false);
    expect(result.checkedRange).toEqual({ fromLedger: 42, toLedger: 42 });
    expect(ofKind(calls, 'gap')).toEqual([[42, 42, 'contract-single']]);
  });

  it('warns but does not clamp when the requested range exceeds MAX_INTEGRITY_RANGE', async () => {
    const { pool, calls } = createPool({ range: { rows: rangeRows(null, null) } });

    await checkReplayIntegrity(pool, 'contract-huge', 0, MAX_INTEGRITY_RANGE + 1);

    expect(loggerMock.warn).toHaveBeenCalledWith(
      'replay_integrity_large_range',
      undefined,
      expect.objectContaining({
        event: 'replay_integrity_large_range',
        contractId: 'contract-huge',
      })
    );
    // The full requested range reaches the query — nothing is clamped away.
    expect(ofKind(calls, 'range')).toEqual([['contract-huge', 0, MAX_INTEGRITY_RANGE + 1]]);
  });

  it('does not warn when the requested range is exactly MAX_INTEGRITY_RANGE', async () => {
    const { pool } = createPool({ range: { rows: rangeRows(null, null) } });

    await checkReplayIntegrity(pool, 'contract-max', 0, MAX_INTEGRITY_RANGE);

    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      'replay_integrity_large_range',
      expect.anything(),
      expect.anything()
    );
  });
});

// ── Chunking and concurrency ───────────────────────────────────────────────────────────────────────

describe('checkReplayIntegrity — chunking', () => {
  it('splits the resolved ledger range into fixed-size chunks', async () => {
    const { pool, calls } = createPool({
      range: { rows: rangeRows(10_000, 20_000) },
      gap: { rows: gapRows([]) },
      dup: { rows: dupRows([]) },
    });

    await checkReplayIntegrity(pool, 'contract-chunks', 1, 30_000);

    const gapBounds = ofKind(calls, 'gap').map((params) => [params[0], params[1]]);
    const dupBounds = ofKind(calls, 'dup').map((params) => [params[1], params[2]]);
    expect(gapBounds).toEqual([
      [10_000, 19_999],
      [20_000, 20_000],
    ]);
    expect(dupBounds).toEqual([
      [10_000, 19_999],
      [20_000, 20_000],
    ]);
  });

  it('never runs more than MAX_CONCURRENT_CHECKS chunk queries at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pool = {
      query: async (sql: string) => {
        const kind = classify(sql);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return kind === 'range' ? { rows: [{ min_ledger: 1, max_ledger: 110_000 }] } : { rows: [] };
      },
    } as unknown as pg.Pool;

    const result = await checkReplayIntegrity(pool, 'contract-wide', 1, 110_000);

    expect(result.hasIssues).toBe(false);
    // 11 chunks are scheduled, but never more than the concurrency cap at once.
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(__QUERIES.MAX_CONCURRENT_CHECKS);
  });
});

// ── Documented failure modes ───────────────────────────────────────────────────────────────────────

describe('checkReplayIntegrity — failure modes', () => {
  it('never throws when the range query fails and returns the swallowed error', async () => {
    const { pool } = createPool({ range: { alwaysFail: true, error: new Error('db down') } });

    const result = await checkReplayIntegrity(pool, 'contract-db-down', 1, 50);

    expect(result).toEqual({
      hasIssues: false,
      gaps: [],
      duplicates: [],
      checkedRange: { fromLedger: 1, toLedger: 50 },
      contractId: 'contract-db-down',
      error: 'db down',
    });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'replay_integrity_query_failed',
      undefined,
      expect.objectContaining({
        event: 'replay_integrity_query_failed',
        contractId: 'contract-db-down',
        error: 'db down',
      })
    );
    expect(recordAuditEventToDbMock).not.toHaveBeenCalled();
  });

  it('stringifies non-Error rejections from the range query', async () => {
    const { pool } = createPool({ range: { alwaysFail: true, error: 'not-an-error' } });

    const result = await checkReplayIntegrity(pool, 'contract-raw-reject', 1, 10);

    expect(result.error).toBe('not-an-error');
    expect(result.hasIssues).toBe(false);
  });

  it('retries a transient chunk failure and reports the successful retry', async () => {
    const { pool, attempts } = createPool({
      range: { rows: rangeRows(42, 42) },
      gap: { failTimes: 1, rows: gapRows([43]) },
    });

    const result = await checkReplayIntegrity(pool, 'contract-retry', 1, 100);

    expect(result.error).toBeUndefined();
    expect(result.hasIssues).toBe(true);
    expect(result.gaps).toEqual([43]);
    expect(attempts.gap).toBe(2);
  });

  it('returns an error once the chunk retry budget is exhausted', async () => {
    const { pool, attempts } = createPool({
      range: { rows: rangeRows(42, 42) },
      gap: { alwaysFail: true, error: new Error('gap query failed') },
    });

    const result = await checkReplayIntegrity(pool, 'contract-retries', 1, 100);

    expect(result).toMatchObject({
      hasIssues: false,
      gaps: [],
      duplicates: [],
      error: 'gap query failed',
      contractId: 'contract-retries',
    });
    expect(attempts.gap).toBe(__QUERIES.INTEGRITY_RETRY_BUDGET);
    expect(recordAuditEventToDbMock).not.toHaveBeenCalled();
  });

  it('keeps healthy chunk results while surfacing an errored chunk', async () => {
    const { pool, attempts } = createPool({
      range: { rows: rangeRows(1, 20_000) },
      gap: { failFromLedger: 10_001, rows: gapRows([5]) },
    });

    const result = await checkReplayIntegrity(pool, 'contract-partial', 1, 30_000);

    expect(result.gaps).toEqual([5]);
    expect(result.hasIssues).toBe(true);
    expect(result.error).toBe('gap query failed');
    // The healthy chunk succeeded first try; the failing chunk used its whole budget.
    expect(attempts.gap).toBe(1 + __QUERIES.INTEGRITY_RETRY_BUDGET);
    expect(recordAuditEventToDbMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the reported issues when the audit write itself fails', async () => {
    recordAuditEventToDbMock.mockRejectedValueOnce(new Error('audit down'));
    const { pool } = createPool({
      range: { rows: rangeRows(1, 20) },
      gap: { rows: gapRows([9]) },
    });

    const result = await checkReplayIntegrity(pool, 'contract-audit-down', 1, 20);

    expect(result).toMatchObject({ hasIssues: true, gaps: [9] });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'replay_integrity_audit_failed',
      undefined,
      expect.objectContaining({ event: 'replay_integrity_audit_failed', error: 'audit down' })
    );
    // The metric still moves — the audit failure must not swallow the finding.
    expect(gapsTotalMock.inc).toHaveBeenCalledWith({ contract_id: 'contract-audit-down' }, 1);
  });

  it('truncates the contract id used as the metric label', async () => {
    const contractId = 'c'.repeat(80);
    const { pool } = createPool({
      range: { rows: rangeRows(1, 20) },
      gap: { rows: gapRows([3]) },
    });

    const result = await checkReplayIntegrity(pool, contractId, 1, 20);

    expect(result.hasIssues).toBe(true);
    expect(gapsTotalMock.inc).toHaveBeenCalledWith({ contract_id: 'c'.repeat(64) }, 1);
  });
});

// ── Exported test helpers ──────────────────────────────────────────────────────────────────────────

describe('exported constants', () => {
  it('exposes the documented limits', () => {
    expect(MAX_INTEGRITY_RANGE).toBe(100_000);
    expect(__QUERIES.MAX_INTEGRITY_RANGE).toBe(MAX_INTEGRITY_RANGE);
    expect(__QUERIES.MAX_CONCURRENT_CHECKS).toBe(4);
    expect(__QUERIES.INTEGRITY_CHUNK_SIZE).toBe(10_000);
    expect(__QUERIES.INTEGRITY_RETRY_BUDGET).toBe(3);
  });

  it('exposes queries scoped to a contract and ledger range', () => {
    expect(__QUERIES.GAP_QUERY).toContain('generate_series');
    expect(__QUERIES.GAP_QUERY).toContain('contract_id = $3');
    expect(__QUERIES.DUPLICATE_QUERY).toContain('HAVING COUNT(*) > 1');
    expect(__QUERIES.DUPLICATE_QUERY).toContain('contract_id = $1');
    expect(__QUERIES.RANGE_QUERY).toContain('MIN(ledger)');
    expect(__QUERIES.RANGE_QUERY).toContain('contract_id = $1');
  });
});
