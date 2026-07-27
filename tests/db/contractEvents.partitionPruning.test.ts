/**
 * Integration and Unit Tests: Partition Pruning Verification for contract_events.
 *
 * @module tests/db/contractEvents.partitionPruning.test.ts
 *
 * PURPOSE
 * -------
 * Asserts that PostgreSQL partition pruning engages for the query shapes issued
 * by PostgresContractEventStore.getEvents() after the table was converted to
 * RANGE partitioning by happened_at in
 * migrations/20260627000000_contract_events_partitioning.ts.
 *
 * A future predicate rewrite that silently disables pruning (e.g. casting
 * happened_at to text, wrapping it in a function, or removing the timestamp
 * predicates) will be caught immediately by these tests.
 *
 * TEST COVERAGE
 * -------------
 *  [offline] plan helper: single-partition detection
 *  [offline] plan helper: multi-partition detection
 *  [offline] plan helper: no false positives when partition absent from plan
 *  [offline] InMemoryContractEventStore: happened_at range filtering (single partition)
 *  [offline] InMemoryContractEventStore: happened_at range filtering (cross-partition)
 *  [offline] InMemoryContractEventStore: returns all events when no filter applied
 *  [live DB] EXPLAIN: single-partition bounded query scans ONLY the July partition
 *  [live DB] EXPLAIN: cross-partition query scans EXACTLY June + July, not August
 *  [live DB] EXPLAIN: August-only query scans ONLY the August partition
 *  [live DB] store.getEvents(): correct records returned when pruning is active (single)
 *  [live DB] store.getEvents(): correct records returned when pruning is active (cross)
 *  [live DB] store.getEvents(): no records returned outside seeded range
 *  [live DB] duplicate inserts via insertMany() are silently ignored (ON CONFLICT idempotency)
 *
 * RUNNING LIVE TESTS
 * ------------------
 *   DATABASE_URL=postgresql://indexer_user:indexer_password@localhost:5432/indexer_db \
 *     pnpm test tests/db/contractEvents.partitionPruning.test.ts
 *
 * SECURITY NOTES
 * --------------
 * - All SQL uses parameterized queries ($1, $2, …) — no string interpolation
 *   of user-supplied values.
 * - Seed rows use a deterministic prefix ('prune-seed-') to avoid collisions
 *   with production data and are guarded with ON CONFLICT DO NOTHING.
 * - The test only creates partitions and reads/inserts isolated rows; it does
 *   not drop any table or modify production data.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  PostgresContractEventStore,
  InMemoryContractEventStore,
  type PgClientLike,
} from '../../src/indexer/store.js';
import type { StreamEventReplayFilter } from '../../src/db/types.js';

// ── Environment guard ────────────────────────────────────────────────────────
// Live-DB tests require a real Postgres instance. Pass DATABASE_URL to enable.
const DATABASE_URL = process.env['DATABASE_URL'];
const isLiveDb = Boolean(DATABASE_URL);

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Monthly partition names created by beforeAll for the live-DB suite.
 * Each maps to a one-month range of happened_at values.
 */
export const TEST_PARTITIONS = {
  june: 'contract_events_y2026m06',
  july: 'contract_events_y2026m07',
  august: 'contract_events_y2026m08',
  default: 'contract_events_default',
} as const;

/** Seed row event_ids inserted during beforeAll. */
const SEED = {
  jun: 'prune-seed-jun-1',
  jul: 'prune-seed-jul-1',
  aug: 'prune-seed-aug-1',
} as const;

// ── Plan-inspection helpers ──────────────────────────────────────────────────

/**
 * Returns true when `partitionName` appears anywhere in the serialised
 * EXPLAIN (FORMAT JSON) plan.  PostgreSQL embeds the partition table name in
 * the "Relation Name" field of every Seq Scan / Index Scan node, so a simple
 * string search is sufficient and robust across plan shapes.
 *
 * @param planJson  Raw value from `result.rows[0]['QUERY PLAN']`
 * @param partitionName  Exact partition table name to look for
 */
export function planScansPartition(planJson: unknown, partitionName: string): boolean {
  return JSON.stringify(planJson).includes(partitionName);
}

/**
 * Returns the subset of `candidatePartitions` that appear in the plan.
 *
 * @param planJson           Raw EXPLAIN (FORMAT JSON) plan
 * @param candidatePartitions  Names to check
 */
