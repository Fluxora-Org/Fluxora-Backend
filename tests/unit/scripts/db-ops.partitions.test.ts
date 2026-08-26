/**
 * tests/unit/scripts/db-ops.partitions.test.ts
 *
 * Regression tests for issue #818:
 *   dropOldPartitions() used /TO \\('([^']+)'\\)/ which matched a literal
 *   backslash followed by a parenthesis — not found in real pg_get_expr output.
 *   The fix changes the regex to /TO \('([^']+)'\)/ so it correctly matches
 *   literal parentheses in PostgreSQL partition bound strings.
 *
 * Test categories:
 *   1. Unit – regex extraction from realistic pg_get_expr fixtures
 *   2. Fixture-driven – dropOldPartitions classifies partitions as
 *      expired/retained correctly across many realistic bound strings
 *   3. Dry-run vs live-run behaviour
 *   4. Edge cases (DEFAULT partition, unparseable bound, future partition)
 *   5. Regression – the old (broken) regex must NOT match real pg_get_expr
 *      output, confirming the bug existed and the fix resolves it
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dropOldPartitions } from '../../../src/scripts/db-ops.js';
import type { Pool, QueryResult } from 'pg';

// ── Fixture: exact pg_get_expr output strings ────────────────────────────────

/**
 * These are the literal strings PostgreSQL returns from
 * pg_get_expr(c.relpartbound, c.oid) for a range-partitioned table.
 * The parentheses are NOT preceded by a backslash.
 */
const PG_BOUND_JAN_2023 =
  "FOR VALUES FROM ('2023-01-01 00:00:00+00') TO ('2023-02-01 00:00:00+00')";
const PG_BOUND_FEB_2023 =
  "FOR VALUES FROM ('2023-02-01 00:00:00+00') TO ('2023-03-01 00:00:00+00')";
const PG_BOUND_YEAR_2020 =
  "FOR VALUES FROM ('2020-01-01 00:00:00+00') TO ('2020-02-01 00:00:00+00')";
const PG_BOUND_FUTURE =
  "FOR VALUES FROM ('2050-01-01 00:00:00+00') TO ('2050-02-01 00:00:00+00')";
const PG_BOUND_NO_TZ =
  "FOR VALUES FROM ('2023-06-01') TO ('2023-07-01')";
const PG_BOUND_ISO_Z =
  "FOR VALUES FROM ('2023-06-01T00:00:00Z') TO ('2023-07-01T00:00:00Z')";

// ── 1. Unit: regex extraction ─────────────────────────────────────────────────

describe('dropOldPartitions – regex extraction from pg_get_expr output', () => {
  /**
   * This test directly validates the regex fix.
   * The BROKEN regex was: /TO \\('([^']+)'\\)/
   *   In a JS regex literal every \\ is a single literal backslash.
   *   So the regex searched for:  TO \(  followed by a quote, which
   *   doesn't exist in real Postgres output.
   *
   * The FIXED regex is: /TO \('([^']+)'\)/
   *   Each \( / \) is an escaped paren metachar — matching a literal ( ).
   */

  it('regression: the BROKEN regex does NOT match real pg_get_expr output', () => {
    // This test documents the bug: if someone restores the old regex it will fail.
    const brokenRegex = /TO \\('([^']+)'\\)/;
    const match = PG_BOUND_JAN_2023.match(brokenRegex);
    expect(match).toBeNull();
  });

  it('the FIXED regex matches the exact pg_get_expr output string from the issue', () => {
    // Exact fixture from the issue description
    const fixture =
      "FOR VALUES FROM ('2023-01-01 00:00:00+00') TO ('2023-02-01 00:00:00+00')";
    const fixedRegex = /TO \('([^']+)'\)/;
    const match = fixture.match(fixedRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2023-02-01 00:00:00+00');
  });

  it('extracts upper bound from Jan-2023 partition', () => {
    const fixedRegex = /TO \('([^']+)'\)/;
    const match = PG_BOUND_JAN_2023.match(fixedRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2023-02-01 00:00:00+00');
    expect(new Date(match![1]).toISOString()).toBe('2023-02-01T00:00:00.000Z');
  });

  it('extracts upper bound from Feb-2023 partition', () => {
    const fixedRegex = /TO \('([^']+)'\)/;
    const match = PG_BOUND_FEB_2023.match(fixedRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2023-03-01 00:00:00+00');
  });

  it('extracts upper bound from 2020 (old) partition', () => {
    const fixedRegex = /TO \('([^']+)'\)/;
    const match = PG_BOUND_YEAR_2020.match(fixedRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2020-02-01 00:00:00+00');
  });

  it('extracts upper bound from future partition', () => {
    const fixedRegex = /TO \('([^']+)'\)/;
    const match = PG_BOUND_FUTURE.match(fixedRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2050-02-01 00:00:00+00');
  });

  it('extracts upper bound when bound has no timezone suffix', () => {
    const fixedRegex = /TO \('([^']+)'\)/;
    const match = PG_BOUND_NO_TZ.match(fixedRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2023-07-01');
  });

  it('extracts upper bound when bound uses ISO Z suffix', () => {
    const fixedRegex = /TO \('([^']+)'\)/;
    const match = PG_BOUND_ISO_Z.match(fixedRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2023-07-01T00:00:00Z');
  });

  it('does not match DEFAULT partition bound', () => {
    const fixedRegex = /TO \('([^']+)'\)/;
    expect('DEFAULT'.match(fixedRegex)).toBeNull();
  });
});

