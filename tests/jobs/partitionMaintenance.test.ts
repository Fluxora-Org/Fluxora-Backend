import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import {
  runPartitionMaintenance,
  quoteIdentifier,
  PARTITION_MAINTENANCE_LOCK_ID,
  CANDIDATE_TABLES,
  DEFAULT_MONTHS_AHEAD,
} from '../../src/jobs/partitionMaintenance.js';
import {
  partitionsCreatedTotal,
  partitionMaintenanceBehindScheduleTotal,
} from '../../src/metrics/businessMetrics.js';

// ── Mock pool builder ─────────────────────────────────────────────────────
//
// runPartitionMaintenance talks to Postgres exclusively through
// `query(pool, sql, params)` (src/db/pool.ts), which delegates to
// `pool.query(sql, params)`. A plain object exposing a mocked `query` is
// therefore sufficient — no real Postgres connection is required.

type QueryCall = { sql: string; params: unknown[] | undefined };

/**
 * Builds a mock `Pool` plus a scripted responder so each test can declare,
 * in a readable way, what each kind of query should return without hand
 * -counting `.mockResolvedValueOnce()` calls in call order.
 *
 * `partitioned` maps table name -> is it a RANGE-partitioned table.
 * `existingPartitions` is a Set of partition names that already exist.
 */
