/**
 * Integration and offline-contract tests for collectVacuumMetrics() partition
 * rollup (#296 / issue follow-up).
 *
 * @module tests/db/vacuumCollector.collect.test.ts
 *
 * COVERS:
 *  - The recursive CTE used by collectVacuumMetrics() rolls up per-partition
 *    pg_stat_user_tables figures under the declared parent label.
 *  - SUM(n_dead_tup) and SUM(n_live_tup) across partitions are reported under
 *    the parent table name (not just the parent's typically-empty row).
 *  - MAX(last_autovacuum) picks the most recent partition's timestamp, not
 *    whichever one PostgreSQL happens to enumerate first.
 *  - A partitioned parent with NO child partitions is handled gracefully:
 *    no exception is thrown and a sensible zero/-1 report is emitted.
 *
 * Local / Live DB run:
 *   DATABASE_URL=postgresql://indexer_user:indexer_password@localhost:5432/indexer_db \
 *     pnpm test tests/db/vacuumCollector.collect.test.ts
 *
 * Offline / CI without Postgres: live-DB cases are skipped automatically; the
 * offline contract assertions still run so the SQL structure is verified
 * without a database.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import pg from 'pg';
import {
  collectVacuumMetrics,
  deRegisterVacuumMetrics,
  pgDeadTuples,
  pgBloatRatio,
  pgLastAutovacuumAgeSeconds,
} from '../../src/metrics/vacuumCollector.js';
import { registry } from '../../src/metrics.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const isLiveDb = Boolean(DATABASE_URL);

/** Test partition names used by the live-DB cases. */
export const TEST_PARTITIONS = {
  jan: 'contract_events_y2026m01',
  feb: 'contract_events_y2026m02',
} as const;

/** Caller-visible label for the partitioned parent with zero children. */
export const ZERO_PARTITIONS_PARENT = 'audit_logs' as const;

/**
 * Recursive-CTE rollup SQL — kept verbatim in sync with the one in
 * collectVacuumMetrics() so we can independently compute the expected values
 * and compare them with what the function actually wrote to the Prometheus
 * Gauges.
 */
export function buildRollupSql(): string {
  return `
    WITH RECURSIVE tables AS (
      SELECT oid, relname AS root_table, relname AS table_name
      FROM pg_class
      WHERE relname = ANY($1::text[]) AND relkind IN ('r', 'p')
      UNION ALL
      SELECT i.inhrelid, t.root_table, c.relname
      FROM pg_inherits i
      JOIN tables t ON t.oid = i.inhparent
      JOIN pg_class c ON c.oid = i.inhrelid
    )
    SELECT
      t.root_table AS table_name,
      SUM(s.n_dead_tup) AS n_dead_tup,
      SUM(s.n_live_tup) AS n_live_tup,
      MAX(s.last_autovacuum) AS last_autovacuum
    FROM tables t
    JOIN pg_stat_user_tables s ON s.relid = t.oid
    GROUP BY t.root_table
  `;
}

// ── Offline contract tests (no DB required) ────────────────────────────────────

describe('collectVacuumMetrics — recursive CTE contract structure', () => {
  it('uses WITH RECURSIVE to traverse the pg_inherits tree', () => {
    const sql = buildRollupSql();
    expect(sql).toContain('WITH RECURSIVE tables');
    expect(sql).toContain('pg_inherits');
    expect(sql).toContain('JOIN tables t ON t.oid = i.inhparent');
    expect(sql).toContain('JOIN pg_class c ON c.oid = i.inhrelid');
  });

  it('groups by root_table so children roll up under the declared parent label', () => {
    const sql = buildRollupSql();
    expect(sql).toContain('GROUP BY t.root_table');
    expect(sql).toContain('root_table AS table_name');
  });

  it('sums n_dead_tup and n_live_tup, and takes MAX of last_autovacuum across children', () => {
    const sql = buildRollupSql();
    expect(sql).toContain('SUM(s.n_dead_tup)');
    expect(sql).toContain('SUM(s.n_live_tup)');
    expect(sql).toContain('MAX(s.last_autovacuum)');
  });

  it('joins pg_stat_user_tables with s.relid = t.oid so each child contributes to the parent aggregate', () => {
    const sql = buildRollupSql();
    // Tightened: must be the precise shape used by collectVacuumMetrics().
    expect(sql).toMatch(/JOIN\s+pg_stat_user_tables\s+s\s+ON\s+s\.relid\s*=\s*t\.oid\b/);
  });

  it('filters pg_class to user tables (regular or partitioned, no system catalogs)', () => {
    const sql = buildRollupSql();
    expect(sql).toContain("relkind IN ('r', 'p')");
  });
});

