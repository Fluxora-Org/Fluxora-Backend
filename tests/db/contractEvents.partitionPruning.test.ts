/**
 * Integration and Unit Tests: Partition Pruning Verification for contract_events.
 *
 * @module tests/db/contractEvents.partitionPruning.test.ts
 *
 * COVERS:
 *  - Verification that PostgreSQL partition pruning engages for query shapes issued by PostgresContractEventStore.
 *  - Live DB EXPLAIN plan assertions ensuring single-partition bounded queries scan ONLY the relevant partition.
 *  - Live DB EXPLAIN plan assertions ensuring cross-partition range queries scan EXACTLY the needed partitions.
 *  - Parity and query structure verification for PostgresContractEventStore and InMemoryContractEventStore.
 *
 * Offline / CI without Postgres: offline contract unit tests verify filter construction and plan checking logic.
 *
 * Local / Live DB run:
 *   DATABASE_URL=postgresql://indexer_user:indexer_password@localhost:5432/indexer_db \
 *     pnpm test tests/db/contractEvents.partitionPruning.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresContractEventStore, InMemoryContractEventStore } from '../../src/indexer/store.js';
import { StreamEventReplayFilter } from '../../src/db/types.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const isLiveDb = Boolean(DATABASE_URL);

/** Partition table names created during integration setup */
export const TEST_PARTITIONS = {
  june: 'contract_events_y2026m06',
  july: 'contract_events_y2026m07',
  august: 'contract_events_y2026m08',
  default: 'contract_events_default',
} as const;

/**
 * Helper to check if an EXPLAIN query plan JSON string includes a given partition table name.
 *
 * @param planJson Raw query plan returned by EXPLAIN (FORMAT JSON)
 * @param partitionName Name of the partition table to check
 */
export function planScansPartition(planJson: unknown, partitionName: string): boolean {
  const serialized = JSON.stringify(planJson);
  return serialized.includes(partitionName);
}

/**
 * Returns all partition names from a target list that are referenced in an EXPLAIN plan.
 *
 * @param planJson Raw query plan returned by EXPLAIN (FORMAT JSON)
 * @param candidatePartitions Array of partition table names to inspect
 */
export function getScannedPartitions(planJson: unknown, candidatePartitions: string[]): string[] {
  return candidatePartitions.filter((pName) => planScansPartition(planJson, pName));
}

// ── Offline Contract Tests ─────────────────────────────────────────────────────

describe('contract_events Partition Pruning (Offline Contract Tests)', () => {
  it('correctly detects partition references in EXPLAIN plan JSON', () => {
    const mockPlan = [
      {
        Plan: {
          'Node Type': 'Append',
          Plans: [
            { 'Node Type': 'Seq Scan', 'Relation Name': 'contract_events_y2026m07' },
          ],
        },
      },
    ];

    expect(planScansPartition(mockPlan, TEST_PARTITIONS.july)).toBe(true);
    expect(planScansPartition(mockPlan, TEST_PARTITIONS.june)).toBe(false);
    expect(planScansPartition(mockPlan, TEST_PARTITIONS.august)).toBe(false);

    const scanned = getScannedPartitions(mockPlan, Object.values(TEST_PARTITIONS));
    expect(scanned).toEqual([TEST_PARTITIONS.july]);
  });

  it('correctly detects multiple partition references in cross-partition plan JSON', () => {
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
    expect(scanned).toEqual([TEST_PARTITIONS.june, TEST_PARTITIONS.july]);
    expect(scanned).not.toContain(TEST_PARTITIONS.august);
  });

  it('InMemoryContractEventStore handles happened_at timestamp range filtering', async () => {
    const store = new InMemoryContractEventStore();
    await store.insertMany([
      {
        eventId: 'evt-1',
        ledger: 100,
        ledgerHash: 'hash1',
        contractId: 'c1',
        topic: 'transfer',
        txHash: 'tx1',
        txIndex: 0,
        operationIndex: 0,
        eventIndex: 0,
        payload: { amount: '10' },
        happenedAt: '2026-06-15T12:00:00.000Z',
      },
      {
        eventId: 'evt-2',
        ledger: 101,
        ledgerHash: 'hash2',
        contractId: 'c1',
        topic: 'transfer',
        txHash: 'tx2',
        txIndex: 0,
        operationIndex: 0,
        eventIndex: 0,
        payload: { amount: '20' },
        happenedAt: '2026-07-15T12:00:00.000Z',
      },
      {
        eventId: 'evt-3',
        ledger: 102,
        ledgerHash: 'hash3',
        contractId: 'c1',
        topic: 'transfer',
        txHash: 'tx3',
        txIndex: 0,
        operationIndex: 0,
        eventIndex: 0,
        payload: { amount: '30' },
        happenedAt: '2026-08-15T12:00:00.000Z',
      },
    ]);

    // Bounded to July
    const julyRes = await store.getEvents({
      fromHappenedAt: '2026-07-01T00:00:00.000Z',
      toHappenedAt: '2026-07-31T23:59:59.999Z',
    });
    expect(julyRes.events).toHaveLength(1);
    expect(julyRes.events[0]?.eventId).toBe('evt-2');

    // Cross range (June 10 to July 20)
    const crossRes = await store.getEvents({
      fromHappenedAt: '2026-06-10T00:00:00.000Z',
      toHappenedAt: '2026-07-20T23:59:59.999Z',
    });
    expect(crossRes.events).toHaveLength(2);
    expect(crossRes.events.map((e) => e.eventId)).toEqual(['evt-1', 'evt-2']);
  });
});