function buildMockPool(opts: {
  lockAcquired?: boolean;
  partitioned?: Partial<Record<string, boolean>>;
  existingPartitions?: Set<string>;
  onCreate?: (partitionName: string) => void;
} = {}) {
  const {
    lockAcquired = true,
    partitioned = { contract_events: true },
    existingPartitions = new Set<string>(),
    onCreate,
  } = opts;

  const calls: QueryCall[] = [];

  const queryImpl = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });

    if (sql.includes('pg_try_advisory_lock')) {
      return { rows: [{ pg_try_advisory_lock: lockAcquired }], rowCount: 1 };
    }
    if (sql.includes('pg_advisory_unlock')) {
      return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
    }
    if (sql.includes('pg_partitioned_table')) {
      const table = params?.[0] as string;
      const isPartitioned = partitioned[table] === true;
      return {
        rows: isPartitioned ? [{ relkind: 'p', partstrat: 'r' }] : [],
        rowCount: isPartitioned ? 1 : 0,
      };
    }
    if (sql.includes('to_regclass($1) IS NOT NULL')) {
      const partitionName = params?.[0] as string;
      return { rows: [{ exists: existingPartitions.has(partitionName) }], rowCount: 1 };
    }
    if (sql.includes('CREATE TABLE IF NOT EXISTS')) {
      const match = /CREATE TABLE IF NOT EXISTS "([^"]+)"/.exec(sql);
      const partitionName = match?.[1];
      if (partitionName) {
        existingPartitions.add(partitionName);
        onCreate?.(partitionName);
      }
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected query in mock pool: ${sql}`);
  });

  const pool = { query: queryImpl } as unknown as Pool;
  return { pool, calls, existingPartitions };
}

const FIXED_NOW = new Date('2026-07-15T12:00:00.000Z');

describe('runPartitionMaintenance', () => {
  beforeEach(() => {
    partitionsCreatedTotal.reset();
    partitionMaintenanceBehindScheduleTotal.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Lock acquisition ──────────────────────────────────────────────────────

  describe('advisory lock', () => {
    it('acquires the lock using the documented lock id', async () => {
      const { pool, calls } = buildMockPool();
      await runPartitionMaintenance(pool, { now: FIXED_NOW });

      expect(calls[0]).toEqual({
        sql: 'SELECT pg_try_advisory_lock($1)',
        params: [PARTITION_MAINTENANCE_LOCK_ID],
      });
    });

    it('skips all work and returns lockAcquired: false when the lock is already held', async () => {
      const { pool, calls } = buildMockPool({ lockAcquired: false });

      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW });

      expect(result.lockAcquired).toBe(false);
      expect(result.tables).toEqual([]);
      // Only the lock attempt itself — no partition checks, no unlock call
      // (we never held the lock, so releasing it would be incorrect).
      expect(calls).toHaveLength(1);
    });

    it('releases the lock after a successful run', async () => {
      const { pool, calls } = buildMockPool();
      await runPartitionMaintenance(pool, { now: FIXED_NOW });

      const unlockCall = calls.find((c) => c.sql.includes('pg_advisory_unlock'));
      expect(unlockCall).toEqual({
        sql: 'SELECT pg_advisory_unlock($1)',
        params: [PARTITION_MAINTENANCE_LOCK_ID],
      });
    });

    it('releases the lock even when a table check throws (finally block)', async () => {
      const { pool, calls } = buildMockPool();
      // Force the second query (partitioned check for contract_events) to throw.
      let call = 0;
      (pool.query as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params?: unknown[]) => {
        call += 1;
        calls.push({ sql, params });
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ pg_try_advisory_lock: true }], rowCount: 1 };
        if (sql.includes('pg_advisory_unlock')) return { rows: [], rowCount: 0 };
        if (call === 2) throw new Error('connection reset');
        return { rows: [], rowCount: 0 };
      });

      await expect(runPartitionMaintenance(pool, { now: FIXED_NOW })).rejects.toThrow('connection reset');

      const unlockCall = calls.find((c) => c.sql.includes('pg_advisory_unlock'));
      expect(unlockCall).toBeDefined();
    });
  });

  // ── Input validation ──────────────────────────────────────────────────────

  describe('input validation', () => {
    it('throws for a negative monthsAhead', async () => {
      const { pool } = buildMockPool();
      await expect(runPartitionMaintenance(pool, { monthsAhead: -1 })).rejects.toThrow(/non-negative integer/);
    });

    it('throws for a non-integer monthsAhead', async () => {
      const { pool } = buildMockPool();
      await expect(runPartitionMaintenance(pool, { monthsAhead: 1.5 })).rejects.toThrow(/non-negative integer/);
    });

    it('accepts a bare number for backward compatibility with the old signature', async () => {
      const { pool, calls } = buildMockPool();
      await runPartitionMaintenance(pool, 2);

      const createCalls = calls.filter((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS'));
      // monthsAhead=2 => current month + 2 future months = 3 partitions for contract_events
      expect(createCalls).toHaveLength(3);
    });

    it('defaults monthsAhead to DEFAULT_MONTHS_AHEAD when omitted', async () => {
      const { pool, calls } = buildMockPool();
      await runPartitionMaintenance(pool, { now: FIXED_NOW });

      const createCalls = calls.filter((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS'));
      expect(createCalls).toHaveLength(DEFAULT_MONTHS_AHEAD + 1);
    });

    it('monthsAhead=0 only ensures the current month exists', async () => {
      const { pool, calls } = buildMockPool();
      await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 0 });

      const createCalls = calls.filter((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS'));
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].sql).toContain('contract_events_y2026m07');
    });
  });

  // ── Table management gating (managed vs. unmanaged) ──────────────────────

  describe('table management gating', () => {
    it('manages contract_events and skips audit_logs when audit_logs is not partitioned', async () => {
      const { pool } = buildMockPool({ partitioned: { contract_events: true, audit_logs: false } });

      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 1 });

      const ce = result.tables.find((t) => t.table === 'contract_events')!;
      const al = result.tables.find((t) => t.table === 'audit_logs')!;
      expect(ce.managed).toBe(true);
      expect(ce.partitionsCreated).toHaveLength(2);
      expect(al.managed).toBe(false);
      expect(al.partitionsChecked).toBe(0);
      expect(al.partitionsCreated).toEqual([]);
      expect(al.behindSchedule).toBe(false);
    });

    it('manages both contract_events and audit_logs once audit_logs becomes range-partitioned', async () => {
      const { pool, calls } = buildMockPool({
        partitioned: { contract_events: true, audit_logs: true },
      });

      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 1 });

      const al = result.tables.find((t) => t.table === 'audit_logs')!;
      expect(al.managed).toBe(true);
      expect(al.partitionsCreated).toEqual(['audit_logs_y2026m07', 'audit_logs_y2026m08']);

      const createCalls = calls.filter((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS'));
      expect(createCalls).toHaveLength(4); // 2 tables x 2 months
    });

    it('processes every table listed in CANDIDATE_TABLES', async () => {
      const { pool } = buildMockPool({ partitioned: {} });
      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW });
      expect(result.tables.map((t) => t.table)).toEqual([...CANDIDATE_TABLES]);
    });

    it('gracefully skips a table that does not exist at all (to_regclass resolves to no rows)', async () => {
      const { pool } = buildMockPool({ partitioned: { contract_events: true } }); // audit_logs absent from map => not partitioned/absent
      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW });
      const al = result.tables.find((t) => t.table === 'audit_logs')!;
      expect(al.managed).toBe(false);
    });
  });

  // ── Idempotency ───────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('is a safe no-op when every partition already exists', async () => {
      const existing = new Set([
        'contract_events_y2026m07',
        'contract_events_y2026m08',
        'contract_events_y2026m09',
        'contract_events_y2026m10',
      ]);
      const { pool, calls } = buildMockPool({ existingPartitions: existing });

      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW });

      const createCalls = calls.filter((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS'));
      expect(createCalls).toHaveLength(0);
      expect(result.tables[0].partitionsCreated).toEqual([]);
      expect(result.tables[0].behindSchedule).toBe(false);
    });

    it('re-running after partitions were created performs no additional DDL', async () => {
      const { pool, calls, existingPartitions } = buildMockPool();

      await runPartitionMaintenance(pool, { now: FIXED_NOW });
      const createsAfterFirstRun = calls.filter((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS')).length;
      expect(createsAfterFirstRun).toBeGreaterThan(0);
      expect(existingPartitions.size).toBe(createsAfterFirstRun);

      await runPartitionMaintenance(pool, { now: FIXED_NOW });
      const createsAfterSecondRun = calls.filter((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS')).length;
      // No new CREATE calls were issued on the second run.
      expect(createsAfterSecondRun).toBe(createsAfterFirstRun);
    });

    it('uses IF NOT EXISTS in the generated DDL as a second layer of idempotency', async () => {
      const { pool, calls } = buildMockPool();
      await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 0 });

      const createCall = calls.find((c) => c.sql.includes('CREATE TABLE'));
      expect(createCall!.sql).toMatch(/CREATE TABLE IF NOT EXISTS/);
    });
  });

  // ── Partition naming & date math ──────────────────────────────────────────

  describe('partition naming and date math', () => {
    it('names partitions <table>_y<YYYY>m<MM>', async () => {
      const { pool, calls } = buildMockPool();
      await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 0 });

      const createCall = calls.find((c) => c.sql.includes('CREATE TABLE'));
      expect(createCall!.sql).toContain('"contract_events_y2026m07"');
    });

    it('handles a year rollover correctly (December -> January)', async () => {
      const decemberNow = new Date('2026-12-10T00:00:00.000Z');
      const { pool, calls } = buildMockPool();
      await runPartitionMaintenance(pool, { now: decemberNow, monthsAhead: 1 });

      const createSqls = calls.filter((c) => c.sql.includes('CREATE TABLE')).map((c) => c.sql);
      expect(createSqls.some((s) => s.includes('contract_events_y2026m12'))).toBe(true);
      expect(createSqls.some((s) => s.includes('contract_events_y2027m01'))).toBe(true);
    });

    it('uses UTC month boundaries regardless of local server timezone quirks near midnight', async () => {
      // 2026-01-31T23:30:00Z is still January in UTC even if a local
      // timezone offset would push a naive Date into February.
      const lateJan = new Date('2026-01-31T23:30:00.000Z');
      const { pool, calls } = buildMockPool();
      await runPartitionMaintenance(pool, { now: lateJan, monthsAhead: 0 });

      const createCall = calls.find((c) => c.sql.includes('CREATE TABLE'));
      expect(createCall!.sql).toContain('contract_events_y2026m01');
    });

    it('emits FOR VALUES FROM/TO with ISO-8601 UTC month boundaries', async () => {
      const { pool, calls } = buildMockPool();
      await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 0 });

      const createCall = calls.find((c) => c.sql.includes('CREATE TABLE'));
      expect(createCall!.sql).toContain("FOR VALUES FROM ('2026-07-01T00:00:00.000Z') TO ('2026-08-01T00:00:00.000Z')");
    });
  });

  // ── Behind-schedule alerting ──────────────────────────────────────────────

  describe('behind-schedule alerting', () => {
    it('flags behindSchedule and increments the metric when the current month partition is missing', async () => {
      const incSpy = vi.spyOn(partitionMaintenanceBehindScheduleTotal, 'inc');
      const { pool } = buildMockPool();

      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW });

      expect(result.tables[0].behindSchedule).toBe(true);
      expect(incSpy).toHaveBeenCalledWith({ table: 'contract_events' });
    });

    it('logs a structured error event when falling behind schedule', async () => {
      const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { pool } = buildMockPool();

      await runPartitionMaintenance(pool, { now: FIXED_NOW });

      const logged = errorSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes('partition_maintenance_behind_schedule'));
      expect(logged).toBeDefined();
      const parsed = JSON.parse(logged!);
      expect(parsed.level).toBe('error');
      expect(parsed.event).toBe('partition_maintenance_behind_schedule');
      expect(parsed.table).toBe('contract_events');
      errorSpy.mockRestore();
    });

    it('does NOT flag behindSchedule when the current month partition already exists', async () => {
      const existing = new Set(['contract_events_y2026m07']);
      const incSpy = vi.spyOn(partitionMaintenanceBehindScheduleTotal, 'inc');
      const { pool } = buildMockPool({ existingPartitions: existing });

      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 1 });

      expect(result.tables[0].behindSchedule).toBe(false);
      expect(incSpy).not.toHaveBeenCalledWith({ table: 'contract_events' });
    });

    it('does NOT flag behindSchedule when only a future month partition is missing', async () => {
      // Current month exists; only the +1 future month is missing — this is
      // the expected day-to-day steady state, not a missed run.
      const existing = new Set(['contract_events_y2026m07']);
      const { pool } = buildMockPool({ existingPartitions: existing });

      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 1 });

      expect(result.tables[0].behindSchedule).toBe(false);
      expect(result.tables[0].partitionsCreated).toEqual(['contract_events_y2026m08']);
    });

    it('still creates the missing current-month partition after flagging it (self-heals)', async () => {
      const { pool } = buildMockPool();
      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 0 });

      expect(result.tables[0].behindSchedule).toBe(true);
      expect(result.tables[0].partitionsCreated).toEqual(['contract_events_y2026m07']);
    });

    it('tracks behind-schedule independently per table', async () => {
      const incSpy = vi.spyOn(partitionMaintenanceBehindScheduleTotal, 'inc');
      const existing = new Set(['audit_logs_y2026m07']); // audit_logs is caught up, contract_events is not
      const { pool } = buildMockPool({
        partitioned: { contract_events: true, audit_logs: true },
        existingPartitions: existing,
      });

      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 0 });

      const ce = result.tables.find((t) => t.table === 'contract_events')!;
      const al = result.tables.find((t) => t.table === 'audit_logs')!;
      expect(ce.behindSchedule).toBe(true);
      expect(al.behindSchedule).toBe(false);
      expect(incSpy).toHaveBeenCalledWith({ table: 'contract_events' });
      expect(incSpy).not.toHaveBeenCalledWith({ table: 'audit_logs' });
    });
  });

  // ── Metrics ───────────────────────────────────────────────────────────────

  describe('metrics', () => {
    it('increments partitionsCreatedTotal once per partition actually created', async () => {
      const incSpy = vi.spyOn(partitionsCreatedTotal, 'inc');
      const { pool } = buildMockPool();

      await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 2 });

      expect(incSpy).toHaveBeenCalledTimes(3);
      expect(incSpy).toHaveBeenCalledWith({ table: 'contract_events' });
    });

    it('does not increment partitionsCreatedTotal for partitions that already exist', async () => {
      const existing = new Set([
        'contract_events_y2026m07',
        'contract_events_y2026m08',
      ]);
      const incSpy = vi.spyOn(partitionsCreatedTotal, 'inc');
      const { pool } = buildMockPool({ existingPartitions: existing });

      await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 1 });

      expect(incSpy).not.toHaveBeenCalled();
    });
  });

  // ── Security ──────────────────────────────────────────────────────────────

  describe('security', () => {
    it('quoteIdentifier wraps identifiers in double quotes', () => {
      expect(quoteIdentifier('contract_events_y2026m07')).toBe('"contract_events_y2026m07"');
    });

    it('quoteIdentifier escapes embedded double quotes by doubling them', () => {
      expect(quoteIdentifier('weird"name')).toBe('"weird""name"');
    });

    it('interpolates table and partition names as quoted identifiers in the DDL', async () => {
      const { pool, calls } = buildMockPool();
      await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 0 });

      const createCall = calls.find((c) => c.sql.includes('CREATE TABLE'));
      expect(createCall!.sql).toContain('PARTITION OF "contract_events"');
      expect(createCall!.sql).toContain('CREATE TABLE IF NOT EXISTS "contract_events_y2026m07"');
    });

    it('never passes raw (unparameterized) user-controllable values — table existence checks use parameterized to_regclass', async () => {
      const { pool, calls } = buildMockPool();
      await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 0 });

      const existsCalls = calls.filter((c) => c.sql.includes('to_regclass($1) IS NOT NULL'));
      for (const call of existsCalls) {
        expect(call.sql).not.toContain('contract_events_y2026m07'); // name only appears as a bound param, never inlined
        expect(call.params).toBeDefined();
      }
    });

    it('rejects a malformed ISO-8601 partition bound instead of interpolating it into DDL', async () => {
      // Defence-in-depth assertion: if a future refactor ever broke the
      // invariant that partition bounds come exclusively from
      // `monthStartUtc()`, this guard must reject the value rather than
      // silently interpolating attacker- or bug-controlled text into DDL.
      const badIso = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('not-a-real-date');
      const { pool } = buildMockPool();

      await expect(runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 0 })).rejects.toThrow(
        /unexpected ISO-8601 date format/,
      );

      badIso.mockRestore();
    });
  });

  // ── Result shape / summary logging ───────────────────────────────────────

  describe('result summary', () => {
    it('returns startedAt/finishedAt as valid ISO-8601 timestamps', async () => {
      const { pool } = buildMockPool();
      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW });

      expect(() => new Date(result.startedAt).toISOString()).not.toThrow();
      expect(() => new Date(result.finishedAt).toISOString()).not.toThrow();
    });

    it('reports partitionsChecked as monthsAhead + 1 for managed tables', async () => {
      const { pool } = buildMockPool();
      const result = await runPartitionMaintenance(pool, { now: FIXED_NOW, monthsAhead: 3 });

      expect(result.tables[0].partitionsChecked).toBe(4);
    });
  });
});