// ── Helper: build a fake pg Pool ─────────────────────────────────────────────

type FakeRow = { partition_name: string; partition_bound: string };

function makeFakePool(rows: FakeRow[]) {
  return {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      // The SELECT returns all rows; DROP TABLE returns an empty result
      if (/^SELECT/i.test(sql.trim())) {
        return { rows } as unknown as QueryResult;
      }
      return { rows: [] } as unknown as QueryResult;
    }),
  } as unknown as Pool;
}

// ── 2. Fixture-driven: expiry classification ─────────────────────────────────

describe('dropOldPartitions – fixture-driven expiry classification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Lock "now" to 2026-07-26 to make all comparisons deterministic
    vi.setSystemTime(new Date('2026-07-26T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('identifies OLD partition (upper bound Jan 2023) as expired with olderThanDays=30 (dry run)', async () => {
    const pool = makeFakePool([
      { partition_name: 'contract_events_2023_01', partition_bound: PG_BOUND_JAN_2023 },
    ]);

    const result = await dropOldPartitions(pool, 'contract_events', 30, true);

    expect(result.droppedPartitions).toContain('contract_events_2023_01');
    expect(result.message).toContain('[DRY RUN]');
    expect(result.message).toContain('1');
  });

  it('does NOT identify FUTURE partition (2050) as expired', async () => {
    const pool = makeFakePool([
      { partition_name: 'contract_events_2050_01', partition_bound: PG_BOUND_FUTURE },
    ]);

    const result = await dropOldPartitions(pool, 'contract_events', 30, true);

    expect(result.droppedPartitions).not.toContain('contract_events_2050_01');
    expect(result.droppedPartitions).toHaveLength(0);
  });

  it('skips DEFAULT partition entirely', async () => {
    const pool = makeFakePool([
      { partition_name: 'contract_events_default', partition_bound: 'DEFAULT' },
    ]);

    const result = await dropOldPartitions(pool, 'contract_events', 30, true);

    expect(result.droppedPartitions).not.toContain('contract_events_default');
    expect(result.droppedPartitions).toHaveLength(0);
  });

  it('correctly classifies a mixed set of partitions', async () => {
    const pool = makeFakePool([
      { partition_name: 'contract_events_default', partition_bound: 'DEFAULT' },
      {
        partition_name: 'contract_events_2020_01',
        partition_bound: PG_BOUND_YEAR_2020,
      },
      {
        partition_name: 'contract_events_2023_01',
        partition_bound: PG_BOUND_JAN_2023,
      },
      {
        partition_name: 'contract_events_2023_02',
        partition_bound: PG_BOUND_FEB_2023,
      },
      {
        partition_name: 'contract_events_2050_01',
        partition_bound: PG_BOUND_FUTURE,
      },
    ]);

    const result = await dropOldPartitions(pool, 'contract_events', 30, true);

    // Old partitions (upper bound well in the past) must be dropped
    expect(result.droppedPartitions).toContain('contract_events_2020_01');
    expect(result.droppedPartitions).toContain('contract_events_2023_01');
    expect(result.droppedPartitions).toContain('contract_events_2023_02');

    // DEFAULT and future partition must NOT be dropped
    expect(result.droppedPartitions).not.toContain('contract_events_default');
    expect(result.droppedPartitions).not.toContain('contract_events_2050_01');
  });

  it('dry-run mode reports a non-zero droppedPartitions count for genuinely old partitions', async () => {
    const pool = makeFakePool([
      {
        partition_name: 'contract_events_2020_01',
        partition_bound: PG_BOUND_YEAR_2020,
      },
      {
        partition_name: 'contract_events_2023_01',
        partition_bound: PG_BOUND_JAN_2023,
      },
    ]);

    const result = await dropOldPartitions(pool, 'contract_events', 30, true);

    // Acceptance criterion: dry-run reports non-zero count for old partitions
    expect(result.droppedPartitions.length).toBeGreaterThan(0);
    expect(result.message).toContain('[DRY RUN]');
  });

  it('live-run executes DROP TABLE for each expired partition', async () => {
    const pool = makeFakePool([
      {
        partition_name: 'contract_events_2020_01',
        partition_bound: PG_BOUND_YEAR_2020,
      },
      {
        partition_name: 'contract_events_2050_01',
        partition_bound: PG_BOUND_FUTURE,
      },
    ]);

    const result = await dropOldPartitions(pool, 'contract_events', 30, false);

    expect(result.droppedPartitions).toContain('contract_events_2020_01');
    expect(result.droppedPartitions).not.toContain('contract_events_2050_01');
    expect(result.message).not.toContain('[DRY RUN]');

    // The pool should have been called once for SELECT and once for DROP
    const queryCalls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, ...unknown[]][];
    const dropCalls = queryCalls.filter(([sql]) => /DROP/i.test(sql));
    expect(dropCalls).toHaveLength(1);
    expect(dropCalls[0][0]).toMatch(/contract_events_2020_01/);
  });

  it('dry-run does NOT execute any DROP TABLE statements', async () => {
    const pool = makeFakePool([
      {
        partition_name: 'contract_events_2020_01',
        partition_bound: PG_BOUND_YEAR_2020,
      },
    ]);

    await dropOldPartitions(pool, 'contract_events', 30, true);

    const queryCalls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, ...unknown[]][];
    const dropCalls = queryCalls.filter(([sql]) => /DROP/i.test(sql));
    expect(dropCalls).toHaveLength(0);
  });

  it('returns empty droppedPartitions when all partitions are recent', async () => {
    // Upper bound is 2050 — not older than 30 days
    const pool = makeFakePool([
      { partition_name: 'contract_events_2050_01', partition_bound: PG_BOUND_FUTURE },
    ]);

    const result = await dropOldPartitions(pool, 'contract_events', 30, true);

    expect(result.droppedPartitions).toHaveLength(0);
    expect(result.message).toContain('0');
  });

  it('returns empty droppedPartitions when rows are empty', async () => {
    const pool = makeFakePool([]);

    const result = await dropOldPartitions(pool, 'contract_events', 30, true);

    expect(result.droppedPartitions).toHaveLength(0);
  });

  it('skips a partition with an unparseable bound string', async () => {
    const pool = makeFakePool([
      {
        partition_name: 'contract_events_weird',
        partition_bound: 'FOR VALUES IN (1, 2, 3)', // list partition, not range
      },
    ]);

    const result = await dropOldPartitions(pool, 'contract_events', 30, true);

    expect(result.droppedPartitions).not.toContain('contract_events_weird');
  });

  it('uses the correct parent table name when querying partitions', async () => {
    const pool = makeFakePool([]);

    await dropOldPartitions(pool, 'my_custom_table', 30, true);

    const queryCalls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
    const selectCall = queryCalls.find(([sql]) => /SELECT/i.test(sql));
    expect(selectCall).toBeDefined();
    expect(selectCall![1]).toContain('my_custom_table');
  });

  it('live-run message does not include [DRY RUN]', async () => {
    const pool = makeFakePool([
      {
        partition_name: 'contract_events_2020_01',
        partition_bound: PG_BOUND_YEAR_2020,
      },
    ]);

    const result = await dropOldPartitions(pool, 'contract_events', 30, false);

    expect(result.message).not.toContain('[DRY RUN]');
    expect(result.message).toContain('contract_events');
  });
});