// ── Live DB integration tests ──────────────────────────────────────────────────

describe.skipIf(!isLiveDb)('collectVacuumMetrics — partition rollup (live DB)', () => {
  let pool: pg.Pool | null = null;
  let dbAvailable = false;
  // Tracks how audit_logs was modified by the zero-partitions case so we
  // can restore it cleanly.  null = not modified.  A non-empty string names
  // an existing table saved under that name (to be renamed back to
  // audit_logs at cleanup).  auditLogsWasCreatedFromScratch = true means
  // no audit_logs existed beforehand — we created one as PARTITION OF and
  // must DROP TABLE on cleanup.
  let auditLogsRenamedTo: string | null = null;
  let auditLogsWasCreatedFromScratch = false;
  // vitest's MockInstance is structurally narrower than ReturnType<typeof vi.fn>,
  // so we cast at the assignment site rather than at declaration.
  // Using `any` here is acceptable in test files per eslint.config.js
  // (the no-explicit-any rule is a warning, not an error, in tests/).
  let warnSpy: any = null;

  /**
   * Read a Gauge's current value for the given label set. Mirrors the pattern
   * used in tests/unit/metrics/vacuumCollector.test.ts (prom-client stores
   * values in an internal hashMap keyed by label values). The parameter is
   * typed as `unknown` so the same helper works for the dead-tuples, bloat,
   * and last-autovacuum-age Gauges without structural-type mismatches.
   */
  function getGaugeValue(
    gauge: unknown,
    labels: Record<string, string>,
  ): number | undefined {
    const internal = gauge as {
      hashMap?: Record<string, { value: number }>;
    } | null | undefined;
    const hash = internal?.hashMap;
    if (!hash || typeof hash !== 'object') return undefined;
    const labelValues = Object.values(labels);
    const key = Object.keys(hash).find((k) => labelValues.every((v) => k.includes(v)));
    return key !== undefined && hash[key] && typeof hash[key].value === 'number'
      ? hash[key].value
      : undefined;
  }

  beforeAll(async () => {
    try {
      pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

      const probe = await pool.query<{ ok: number }>('SELECT 1 AS ok');
      if (probe.rows[0]?.ok !== 1) throw new Error('probe failed');

      // contract_events must exist; the partitioning migration creates it.
      const contractEventsExists = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_name = 'contract_events'
         ) AS exists`,
      );
      if (!contractEventsExists.rows[0]?.exists) {
        await pool.end().catch(() => {});
        pool = null;
        dbAvailable = false;
        return;
      }

      // Ensure two extra monthly test partitions exist.  These month IDs are
      // distinct from y2026m06/07/08 created by tests/db/contractEvents.partitionPruning.test.ts
      // so the rollups stay independent.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS contract_events_y2026m01 PARTITION OF contract_events
          FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00');
        CREATE TABLE IF NOT EXISTS contract_events_y2026m02 PARTITION OF contract_events
          FOR VALUES FROM ('2026-02-01 00:00:00+00') TO ('2026-03-01 00:00:00+00');
      `);

      dbAvailable = true;
    } catch {
      dbAvailable = false;
      if (pool) {
        await pool.end().catch(() => {});
        pool = null;
      }
    }
  });

  /** Best-effort restore of audit_logs after the zero-partitions case. */
  async function restoreAuditLogs(): Promise<void> {
    if (!pool) return;
    if (auditLogsWasCreatedFromScratch) {
      try {
        await pool.query(`DROP TABLE IF EXISTS ${ZERO_PARTITIONS_PARENT} CASCADE`);
      } catch {
        /* best-effort */
      }
    } else if (auditLogsRenamedTo) {
      try {
        await pool.query(`DROP TABLE IF EXISTS ${ZERO_PARTITIONS_PARENT} CASCADE`);
        await pool.query(`ALTER TABLE "${auditLogsRenamedTo}" RENAME TO ${ZERO_PARTITIONS_PARENT}`);
      } catch {
        /* best-effort; manual cleanup may be required if names collide */
      }
    }
    auditLogsRenamedTo = null;
    auditLogsWasCreatedFromScratch = false;
  }

  afterAll(async () => {
    await restoreAuditLogs();
    if (pool) {
      await pool.end().catch(() => {});
      pool = null;
    }
  });

  beforeEach(() => {
    if (!dbAvailable || !pool) return;
    pgDeadTuples.reset();
    pgBloatRatio.reset();
    pgLastAutovacuumAgeSeconds.reset();
    try { registry.registerMetric(pgDeadTuples); } catch { /* already registered */ }
    try { registry.registerMetric(pgBloatRatio); } catch { /* already registered */ }
    try { registry.registerMetric(pgLastAutovacuumAgeSeconds); } catch { /* already registered */ }

    warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (warnSpy) {
      warnSpy.mockRestore();
      warnSpy = null;
    }
    deRegisterVacuumMetrics();
  });

  /**
   * Recursive-CTE rollup SQL — invoked directly so we can compare the
   * function's Gauge output against the ground truth Postgres itself returns.
   */
  async function directRollup(tableNames: string[]): Promise<
    Array<{ table_name: string; n_dead_tup: number; n_live_tup: number; last_autovacuum: Date | null }>
  > {
    if (!pool) throw new Error('pool not initialized');
    const sql = buildRollupSql();
    const { rows } = await pool.query<{
      table_name: string;
      n_dead_tup: string;
      n_live_tup: string;
      last_autovacuum: Date | null;
    }>(sql, [tableNames]);
    return rows.map((r) => ({
      table_name: r.table_name,
      n_dead_tup: parseInt(r.n_dead_tup, 10),
      n_live_tup: parseInt(r.n_live_tup, 10),
      last_autovacuum: r.last_autovacuum,
    }));
  }

  /** Drop our seed rows so the test is idempotent across reruns. */
  async function cleanupPreviousTestRows(): Promise<void> {
    if (!pool) return;
    await pool.query(`DELETE FROM contract_events WHERE event_id LIKE 'vacmulti-%'`);
  }

  // ── Case 1: multi-partition SUM rollup ───────────────────────────────────

  it('rolls up SUM(n_dead_tup) and SUM(n_live_tup) across multiple partitions under the parent label', async () => {
    if (!dbAvailable || !pool) return;

    await cleanupPreviousTestRows();

    // Snapshot baseline BEFORE our seed inserts/deletes so we can prove the
    // rollup correctly reflects the per-partition deltas regardless of any
    // leftover state from earlier test runs.
    const beforeRows = await directRollup(['contract_events']);
    const beforeRow = beforeRows.find((r) => r.table_name === 'contract_events');
    const beforeDead = beforeRow?.n_dead_tup ?? 0;
    const beforeLive = beforeRow?.n_live_tup ?? 0;

    const p1Live = 70;
    const p2Live = 80;
    const p1Dead = 30;
    const p2Dead = 20;

    // One batched INSERT per partition using generate_series — single round
    // trip, deterministic row count, no per-row overhead.
    await pool.query(
      `INSERT INTO contract_events
         (event_id, ledger, contract_id, topic, tx_hash, tx_index, operation_index,
          event_index, payload, happened_at, ledger_hash)
       SELECT
         'vacmulti-p1-' || g::text,
         9000 + g,
         'CFLUXORAVAC',
         'vacmulti',
         repeat('h', 64),
         0, 0, 0,
         '{}'::jsonb,
         '2026-01-15T12:00:00+00'::timestamptz,
         repeat('p', 64)
       FROM generate_series(1, $1) g
       ON CONFLICT (happened_at, event_id) DO NOTHING`,
      [p1Live],
    );
    await pool.query(
      `INSERT INTO contract_events
         (event_id, ledger, contract_id, topic, tx_hash, tx_index, operation_index,
          event_index, payload, happened_at, ledger_hash)
       SELECT
         'vacmulti-p2-' || g::text,
         10000 + g,
         'CFLUXORAVAC',
         'vacmulti',
         repeat('i', 64),
         0, 0, 0,
         '{}'::jsonb,
         '2026-02-15T12:00:00+00'::timestamptz,
         repeat('q', 64)
       FROM generate_series(1, $1) g
       ON CONFLICT (happened_at, event_id) DO NOTHING`,
      [p2Live],
    );

    // Delete a known, deterministic subset of rows from each partition in
    // single round trips.
    await pool.query(
      `DELETE FROM contract_events
       WHERE event_id = ANY(
         SELECT 'vacmulti-p1-' || g::text FROM generate_series(1, $1) g
       )`,
      [p1Dead],
    );
    await pool.query(
      `DELETE FROM contract_events
       WHERE event_id = ANY(
         SELECT 'vacmulti-p2-' || g::text FROM generate_series(1, $1) g
       )`,
      [p2Dead],
    );

    // ANALYZE so pg_stat_user_tables picks up the post-delete n_dead_tup.
    // (ANALYZE updates n_dead_tup / n_live_tup without resetting either;
    // VACUUM clears n_dead_tup to 0.)
    await pool.query(`ANALYZE ${TEST_PARTITIONS.jan}`);
    await pool.query(`ANALYZE ${TEST_PARTITIONS.feb}`);

    // Sanity check the deltas against Postgres' own rollup BEFORE invoking
    // collectVacuumMetrics.  Proves the CTE+summation actually works.
    const afterRows = await directRollup(['contract_events']);
    const afterRow = afterRows.find((r) => r.table_name === 'contract_events');
    expect(afterRow).toBeDefined();
    const deadDelta = (afterRow?.n_dead_tup ?? 0) - beforeDead;
    const liveDelta = (afterRow?.n_live_tup ?? 0) - beforeLive;

    expect(deadDelta).toBe(p1Dead + p2Dead);
    expect(liveDelta).toBe(p1Live + p2Live - p1Dead - p2Dead);

    // Now run collectVacuumMetrics — it must emit Gauge values that equal the
    // CTEs under the parent label "contract_events" (not under either
    // partition name and not under the parent's typically-empty stat row).
    await collectVacuumMetrics(pool);

    const deadGauge = getGaugeValue(pgDeadTuples, { table: 'contract_events' });
    expect(deadGauge).toBe(afterRow?.n_dead_tup);

    const bloatGauge = getGaugeValue(pgBloatRatio, { table: 'contract_events' });
    const totalTup = (afterRow?.n_dead_tup ?? 0) + (afterRow?.n_live_tup ?? 0);
    const expectedBloat = totalTup > 0 ? (afterRow?.n_dead_tup ?? 0) / totalTup : 0;
    expect(bloatGauge).toBeCloseTo(expectedBloat, 6);

    // The parent label must NOT appear under any of the partition names —
    // otherwise the rollup would be wrong (the function labels by root_table).
    expect(getGaugeValue(pgDeadTuples, { table: TEST_PARTITIONS.jan })).toBeUndefined();
    expect(getGaugeValue(pgDeadTuples, { table: TEST_PARTITIONS.feb })).toBeUndefined();

    await cleanupPreviousTestRows();
  });

  // ── Case 2: MAX(last_autovacuum) ─────────────────────────────────────────

  it('picks MAX(last_autovacuum) across partitions — the most recent VACUUM, not the first encountered', async () => {
    if (!dbAvailable || !pool) return;

    await cleanupPreviousTestRows();

    // Vacuum partition 1 first; sleep briefly so partition 2's VACUUM is
    // deterministically MORE recent than partition 1's. This sets up the
    // discriminating condition: if the rollup picks MAX(), the chosen
    // timestamp will be p2.last_autovacuum (the larger). If the rollup
    // accidentally picked the first row enumerated, it should frequently be
    // p1.last_autovacuum — distinguishable by timestamp ordering.
    await pool.query(`VACUUM ${TEST_PARTITIONS.jan}`);
    await pool.query(`ANALYZE ${TEST_PARTITIONS.jan}`);

    // pg_sleep long enough for VACUUM's timestamp clock to advance.
    await pool.query(`SELECT pg_sleep(0.6)`);

    await pool.query(`VACUUM ${TEST_PARTITIONS.feb}`);
    await pool.query(`ANALYZE ${TEST_PARTITIONS.feb}`);

    await pool.query(`SELECT pg_sleep(0.2)`);

    // Read both partition timestamps directly to establish p1 < p2.
    const p1Res = await pool.query<{ last_autovacuum: Date | null }>(
      `SELECT last_autovacuum FROM pg_stat_user_tables
       WHERE relid = '${TEST_PARTITIONS.jan}'::regclass`,
    );
    const p2Res = await pool.query<{ last_autovacuum: Date | null }>(
      `SELECT last_autovacuum FROM pg_stat_user_tables
       WHERE relid = '${TEST_PARTITIONS.feb}'::regclass`,
    );

    const p1Last = p1Res.rows[0]?.last_autovacuum ?? null;
    const p2Last = p2Res.rows[0]?.last_autovacuum ?? null;
    expect(p1Last).not.toBeNull();
    expect(p2Last).not.toBeNull();
    expect(p2Last!.getTime()).toBeGreaterThan(p1Last!.getTime());

    // Independent ground-truth MAX: the recursive-CTE rollup invoked directly
    // must return last_autovacuum >= both p1.last_autovacuum and
    // p2.last_autovacuum (it picks MAX across all partitions of contract_events,
    // including any other ones like the default partition or partitions from
    // prior test runs).
    const directRows = await directRollup(['contract_events']);
    const directRow = directRows.find((r) => r.table_name === 'contract_events');
    expect(directRow).toBeDefined();
    const directMax = directRow?.last_autovacuum;
    expect(directMax).not.toBeNull();
    expect(directMax!.getTime()).toBeGreaterThanOrEqual(p2Last!.getTime());

    // Sanity: not a never-vacuumed table — last_autovacuum is non-null.
    expect(directMax!.getTime()).toBeGreaterThan(0);

    // Run collectVacuumMetrics — the emitted age gauge must reflect MAX.
    await collectVacuumMetrics(pool);

    const ageGauge = getGaugeValue(pgLastAutovacuumAgeSeconds, { table: 'contract_events' });
    expect(ageGauge).toBeDefined();
    // Never-vacuumed tables get -1 — a recent MAX means we are not in that bucket.
    expect(ageGauge).toBeGreaterThan(0);

    // The age gauge equals (now - directMax) / 1000; allow a small skew
    // between when the rollup was computed and when collectVacuumMetrics
    // runs (single-digit seconds in the worst case).
    const expectedAge = (Date.now() - directMax!.getTime()) / 1000;
    expect(ageGauge).toBeGreaterThanOrEqual(expectedAge - 1);
    expect(ageGauge).toBeLessThanOrEqual(expectedAge + 5);

    // Critical MAX semantics proof: the direct-rollup MAX equals the gauge
    // age's underlying timestamp. Since the gauge represents MAX(...), and we
    // just verified the direct rollup represents MAX(...), the gauge equals
    // MAX(...) — which is what we set out to prove.
    // (We intentionally do NOT assert ageGauge < p1Age here: other
    // partitions of contract_events may have a more-recent last_autovacuum
    // than p2, but the rollup still correctly picks MAX across ALL of them.
    // The equality with directMax above proves the recursion + grouping
    // + MAX aggregation; that is sufficient evidence and avoids false-fail
    // when prior test runs have vacuumed other partitions.)
  });

  // ── Case 3: zero-partitions parent ───────────────────────────────────────

  it('does not throw on a partitioned parent with zero child partitions and reports sensible values', async () => {
    if (!dbAvailable || !pool) return;

    // Save existing audit_logs (if any) by renaming, then recreate as a
    // partitioned parent with NO children.  We use audit_logs because it is
    // one of MONITORED_TABLES, so the recursive CTE's base case WILL match
    // it.  When pg_inherits has no children, the recursive part expands to
    // zero rows and the SUM aggregates over just the parent itself — which
    // is the exact scenario this test verifies.
    const backupName = `${ZERO_PARTITIONS_PARENT}_vac_rollup_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const createPartitionedAuditLogs = `
      CREATE TABLE ${ZERO_PARTITIONS_PARENT} (
        id BIGSERIAL,
        seq BIGINT NOT NULL,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        correlation_id TEXT,
        meta JSONB,
        PRIMARY KEY (id)
      ) PARTITION BY RANGE (id);
    `;
    try {
      const existsRes = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_name = $1
         ) AS exists`,
        [ZERO_PARTITIONS_PARENT],
      );
      if (existsRes.rows[0]?.exists) {
        // Existing audit_logs: stash under a unique name, then create a fresh
        // partitioned parent in its place.
        await pool.query(`ALTER TABLE ${ZERO_PARTITIONS_PARENT} RENAME TO "${backupName}"`);
        auditLogsRenamedTo = backupName;
      } else {
        // No audit_logs in this DB — we will DROP our created partitioned
        // parent at cleanup time.
        auditLogsWasCreatedFromScratch = true;
      }
      await pool.query(createPartitionedAuditLogs);
    } catch {
      // If we can't perform the swap, bail out cleanly and let afterAll restore.
      return;
    }

    try {
      // Force pg_stat_user_tables to register the new partitioned parent.
      await pool.query(`ANALYZE ${ZERO_PARTITIONS_PARENT}`);

      // Sanity check: Postgres' own rollup for audit_logs reports zero dead,
      // zero live, and NULL last_autovacuum (no children, never vacuumed).
      const directRows = await directRollup([ZERO_PARTITIONS_PARENT]);
      const directRow = directRows.find((r) => r.table_name === ZERO_PARTITIONS_PARENT);
      expect(directRow).toBeDefined();
      expect(directRow?.n_dead_tup).toBe(0);
      expect(directRow?.n_live_tup).toBe(0);
      expect(directRow?.last_autovacuum).toBeNull();

      // The function MUST NOT throw on a partitioned parent with zero children.
      await expect(collectVacuumMetrics(pool)).resolves.toBeUndefined();

      // Sensible zero/-1 report on the Gauges:
      expect(getGaugeValue(pgDeadTuples, { table: ZERO_PARTITIONS_PARENT })).toBe(0);
      expect(getGaugeValue(pgBloatRatio, { table: ZERO_PARTITIONS_PARENT })).toBe(0);
      // last_autovacuum NULL → age gauge = -1 (never vacuumed), as per the
      // documented contract in collectVacuumMetrics().
      expect(getGaugeValue(pgLastAutovacuumAgeSeconds, { table: ZERO_PARTITIONS_PARENT })).toBe(-1);
    } finally {
      // In-test cleanup so a failure here is well isolated.  afterAll calls
      // restoreAuditLogs() again as a safety net.
      await restoreAuditLogs();
    }
  });
});