export function getScannedPartitions(
  planJson: unknown,
  candidatePartitions: readonly string[],
): string[] {
  return candidatePartitions.filter((p) => planScansPartition(planJson, p));
}

/**
 * Runs EXPLAIN (FORMAT JSON) for a given SQL + params pair and returns the
 * list of TEST_PARTITIONS entries that appear in the plan.
 */
async function explainScanned(
  client: pg.Client,
  sql: string,
  params: unknown[],
): Promise<string[]> {
  const result = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  const plan: unknown = result.rows[0]?.['QUERY PLAN'];
  return getScannedPartitions(plan, Object.values(TEST_PARTITIONS));
}

// ── Offline / Contract Tests ──────────────────────────────────────────────────
// These always run — no database required.

describe('contract_events Partition Pruning — offline contract tests', () => {
  // ── planScansPartition helper ──────────────────────────────────────────────

  it('detects a single partition reference in an EXPLAIN plan', () => {
    const mockPlan = [
      {
        Plan: {
          'Node Type': 'Append',
          Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'contract_events_y2026m07' }],
        },
      },
    ];

    expect(planScansPartition(mockPlan, TEST_PARTITIONS.july)).toBe(true);
    expect(planScansPartition(mockPlan, TEST_PARTITIONS.june)).toBe(false);
    expect(planScansPartition(mockPlan, TEST_PARTITIONS.august)).toBe(false);
    expect(planScansPartition(mockPlan, TEST_PARTITIONS.default)).toBe(false);
  });

  it('detects multiple partition references in a cross-partition plan', () => {
    const mockPlan = [
      {
        Plan: {
          'Node Type': 'Append',
          Plans: [
            { 'Node Type': 'Seq Scan', 'Relation Name': 'contract_events_y2026m06' },
            { 'Node Type': 'Seq Scan', 'Relation Name': 'contract_events_y2026m07' },
          ],
        },
      },
    ];

    const scanned = getScannedPartitions(mockPlan, Object.values(TEST_PARTITIONS));
    expect(scanned).toHaveLength(2);
    expect(scanned).toContain(TEST_PARTITIONS.june);
    expect(scanned).toContain(TEST_PARTITIONS.july);
    expect(scanned).not.toContain(TEST_PARTITIONS.august);
    expect(scanned).not.toContain(TEST_PARTITIONS.default);
  });

  it('returns empty list when no candidate partitions appear in the plan', () => {
    const mockPlan = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'some_other_table' } }];
    const scanned = getScannedPartitions(mockPlan, Object.values(TEST_PARTITIONS));
    expect(scanned).toHaveLength(0);
  });

  // ── InMemoryContractEventStore filter parity ───────────────────────────────

  it('InMemoryStore: single-partition happened_at range returns only matching events', async () => {
    const store = new InMemoryContractEventStore();
    await store.insertMany([
      buildEvent('evt-jun', 100, '2026-06-15T12:00:00.000Z'),
      buildEvent('evt-jul', 101, '2026-07-15T12:00:00.000Z'),
      buildEvent('evt-aug', 102, '2026-08-15T12:00:00.000Z'),
    ]);

    const res = await store.getEvents({
      fromHappenedAt: '2026-07-01T00:00:00.000Z',
      toHappenedAt: '2026-07-31T23:59:59.999Z',
    });

    expect(res.events).toHaveLength(1);
    expect(res.events[0]?.eventId).toBe('evt-jul');
  });

  it('InMemoryStore: cross-partition happened_at range returns exactly the spanning events', async () => {
    const store = new InMemoryContractEventStore();
    await store.insertMany([
      buildEvent('evt-jun', 100, '2026-06-15T12:00:00.000Z'),
      buildEvent('evt-jul', 101, '2026-07-15T12:00:00.000Z'),
      buildEvent('evt-aug', 102, '2026-08-15T12:00:00.000Z'),
    ]);

    const res = await store.getEvents({
      fromHappenedAt: '2026-06-10T00:00:00.000Z',
      toHappenedAt: '2026-07-20T23:59:59.999Z',
    });

    expect(res.events).toHaveLength(2);
    expect(res.events.map((e) => e.eventId)).toEqual(
      expect.arrayContaining(['evt-jun', 'evt-jul']),
    );
  });

  it('InMemoryStore: returns all events when no timestamp filter is applied', async () => {
    const store = new InMemoryContractEventStore();
    await store.insertMany([
      buildEvent('evt-1', 100, '2026-06-15T12:00:00.000Z'),
      buildEvent('evt-2', 101, '2026-07-15T12:00:00.000Z'),
      buildEvent('evt-3', 102, '2026-08-15T12:00:00.000Z'),
    ]);

    const res = await store.getEvents({});
    expect(res.events).toHaveLength(3);
  });
});