// ── 3. Input validation ──────────────────────────────────────────────────────

describe('dropOldPartitions – input validation', () => {
  it('rejects empty parentTable with explanatory message', async () => {
    const pool = makeFakePool([]);
    const result = await dropOldPartitions(pool, '', 30, true);
    expect(result.droppedPartitions).toHaveLength(0);
    expect(result.message).toContain('parentTable is required');
  });

  it('rejects negative olderThanDays', async () => {
    const pool = makeFakePool([]);
    const result = await dropOldPartitions(pool, 't', -1, true);
    expect(result.message).toContain('non-negative');
  });

  it('rejects NaN olderThanDays', async () => {
    const pool = makeFakePool([]);
    const result = await dropOldPartitions(pool, 't', NaN, true);
    expect(result.message).toContain('non-negative');
  });

  it('rejects Infinity olderThanDays', async () => {
    const pool = makeFakePool([]);
    const result = await dropOldPartitions(pool, 't', Infinity, true);
    expect(result.message).toContain('non-negative');
  });

  it('accepts olderThanDays = 0', async () => {
    const pool = makeFakePool([
      { partition_name: 'ce_old', partition_bound: PG_BOUND_YEAR_2020 },
    ]);
    const result = await dropOldPartitions(pool, 't', 0, true);
    expect(result.droppedPartitions).toContain('ce_old');
  });

  it('returns graceful message on pool.query rejection', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as Pool;
    const result = await dropOldPartitions(pool, 'contract_events', 30, true);
    expect(result.droppedPartitions).toHaveLength(0);
    expect(result.message).toContain('Failed to query partitions');
    expect(result.message).toContain('ECONNREFUSED');
  });

  it('does not call pool.query when validation fails', async () => {
    const pool = { query: vi.fn() } as unknown as Pool;
    await dropOldPartitions(pool, '', 30, true);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ── 4. Integration-style: realistic multi-month partition scenario ────────────

describe('dropOldPartitions – realistic multi-month partition scenario', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Simulate a table with partitions spanning 2025-2026.
   * With olderThanDays = 90 and "now" = 2026-07-26, the cutoff is 2026-04-27.
   * A partition is dropped when its UPPER bound is strictly before the cutoff.
   *
   * Partition upper bounds (what the code checks):
   *   ce_2025_10: upper = 2025-11-01 → before 2026-04-27 → DROP
   *   ce_2025_11: upper = 2025-12-01 → before 2026-04-27 → DROP
   *   ce_2025_12: upper = 2026-01-01 → before 2026-04-27 → DROP
   *   ce_2026_01: upper = 2026-02-01 → before 2026-04-27 → DROP
   *   ce_2026_02: upper = 2026-03-01 → before 2026-04-27 → DROP
   *   ce_2026_04: upper = 2026-05-01 → after  2026-04-27 → KEEP
   *   ce_2026_06: upper = 2026-07-01 → within 90 days    → KEEP
   *   ce_2026_08: upper = 2026-09-01 → future            → KEEP
   *   ce_default: DEFAULT                                 → KEEP (always skipped)
   */
  const multiMonthFixture: FakeRow[] = [
    {
      partition_name: 'ce_2025_10',
      partition_bound:
        "FOR VALUES FROM ('2025-10-01 00:00:00+00') TO ('2025-11-01 00:00:00+00')",
    },
    {
      partition_name: 'ce_2025_11',
      partition_bound:
        "FOR VALUES FROM ('2025-11-01 00:00:00+00') TO ('2025-12-01 00:00:00+00')",
    },
    {
      partition_name: 'ce_2025_12',
      partition_bound:
        "FOR VALUES FROM ('2025-12-01 00:00:00+00') TO ('2026-01-01 00:00:00+00')",
    },
    {
      partition_name: 'ce_2026_01',
      partition_bound:
        "FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00')",
    },
    {
      partition_name: 'ce_2026_02',
      partition_bound:
        "FOR VALUES FROM ('2026-02-01 00:00:00+00') TO ('2026-03-01 00:00:00+00')",
    },
    {
      partition_name: 'ce_2026_04',
      partition_bound:
        "FOR VALUES FROM ('2026-04-01 00:00:00+00') TO ('2026-05-01 00:00:00+00')",
    },
    {
      partition_name: 'ce_2026_06',
      partition_bound:
        "FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00')",
    },
    {
      partition_name: 'ce_2026_08',
      partition_bound:
        "FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00')",
    },
    {
      partition_name: 'ce_default',
      partition_bound: 'DEFAULT',
    },
  ];

  it('drops all partitions older than 90 days and keeps recent/future ones (dry run)', async () => {
    const pool = makeFakePool(multiMonthFixture);

    const result = await dropOldPartitions(pool, 'contract_events', 90, true);

    // These have upper bounds well before the 2026-04-27 cutoff
    expect(result.droppedPartitions).toContain('ce_2025_10');
    expect(result.droppedPartitions).toContain('ce_2025_11');
    expect(result.droppedPartitions).toContain('ce_2025_12');
    expect(result.droppedPartitions).toContain('ce_2026_01');
    expect(result.droppedPartitions).toContain('ce_2026_02');

    // ce_2026_04 has upper bound 2026-05-01 which is AFTER the 2026-04-27 cutoff → KEEP
    expect(result.droppedPartitions).not.toContain('ce_2026_04');

    // Upper bound 2026-07-01 is within 90 days of 2026-07-26
    expect(result.droppedPartitions).not.toContain('ce_2026_06');
    // Future
    expect(result.droppedPartitions).not.toContain('ce_2026_08');
    // DEFAULT always skipped
    expect(result.droppedPartitions).not.toContain('ce_default');
  });

  it('live run executes DROP TABLE for each expired partition in the scenario', async () => {
    const pool = makeFakePool(multiMonthFixture);

    const result = await dropOldPartitions(pool, 'contract_events', 90, false);

    const queryCalls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, ...unknown[]][];
    const dropCalls = queryCalls.filter(([sql]) => /DROP/i.test(sql));

    expect(dropCalls).toHaveLength(result.droppedPartitions.length);

    // Verify each dropped partition had a corresponding DROP call
    for (const partitionName of result.droppedPartitions) {
      const hasDropCall = dropCalls.some(([sql]) => sql.includes(partitionName));
      expect(hasDropCall, `Expected DROP call for ${partitionName}`).toBe(true);
    }
  });

  it('with olderThanDays=30, only keeps partitions with upper bound within last 30 days', async () => {
    const pool = makeFakePool(multiMonthFixture);

    const result = await dropOldPartitions(pool, 'contract_events', 30, true);

    // 2026-07-01 is within 30 days of 2026-07-26 → kept
    expect(result.droppedPartitions).not.toContain('ce_2026_06');
    // 2026-09-01 is in the future → kept
    expect(result.droppedPartitions).not.toContain('ce_2026_08');

    // Everything with upper bound before 2026-06-26 should be dropped
    expect(result.droppedPartitions).toContain('ce_2025_10');
    expect(result.droppedPartitions).toContain('ce_2025_11');
    expect(result.droppedPartitions).toContain('ce_2025_12');
    expect(result.droppedPartitions).toContain('ce_2026_01');
    expect(result.droppedPartitions).toContain('ce_2026_02');
    expect(result.droppedPartitions).toContain('ce_2026_04');
  });
});