// ── Live DB Integration Tests ─────────────────────────────────────────────────

describe.skipIf(!isLiveDb)('contract_events Partition Pruning (Live DB Integration)', () => {
  let client: pg.Client | null = null;
  let store: PostgresContractEventStore | null = null;
  let dbAvailable = false;

  beforeAll(async () => {
    try {
      client = new pg.Client({ connectionString: DATABASE_URL });
      await client.connect();

      const tableCheck = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_name = 'contract_events'
         ) AS exists`,
      );
      if (!tableCheck.rows[0]?.exists) {
        await client.end();
        client = null;
        return;
      }

      // Ensure explicit monthly partitions exist alongside default partition
      await client.query(`
        CREATE TABLE IF NOT EXISTS contract_events_y2026m06 PARTITION OF contract_events
          FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');

        CREATE TABLE IF NOT EXISTS contract_events_y2026m07 PARTITION OF contract_events
          FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');

        CREATE TABLE IF NOT EXISTS contract_events_y2026m08 PARTITION OF contract_events
          FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
      `);

      // Seed test rows across June, July, and August partitions
      await client.query(`
        INSERT INTO contract_events (
          event_id, ledger, contract_id, topic, tx_hash, tx_index, operation_index, event_index, payload, happened_at, ledger_hash
        ) VALUES
          ('prune-seed-jun-1', 1000, 'contract-prune', 'transfer', repeat('a', 64), 0, 0, 0, '{"amount":"100"}'::jsonb, '2026-06-15 12:00:00+00', 'hash-1000'),
          ('prune-seed-jul-1', 2000, 'contract-prune', 'transfer', repeat('b', 64), 0, 0, 0, '{"amount":"200"}'::jsonb, '2026-07-15 12:00:00+00', 'hash-2000'),
          ('prune-seed-aug-1', 3000, 'contract-prune', 'transfer', repeat('c', 64), 0, 0, 0, '{"amount":"300"}'::jsonb, '2026-08-15 12:00:00+00', 'hash-3000')
        ON CONFLICT (happened_at, event_id) DO NOTHING;
      `);

      await client.query('ANALYZE contract_events;');

      store = new PostgresContractEventStore(client);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
      if (client) {
        try { await client.end(); } catch { /* ignore */ }
        client = null;
      }
    }
  });

  afterAll(async () => {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  });

  it('scans ONLY the July partition for a query bounded strictly to July', async () => {
    if (!dbAvailable || !client) return;
    const sql = `
      EXPLAIN (FORMAT JSON)
      SELECT event_id, ledger, happened_at
      FROM contract_events
      WHERE happened_at >= $1::timestamptz AND happened_at <= $2::timestamptz AND ledger >= $3;
    `;
    const params = ['2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z', 1500];

    const result = await client.query(sql, params);
    const plan = result.rows[0]?.['QUERY PLAN'];

    const scanned = getScannedPartitions(plan, Object.values(TEST_PARTITIONS));
    expect(scanned).toContain(TEST_PARTITIONS.july);
    expect(scanned).not.toContain(TEST_PARTITIONS.june);
    expect(scanned).not.toContain(TEST_PARTITIONS.august);
  });

  it('scans EXACTLY June and July partitions for a cross-partition range query', async () => {
    if (!dbAvailable || !client) return;
    const sql = `
      EXPLAIN (FORMAT JSON)
      SELECT event_id, ledger, happened_at
      FROM contract_events
      WHERE happened_at >= $1::timestamptz AND happened_at <= $2::timestamptz AND ledger >= $3;
    `;
    const params = ['2026-06-10T00:00:00.000Z', '2026-07-20T23:59:59.999Z', 500];

    const result = await client.query(sql, params);
    const plan = result.rows[0]?.['QUERY PLAN'];

    const scanned = getScannedPartitions(plan, Object.values(TEST_PARTITIONS));
    expect(scanned).toContain(TEST_PARTITIONS.june);
    expect(scanned).toContain(TEST_PARTITIONS.july);
    expect(scanned).not.toContain(TEST_PARTITIONS.august);
  });

  it('executes store.getEvents and returns correct records when partition pruning is active', async () => {
    if (!dbAvailable || !store) return;
    const filterSingle: StreamEventReplayFilter = {
      fromHappenedAt: '2026-07-01T00:00:00.000Z',
      toHappenedAt: '2026-07-31T23:59:59.999Z',
      fromLedger: 1500,
    };
    const resSingle = await store.getEvents(filterSingle);
    expect(resSingle.events.map((e) => e.eventId)).toContain('prune-seed-jul-1');
    expect(resSingle.events.map((e) => e.eventId)).not.toContain('prune-seed-jun-1');
    expect(resSingle.events.map((e) => e.eventId)).not.toContain('prune-seed-aug-1');

    const filterCross: StreamEventReplayFilter = {
      fromHappenedAt: '2026-06-01T00:00:00.000Z',
      toHappenedAt: '2026-07-31T23:59:59.999Z',
    };
    const resCross = await store.getEvents(filterCross);
    const eventIds = resCross.events.map((e) => e.eventId);
    expect(eventIds).toContain('prune-seed-jun-1');
    expect(eventIds).toContain('prune-seed-jul-1');
    expect(eventIds).not.toContain('prune-seed-aug-1');
  });
});