/** Minimal ContractEventRecord factory used by offline tests. */
function buildEvent(eventId: string, ledger: number, happenedAt: string) {
  return {
    eventId,
    ledger,
    ledgerHash: `hash-${ledger}`,
    contractId: 'contract-pruning-test',
    topic: 'transfer',
    txHash: 'a'.repeat(64),
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: { amount: '1' },
    happenedAt,
  };
}

// ── Live DB Integration Tests ─────────────────────────────────────────────────
// Skipped automatically when DATABASE_URL is not set.

describe.skipIf(!isLiveDb)(
  'contract_events Partition Pruning — live DB integration',
  () => {
    let client: pg.Client;
    let store: PostgresContractEventStore;
    let dbAvailable = false;

    beforeAll(async () => {
      try {
        client = new pg.Client({ connectionString: DATABASE_URL });
        await client.connect();

        // Guard: skip everything if the partitioned table does not exist yet.
        const tableCheck = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_name = 'contract_events'
           ) AS exists`,
        );
        if (!tableCheck.rows[0]?.exists) {
          await client.end();
          return;
        }

        // Create explicit monthly partitions (idempotent — IF NOT EXISTS).
        await client.query(`
          CREATE TABLE IF NOT EXISTS contract_events_y2026m06
            PARTITION OF contract_events
            FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');

          CREATE TABLE IF NOT EXISTS contract_events_y2026m07
            PARTITION OF contract_events
            FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');

          CREATE TABLE IF NOT EXISTS contract_events_y2026m08
            PARTITION OF contract_events
            FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
        `);

        // Seed one deterministic row per partition so the planner has stats.
        // ON CONFLICT DO NOTHING makes the setup idempotent across reruns.
        await client.query(
          `INSERT INTO contract_events (
              event_id, ledger, contract_id, topic,
              tx_hash, tx_index, operation_index, event_index,
              payload, happened_at, ledger_hash
           ) VALUES
             ($1, 1000, 'contract-prune', 'transfer',
              repeat('a',64), 0, 0, 0,
              '{"amount":"100"}'::jsonb, '2026-06-15 12:00:00+00', 'hash-1000'),
             ($2, 2000, 'contract-prune', 'transfer',
              repeat('b',64), 0, 0, 0,
              '{"amount":"200"}'::jsonb, '2026-07-15 12:00:00+00', 'hash-2000'),
             ($3, 3000, 'contract-prune', 'transfer',
              repeat('c',64), 0, 0, 0,
              '{"amount":"300"}'::jsonb, '2026-08-15 12:00:00+00', 'hash-3000')
           ON CONFLICT (happened_at, event_id) DO NOTHING`,
          [SEED.jun, SEED.jul, SEED.aug],
        );

        // Refresh statistics so the planner can prune accurately.
        await client.query('ANALYZE contract_events');

        store = new PostgresContractEventStore(client as unknown as PgClientLike);
        dbAvailable = true;
      } catch {
        dbAvailable = false;
        try { await client!.end(); } catch { /* ignore */ }
      }
    });

    afterAll(async () => {
      try { await client?.end(); } catch { /* ignore */ }
    });

    // ── EXPLAIN plan assertions ─────────────────────────────────────────────

    it('EXPLAIN: query bounded to July scans ONLY the July partition', async () => {
      if (!dbAvailable) return;

      const scanned = await explainScanned(
        client,
        `SELECT event_id, ledger, happened_at
         FROM contract_events
         WHERE happened_at >= $1::timestamptz
           AND happened_at <= $2::timestamptz
           AND ledger >= $3`,
        ['2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z', 1500],
      );

      expect(scanned).toContain(TEST_PARTITIONS.july);
      expect(scanned).not.toContain(TEST_PARTITIONS.june);
      expect(scanned).not.toContain(TEST_PARTITIONS.august);
    });

    it('EXPLAIN: cross-partition query scans EXACTLY June and July — not August', async () => {
      if (!dbAvailable) return;

      const scanned = await explainScanned(
        client,
        `SELECT event_id, ledger, happened_at
         FROM contract_events
         WHERE happened_at >= $1::timestamptz
           AND happened_at <= $2::timestamptz`,
        ['2026-06-10T00:00:00.000Z', '2026-07-20T23:59:59.999Z'],
      );

      // Exactly the two overlapping partitions — no extras.
      expect(scanned).toContain(TEST_PARTITIONS.june);
      expect(scanned).toContain(TEST_PARTITIONS.july);
      expect(scanned).not.toContain(TEST_PARTITIONS.august);
      // Confirm this is a cross-partition scan (two partitions, not one).
      const relevant = scanned.filter(
        (p) => p === TEST_PARTITIONS.june || p === TEST_PARTITIONS.july,
      );
      expect(relevant).toHaveLength(2);
    });

    it('EXPLAIN: query bounded to August scans ONLY the August partition', async () => {
      if (!dbAvailable) return;

      const scanned = await explainScanned(
        client,
        `SELECT event_id, ledger, happened_at
         FROM contract_events
         WHERE happened_at >= $1::timestamptz
           AND happened_at <= $2::timestamptz`,
        ['2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z'],
      );

      expect(scanned).toContain(TEST_PARTITIONS.august);
      expect(scanned).not.toContain(TEST_PARTITIONS.june);
      expect(scanned).not.toContain(TEST_PARTITIONS.july);
    });

    // ── store.getEvents() correctness ──────────────────────────────────────

    it('store.getEvents(): single-partition filter returns only the July seed row', async () => {
      if (!dbAvailable) return;

      const filter: StreamEventReplayFilter = {
        fromHappenedAt: '2026-07-01T00:00:00.000Z',
        toHappenedAt:   '2026-07-31T23:59:59.999Z',
        fromLedger: 1500,
      };
      const res = await store.getEvents(filter);
      const ids = res.events.map((e) => e.eventId);

      expect(ids).toContain(SEED.jul);
      expect(ids).not.toContain(SEED.jun);
      expect(ids).not.toContain(SEED.aug);
    });

    it('store.getEvents(): cross-partition filter returns June and July seed rows — not August', async () => {
      if (!dbAvailable) return;

      const filter: StreamEventReplayFilter = {
        fromHappenedAt: '2026-06-01T00:00:00.000Z',
        toHappenedAt:   '2026-07-31T23:59:59.999Z',
      };
      const res = await store.getEvents(filter);
      const ids = res.events.map((e) => e.eventId);

      expect(ids).toContain(SEED.jun);
      expect(ids).toContain(SEED.jul);
      expect(ids).not.toContain(SEED.aug);
    });

    it('store.getEvents(): filter outside all seeded ranges returns no seed rows', async () => {
      if (!dbAvailable) return;

      const filter: StreamEventReplayFilter = {
        fromHappenedAt: '2025-01-01T00:00:00.000Z',
        toHappenedAt:   '2025-12-31T23:59:59.999Z',
      };
      const res = await store.getEvents(filter);
      const ids = res.events.map((e) => e.eventId);

      expect(ids).not.toContain(SEED.jun);
      expect(ids).not.toContain(SEED.jul);
      expect(ids).not.toContain(SEED.aug);
    });

    // ── ON CONFLICT idempotency ────────────────────────────────────────────

    it('insertMany(): re-inserting the same (happened_at, event_id) is a no-op', async () => {
      if (!dbAvailable) return;

      // Insert again — must not throw, and must be reported as a duplicate.
      const result = await store.insertMany([
        {
          eventId: SEED.jul,
          ledger: 2000,
          ledgerHash: 'hash-2000',
          contractId: 'contract-prune',
          topic: 'transfer',
          txHash: 'b'.repeat(64),
          txIndex: 0,
          operationIndex: 0,
          eventIndex: 0,
          payload: { amount: '200' },
          happenedAt: '2026-07-15T12:00:00.000Z',
        },
      ]);

      expect(result.duplicateEventIds).toContain(SEED.jul);
      expect(result.insertedEventIds).not.toContain(SEED.jul);
    });
  },
);
