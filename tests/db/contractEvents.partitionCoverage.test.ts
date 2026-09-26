/**
 * Partition coverage guard — pre-write detection of missing partitions.
 *
 * @module tests/db/contractEvents.partitionCoverage.test.ts
 *
 * PURPOSE (issue #1456)
 * ---------------------
 * `src/jobs/partitionMaintenance.ts` pre-creates monthly partitions ahead of
 * schedule. That job is a *scheduled* defence, so between two runs time can
 * advance past the partitions it created (a deploy that never started the job,
 * an outage, a mis-set lead time) and the next write fails with an opaque
 * `no partition of relation "contract_events" found for row` — a write error
 * raised far from its cause, with nothing to alert on beforehand.
 *
 * These tests pin down the write-path half of the contract:
 *
 *  - `ensurePartitionCoverage()` probes the partitions a batch needs *before*
 *    the insert is issued, raises `partition_shortfall_detected` when one is
 *    missing, and self-heals by creating it.
 *  - The guard is fail-open: an unmanaged table, an unexpected probe shape, or
 *    a probe error leaves `insertMany()` behaving exactly as before.
 *  - `PostgresContractEventStore.insertMany()` therefore never reaches the
 *    database with a timestamp whose partition is missing *silently* — the
 *    shortfall is alerted on first (validation requirement of the issue).
 *
 * The suites run against a small in-memory emulation of Postgres that models
 * exactly the behaviour under test: a range-partitioned parent, a partition
 * catalog, `CREATE TABLE ... PARTITION OF`, and an INSERT that fails the way
 * Postgres fails when no partition covers the row. No live database is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import {
  ensurePartitionCoverage,
  runPartitionMaintenance,
  DEFAULT_LEAD_TIME_MONTHS,
  type PartitionQueryable,
} from '../../src/jobs/partitionMaintenance.js';
import { PostgresContractEventStore } from '../../src/indexer/store.js';
import { setAlertSink, type AlertEvent } from '../../src/lib/alerts.js';
import {
  alertsRaisedTotal,
  partitionMaintenanceFailuresTotal,
  partitionsCreatedTotal,
} from '../../src/metrics/businessMetrics.js';

// ── In-memory Postgres emulation ─────────────────────────────────────────────

/** `<table>_y<YYYY>m<MM>` for the UTC month containing `instant`. */
function partitionNameFor(table: string, instant: Date): string {
  const year = instant.getUTCFullYear();
  const month = (instant.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${table}_y${year}m${month}`;
}

interface FakeDb {
  pool: Pool;
  client: {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number }>;
    release: () => void;
  };
  /** Partitions that currently exist, mutated by CREATE TABLE statements. */
  partitions: Set<string>;
  /** Every statement issued, in order. */
  statements: Array<{ sql: string; params?: unknown[] }>;
  /** Statements that actually created a partition. */
  created: string[];
}

/**
 * Build a fake database emulating the parts of Postgres this feature depends on.
 *
 * @param options.partitioned - Whether `contract_events` is range-partitioned.
 * @param options.failCreateFor - Partition name whose `CREATE TABLE` fails with
 *   a realistic `permission denied` error.
 */
function createFakeDb(options: { partitioned?: boolean; failCreateFor?: string } = {}): FakeDb {
  const partitioned = options.partitioned ?? true;
  const partitions = new Set<string>();
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const created: string[] = [];

  /** Only `contract_events` is range-partitioned; `audit_logs` is a plain table. */
  const isManaged = (table: string) => partitioned && table === 'contract_events';

  const query = async <T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> => {
    statements.push({ sql, params });

    const asRows = (rows: unknown[]): T[] => rows as unknown as T[];

    // Advisory-lock lifecycle (partition-maintenance job).
    if (sql.includes('pg_try_advisory_lock')) {
      return { rows: asRows([{ pg_try_advisory_lock: true }]), rowCount: 1 };
    }
    if (sql.includes('pg_advisory_unlock')) {
      return { rows: asRows([{ pg_advisory_unlock: true }]), rowCount: 1 };
    }
    if (sql.includes('SET statement_timeout')) {
      return { rows: asRows([]), rowCount: 0 };
    }

    // Pre-write coverage probe: parent management + per-partition existence in
    // one statement. A table that does not exist yields zero rows.
    if (sql.includes('unnest($2::text[])')) {
      const table = params?.[0] as string;
      if (!isManaged(table)) return { rows: asRows([]), rowCount: 0 };
      const names = (params?.[1] ?? []) as string[];
      const rows = names.map((partition) => ({
        managed: true,
        partition,
        partition_exists: partitions.has(partition),
      }));
      return { rows: asRows(rows), rowCount: rows.length };
    }

    // Partition-maintenance job: is the table range-partitioned?
    if (sql.includes('pg_partitioned_table')) {
      return isManaged(params?.[0] as string)
        ? { rows: asRows([{ relkind: 'p', partstrat: 'r' }]), rowCount: 1 }
        : { rows: asRows([]), rowCount: 0 };
    }

    // Partition-maintenance job: does this partition already exist?
    if (sql.includes('to_regclass($1) IS NOT NULL')) {
      return {
        rows: asRows([{ exists: partitions.has(params?.[0] as string) }]),
        rowCount: 1,
      };
    }

    const create = /CREATE TABLE IF NOT EXISTS "([^"]+)" PARTITION OF "([^"]+)"/.exec(sql);
    if (create) {
      const [, partitionName] = create;
      if (partitionName === options.failCreateFor) {
        throw new Error(`permission denied for table ${create[2]}`);
      }
      partitions.add(partitionName);
      created.push(partitionName);
      return { rows: asRows([]), rowCount: 0 };
    }

    // Canonical insert. Emulate Postgres: fail when no partition covers a row.
    if (sql.includes('INSERT INTO contract_events')) {
      const values = (params ?? []) as unknown[];
      for (let offset = 0; offset < values.length; offset += 12) {
        const happenedAt = new Date(values[offset + 9] as string);
        if (partitioned && !partitions.has(partitionNameFor('contract_events', happenedAt))) {
          throw new Error('no partition of relation "contract_events" found for row');
        }
      }
      const eventIds = values.filter((_value, index) => index % 12 === 0) as string[];
      return {
        rows: asRows(eventIds.map((event_id) => ({ event_id }))),
        rowCount: eventIds.length,
      };
    }

    throw new Error(`Unexpected statement in fake database: ${sql}`);
  };

  const client = { query, release: () => {} };

  return {
    pool: { connect: async () => client } as unknown as Pool,
    client,
    partitions,
    statements,
    created,
  };
}

/** Minimal contract-event record factory. */
function makeEvent(eventId: string, happenedAt: string, ledger = 1) {
  return {
    eventId,
    ledger,
    contractId: 'C1',
    topic: 'stream.created',
    txHash: `tx-${eventId}`,
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: { amount: '1' },
    happenedAt,
    ledgerHash: `hash-${ledger}`,
  };
}

const FIXED_NOW = new Date('2026-07-15T12:00:00.000Z');

let alerts: AlertEvent[];

beforeEach(() => {
  alerts = [];
  setAlertSink((alert) => alerts.push(alert));
  partitionsCreatedTotal.reset();
  partitionMaintenanceFailuresTotal.reset();
  alertsRaisedTotal.reset();
});

afterEach(() => {
  setAlertSink(null);
  vi.restoreAllMocks();
});

// ── ensurePartitionCoverage ──────────────────────────────────────────────────

describe('ensurePartitionCoverage', () => {
  it('reports the partitions a batch needs, deduplicating months', async () => {
    const db = createFakeDb();
    db.partitions.add('contract_events_y2026m07');
    db.partitions.add('contract_events_y2026m08');

    const result = await ensurePartitionCoverage(db.client, 'contract_events', [
      '2026-07-01T00:00:00.000Z',
      '2026-07-20T23:59:59.000Z',
      '2026-08-02T10:00:00.000Z',
    ]);

    expect(result.managed).toBe(true);
    expect(result.required).toEqual(['contract_events_y2026m07', 'contract_events_y2026m08']);
    expect(result.present).toEqual(result.required);
    expect(result.missing).toEqual([]);
    expect(result.healed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(alerts).toEqual([]);

    // Exactly one catalog round-trip, and no DDL when everything is in place.
    expect(db.statements).toHaveLength(1);
    expect(db.created).toEqual([]);
  });

  it('raises partition_shortfall_detected and heals the missing partition', async () => {
    const db = createFakeDb();

    const result = await ensurePartitionCoverage(db.client, 'contract_events', [
      '2026-09-03T00:00:00.000Z',
    ]);

    expect(result.missing).toEqual(['contract_events_y2026m09']);
    expect(result.healed).toEqual(['contract_events_y2026m09']);
    expect(result.failed).toEqual([]);
    expect(db.partitions.has('contract_events_y2026m09')).toBe(true);

    expect(alerts.map((a) => a.name)).toEqual(['partition_shortfall_detected']);
    expect(alerts[0]?.severity).toBe('critical');

    // The DDL uses half-open UTC month bounds for the month that was needed.
    const ddl = db.statements.find((s) => s.sql.includes('CREATE TABLE IF NOT EXISTS'));
    expect(ddl?.sql).toContain("FROM ('2026-09-01T00:00:00.000Z') TO ('2026-10-01T00:00:00.000Z')");
  });

  it('detects without creating when healing is disabled', async () => {
    const db = createFakeDb();

    const result = await ensurePartitionCoverage(
      db.client,
      'contract_events',
      ['2026-09-03T00:00:00.000Z'],
      { heal: false },
    );

    expect(result.missing).toEqual(['contract_events_y2026m09']);
    expect(result.healed).toEqual([]);
    expect(result.failed).toEqual(['contract_events_y2026m09']);
    expect(db.created).toEqual([]);
    expect(alerts.map((a) => a.name)).toEqual(['partition_shortfall_detected']);
  });

  it('raises partition_creation_failed and reports the partition as failed when the DDL fails', async () => {
    const failureSpy = vi.spyOn(partitionMaintenanceFailuresTotal, 'inc');
    const db = createFakeDb({ failCreateFor: 'contract_events_y2026m09' });

    const result = await ensurePartitionCoverage(db.client, 'contract_events', [
      '2026-09-03T00:00:00.000Z',
    ]);

    expect(result.healed).toEqual([]);
    expect(result.failed).toEqual(['contract_events_y2026m09']);
    expect(alerts.map((a) => a.name)).toEqual([
      'partition_shortfall_detected',
      'partition_creation_failed',
    ]);
    expect(alerts[1]?.context?.partition).toBe('contract_events_y2026m09');
    expect(failureSpy).toHaveBeenCalledWith({ table: 'contract_events' });
  });

  it('does nothing for a table that is not range-partitioned', async () => {
    const db = createFakeDb({ partitioned: false });

    const result = await ensurePartitionCoverage(db.client, 'contract_events', [
      '2026-09-03T00:00:00.000Z',
    ]);

    expect(result.managed).toBe(false);
    expect(result.missing).toEqual([]);
    expect(db.created).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('is fail-open when the probe response has an unexpected shape', async () => {
    // Regression guard: existing store tests use clients that answer every
    // query with the same canned rows. Those rows carry no coverage fields, so
    // the probe must be treated as inconclusive rather than as "everything is
    // missing" (which would attempt DDL against a non-partitioned table).
    const statement = vi.fn(async () => ({ rows: [{ event_id: 'e1' }], rowCount: 1 }));

    const result = await ensurePartitionCoverage(
      { query: statement } as unknown as PartitionQueryable,
      'contract_events',
      ['2026-09-03T00:00:00.000Z'],
    );

    expect(result.managed).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.healed).toEqual([]);
    expect(alerts).toEqual([]);
    expect(statement).toHaveBeenCalledTimes(1);
  });

  it('never throws when the probe query itself fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('connection terminated unexpectedly');
    });
    const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await ensurePartitionCoverage(
      { query: failing } as unknown as PartitionQueryable,
      'contract_events',
      ['2026-09-03T00:00:00.000Z'],
    );

    expect(result.managed).toBe(false);
    expect(result.failed).toEqual([]);
    const logged = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('partition_coverage_probe_failed'));
    expect(logged).toBeDefined();
  });

  it('ignores unparseable timestamps and checks nothing for an empty batch', async () => {
    const db = createFakeDb();

    const empty = await ensurePartitionCoverage(db.client, 'contract_events', []);
    const garbage = await ensurePartitionCoverage(db.client, 'contract_events', ['not-a-date']);

    expect(empty.required).toEqual([]);
    expect(garbage.required).toEqual([]);
    expect(db.statements).toEqual([]);
  });
});

// ── Validation: shortfall detected before a write fails ──────────────────────

describe('PostgresContractEventStore — partition shortfall is detected before the write fails', () => {
  it('detects and heals the shortfall after time advances past the pre-created partitions', async () => {
    const db = createFakeDb();

    // 1. The scheduled job runs in July and pre-creates the current month plus
    //    the two months inside the configured lead time.
    const run = await runPartitionMaintenance(db.pool, { now: FIXED_NOW, leadTimeMonths: 2 });
    expect(run.tables[0]?.partitionsCreated).toEqual([
      'contract_events_y2026m07',
      'contract_events_y2026m08',
      'contract_events_y2026m09',
    ]);
    // The very first run on an empty database legitimately reports
    // "behind schedule" (there was nothing to inherit); drop that alert so the
    // assertions below are about the write-path guard only.
    alerts.length = 0;

    // 2. The job then fails to run for months (deploy that never started it,
    //    outage, ...): time advances past every partition that was created,
    //    so November has no partition at all.
    const store = new PostgresContractEventStore(db.client);

    // 3. The next write is for a month with no partition. The guard detects the
    //    shortfall *before* the INSERT is issued, alerts, and heals it — so the
    //    write succeeds instead of failing with a partition error.
    const result = await store.insertMany([makeEvent('evt-nov', '2026-11-20T00:00:00.000Z')]);

    expect(result.insertedEventIds).toEqual(['evt-nov']);
    expect(alerts.map((a) => a.name)).toEqual(['partition_shortfall_detected']);
    expect(alerts[0]?.context?.table).toBe('contract_events');
    expect(db.partitions.has('contract_events_y2026m11')).toBe(true);

    // Ordering proof: the healing DDL is issued before the failing INSERT would
    // have been — i.e. detection precedes the write, not the error.
    const createIndex = db.statements.findIndex((s) => s.sql.includes('CREATE TABLE IF NOT EXISTS'));
    const insertIndex = db.statements.findIndex((s) => s.sql.includes('INSERT INTO contract_events'));
    expect(createIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(createIndex);
  });

  it('alerts on the shortfall before the write fails when the partition cannot be created', async () => {
    const db = createFakeDb({ failCreateFor: 'contract_events_y2026m11' });
    const store = new PostgresContractEventStore(db.client);

    // No partition exists for November and creating one fails, so the INSERT
    // still fails — but by then the shortfall and the failed create have both
    // been alerted on, instead of surfacing only as a write error.
    await expect(
      store.insertMany([makeEvent('evt-nov', '2026-11-20T00:00:00.000Z')]),
    ).rejects.toThrow(/no partition of relation "contract_events" found for row/);

    expect(alerts.map((a) => a.name)).toEqual([
      'partition_shortfall_detected',
      'partition_creation_failed',
    ]);
    expect(alerts[1]?.severity).toBe('critical');
    expect(alerts[1]?.context?.table).toBe('contract_events');
  });

  it('leaves insertMany unchanged for a non-partitioned table', async () => {
    const db = createFakeDb({ partitioned: false });
    const store = new PostgresContractEventStore(db.client);

    const result = await store.insertMany([makeEvent('evt-1', '2026-11-20T00:00:00.000Z')]);

    expect(result.insertedEventIds).toEqual(['evt-1']);
    expect(result.duplicateEventIds).toEqual([]);
    expect(alerts).toEqual([]);
    expect(db.created).toEqual([]);
  });

  it('uses the documented default lead time when none is configured', () => {
    expect(DEFAULT_LEAD_TIME_MONTHS).toBeGreaterThanOrEqual(2);
  });
});
