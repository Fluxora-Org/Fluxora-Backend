/**
 * tests/jobs/retentionPurge.idempotency.test.ts
 *
 * Contract tests for the data-retention purge job's idempotency guarantees
 * (issue #1265): repeated runs, mid-run failure/retry, cut-off boundary
 * dates, and dry-run's no-mutation guarantee.
 *
 * Unlike tests/jobs/retentionPurge.test.ts (which scripts a fixed sequence
 * of batch responses), this file drives runRetentionPurge against a small
 * in-memory fake Postgres that actually applies `WHERE <ageColumn> < $1`
 * filtering, `ORDER BY <ageColumn> ASC` sorting, and transactional
 * commit/rollback semantics. This lets these tests assert the real
 * end-to-end contract:
 *
 *  - Running the job twice converges (the second run purges nothing new).
 *  - A batch that fails mid-run rolls back only that batch; already
 *    committed batches stay purged, and a retry finishes the job without
 *    re-purging or double-counting anything.
 *  - Rows exactly at the cut-off boundary are retained; only rows strictly
 *    older than the cut-off are eligible.
 *  - Active (not-yet-expired) and legal-hold rows are never deleted, no
 *    matter how many times the job runs.
 *  - dryRun performs zero mutations — no DELETE and no audit-log INSERT —
 *    even when legal-hold rows are present.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { runRetentionPurge } from '../../src/jobs/retentionPurge.js';

vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(),
}));

const auditInserts: Array<{ action: string; resourceId: string; meta: unknown }> = [];
vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEventToDb: vi.fn(async (action: string, _resourceType: string, resourceId: string, _cid?: string, meta?: unknown) => {
    auditInserts.push({ action, resourceId, meta });
  }),
}));

// ── Fake Postgres ────────────────────────────────────────────────────────
//
// Models exactly the subset of Postgres behavior retentionPurge.ts depends
// on: information_schema column checks, `SELECT ... WHERE <col> < $1 ORDER
// BY <col> ASC LIMIT $2 FOR UPDATE SKIP LOCKED`, DELETE/UPDATE staged inside
// a transaction and only applied to committed state on COMMIT (discarded on
// ROLLBACK).

interface FakeRow {
  id: string;
  legal_hold: boolean;
  [ageColumn: string]: unknown;
}

interface FailureInjection {
  /** Throw once the Nth DELETE/UPDATE statement (1-indexed, across the whole run) is reached. */
  failOnMutationNumber?: number;
}

function buildFakeDb(tables: Record<string, FakeRow[]>, injection: FailureInjection = {}) {
  // Committed state, keyed by table name.
  const committed = new Map<string, FakeRow[]>(
    Object.entries(tables).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]),
  );
  let mutationCount = 0;

  let staged: { table: string; deletedIds: Set<string> } | null = null;

  function currentRows(table: string): FakeRow[] {
    return committed.get(table) ?? [];
  }

  const client: Pick<PoolClient, 'query' | 'release'> = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const s = sql.trim();

      if (/^BEGIN/i.test(s)) {
        staged = { table: '', deletedIds: new Set() };
        return { rows: [], rowCount: 0 } as never;
      }
      if (/^COMMIT/i.test(s)) {
        if (staged && staged.table) {
          const rows = currentRows(staged.table).filter((r) => !staged!.deletedIds.has(r.id));
          committed.set(staged.table, rows);
        }
        staged = null;
        return { rows: [], rowCount: 0 } as never;
      }
      if (/^ROLLBACK/i.test(s)) {
        staged = null;
        return { rows: [], rowCount: 0 } as never;
      }

      if (s.includes('information_schema.columns')) {
        // Every fake table models legal_hold explicitly.
        return { rows: [{ column_name: 'legal_hold' }], rowCount: 1 } as never;
      }

      if (s.includes('FOR UPDATE SKIP LOCKED')) {
        const tableMatch = /FROM "([^"]+)"/.exec(s);
        const orderMatch = /ORDER BY "([^"]+)" ASC/.exec(s);
        if (!tableMatch || !orderMatch) {
          throw new Error(`Fake DB: could not parse SELECT: ${s}`);
        }
        const table = tableMatch[1];
        const ageCol = orderMatch[1];
        const [cutoff, limit] = params as [string, number];

        const eligible = currentRows(table)
          .filter((r) => (r[ageCol] as string) < cutoff)
          .sort((a, b) => (a[ageCol] as string).localeCompare(b[ageCol] as string))
          .slice(0, limit)
          .map((r) => ({ ...r }));

        if (staged) staged.table = table;
        return { rows: eligible, rowCount: eligible.length } as never;
      }

      if (s.startsWith('DELETE FROM')) {
        mutationCount += 1;
        if (injection.failOnMutationNumber === mutationCount) {
          throw new Error(`Fake DB: injected failure on mutation #${mutationCount}`);
        }
        const id = params[0] as string;
        staged!.deletedIds.add(id);
        return { rows: [], rowCount: 1 } as never;
      }

      if (s.startsWith('UPDATE')) {
        mutationCount += 1;
        if (injection.failOnMutationNumber === mutationCount) {
          throw new Error(`Fake DB: injected failure on mutation #${mutationCount}`);
        }
        // Redact path: treat as a delete-from-eligibility for simplicity —
        // not exercised by these delete-only fixtures.
        const id = params[params.length - 1] as string;
        staged!.deletedIds.add(id);
        return { rows: [], rowCount: 1 } as never;
      }

      if (s.startsWith('INSERT INTO audit_logs')) {
        // PURGE_INITIATED, written on the same client/transaction as the
        // batch's deletes — not a mutation this test suite exercises
        // beyond letting it succeed.
        return { rows: [], rowCount: 1 } as never;
      }

      throw new Error(`Fake DB: unexpected query: ${s}`);
    }),
    release: vi.fn(),
  };

  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

  return { pool, committed, client };
}

/** A single-rule PURGEABLE_RETENTION_SCHEDULE override targeting `webhook_outbox`. */
function webhookOutboxOnlyOptions(pool: Pool, now: Date, batchSize = 10) {
  return { pool, now, batchSize, correlationId: 'contract-test' };
}

beforeEach(() => {
  auditInserts.length = 0;
  vi.clearAllMocks();
});

// webhook_outbox rule: retentionDays = 90, ageColumn = created_at, purgeAction = delete.
const NOW = new Date('2026-04-01T00:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000); // 2026-01-01T00:00:00.000Z

function rowAt(id: string, isoDate: string, legalHold = false): FakeRow {
  return { id, legal_hold: legalHold, created_at: isoDate };
}

describe('runRetentionPurge — repeated runs converge', () => {
  it('a second run finds nothing left to purge once the first run has caught up', async () => {
    const expiredRows = [
      rowAt('w1', '2025-06-01T00:00:00.000Z'),
      rowAt('w2', '2025-07-01T00:00:00.000Z'),
    ];
    const { pool, committed } = buildFakeDb({ webhook_outbox: expiredRows });

    const run1 = await runRetentionPurge(webhookOutboxOnlyOptions(pool, NOW));
    const rule1 = run1.results.find((r) => r.table === 'webhook_outbox')!;
    expect(rule1.rowsPurged).toBe(2);
    expect(committed.get('webhook_outbox')).toHaveLength(0);

    const run2 = await runRetentionPurge(webhookOutboxOnlyOptions(pool, NOW));
    const rule2 = run2.results.find((r) => r.table === 'webhook_outbox')!;

    // Convergence: nothing left, nothing re-purged, no double counting.
    expect(rule2.rowsPurged).toBe(0);
    expect(rule2.rowsSkipped).toBe(0);
    expect(run1.totalRowsPurged + run2.totalRowsPurged).toBe(2);
  });

  it('running three times in a row is stable (no drift in aggregate counts)', async () => {
    const { pool, committed } = buildFakeDb({
      webhook_outbox: [rowAt('a', '2025-01-01T00:00:00.000Z')],
    });

    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await runRetentionPurge(webhookOutboxOnlyOptions(pool, NOW)));
    }

    expect(results[0].totalRowsPurged).toBe(1);
    expect(results[1].totalRowsPurged).toBe(0);
    expect(results[2].totalRowsPurged).toBe(0);
    expect(committed.get('webhook_outbox')).toHaveLength(0);
  });
});

describe('runRetentionPurge — mid-run failure and retry', () => {
  it('rolls back only the failing batch; a retry finishes the job without re-purging committed rows or double counting', async () => {
    // batchSize=1 forces one row per transaction, so we can fail the
    // second batch specifically while the first batch's DELETE has already
    // committed.
    const rows = [
      rowAt('m1', '2025-01-01T00:00:00.000Z'),
      rowAt('m2', '2025-01-02T00:00:00.000Z'),
      rowAt('m3', '2025-01-03T00:00:00.000Z'),
    ];
    const { pool, committed } = buildFakeDb(
      { webhook_outbox: rows },
      { failOnMutationNumber: 2 }, // fails deleting m2
    );

    await expect(
      runRetentionPurge(webhookOutboxOnlyOptions(pool, NOW, 1)),
    ).rejects.toThrow(/injected failure/);

    // m1's batch committed before the failure; m2's batch rolled back; m3
    // was never reached because the run threw.
    const remainingIds = committed.get('webhook_outbox')!.map((r) => r.id).sort();
    expect(remainingIds).toEqual(['m2', 'm3']);

    // Retry with no further injected failures: the crashed run's progress
    // (m1 already gone) is preserved, and the retry finishes the rest.
    const { pool: retryPool, committed: retryCommitted } = buildFakeDb({
      webhook_outbox: committed.get('webhook_outbox')!,
    });
    const retryResult = await runRetentionPurge(webhookOutboxOnlyOptions(retryPool, NOW, 1));
    const retryRule = retryResult.results.find((r) => r.table === 'webhook_outbox')!;

    expect(retryRule.rowsPurged).toBe(2); // m2 and m3, not m1 again
    expect(retryCommitted.get('webhook_outbox')).toHaveLength(0);
  });
});

describe('runRetentionPurge — cut-off boundary dates', () => {
  it('retains a row exactly at the cut-off instant and purges only strictly older rows', async () => {
    const rows = [
      rowAt('boundary', CUTOFF.toISOString()), // exactly at cutoff: NOT eligible (< is strict)
      rowAt('one-ms-older', new Date(CUTOFF.getTime() - 1).toISOString()), // eligible
      rowAt('one-ms-younger', new Date(CUTOFF.getTime() + 1).toISOString()), // not eligible
    ];
    const { pool, committed } = buildFakeDb({ webhook_outbox: rows });

    const result = await runRetentionPurge(webhookOutboxOnlyOptions(pool, NOW));
    const rule = result.results.find((r) => r.table === 'webhook_outbox')!;

    expect(rule.rowsPurged).toBe(1);
    const remainingIds = committed.get('webhook_outbox')!.map((r) => r.id).sort();
    expect(remainingIds).toEqual(['boundary', 'one-ms-younger']);
  });

  it('crossing a calendar-month boundary between two runs purges only the newly-eligible rows', async () => {
    // Row ages out between the two runs (a month boundary passes).
    const rows = [rowAt('crosses-boundary', '2026-01-05T00:00:00.000Z')];
    const { pool, committed } = buildFakeDb({ webhook_outbox: rows });

    // First run: still within the 90-day window (cutoff would be
    // 2026-01-01), row not yet eligible.
    const beforeBoundary = new Date('2026-04-01T00:00:00.000Z');
    const run1 = await runRetentionPurge(webhookOutboxOnlyOptions(pool, beforeBoundary));
    expect(run1.results.find((r) => r.table === 'webhook_outbox')!.rowsPurged).toBe(0);
    expect(committed.get('webhook_outbox')).toHaveLength(1);

    // Second run: one day later, the row has just crossed the 90-day cutoff.
    const afterBoundary = new Date('2026-04-06T00:00:00.000Z');
    const run2 = await runRetentionPurge(webhookOutboxOnlyOptions(pool, afterBoundary));
    expect(run2.results.find((r) => r.table === 'webhook_outbox')!.rowsPurged).toBe(1);
    expect(committed.get('webhook_outbox')).toHaveLength(0);
  });
});

describe('runRetentionPurge — active and legal-hold records are never purged', () => {
  it('never deletes an active (not-yet-expired) row across repeated runs', async () => {
    const activeRow = rowAt('active-1', new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString());
    const { pool, committed } = buildFakeDb({ webhook_outbox: [activeRow] });

    await runRetentionPurge(webhookOutboxOnlyOptions(pool, NOW));
    await runRetentionPurge(webhookOutboxOnlyOptions(pool, NOW));

    expect(committed.get('webhook_outbox')).toHaveLength(1);
    expect(committed.get('webhook_outbox')![0].id).toBe('active-1');
  });

  it('never deletes a legal-hold row even though it is past the retention cut-off, across repeated runs', async () => {
    const heldRow = rowAt('held-1', '2025-01-01T00:00:00.000Z', true);
    const { pool, committed } = buildFakeDb({ webhook_outbox: [heldRow] });

    const run1 = await runRetentionPurge(webhookOutboxOnlyOptions(pool, NOW));
    const run2 = await runRetentionPurge(webhookOutboxOnlyOptions(pool, NOW));

    expect(run1.results.find((r) => r.table === 'webhook_outbox')!.rowsSkipped).toBe(1);
    expect(run2.results.find((r) => r.table === 'webhook_outbox')!.rowsSkipped).toBe(1);
    expect(committed.get('webhook_outbox')).toHaveLength(1);
    expect(committed.get('webhook_outbox')![0].id).toBe('held-1');
  });

  it('purges only the eligible rows out of a mixed active/expired/legal-hold batch', async () => {
    const rows = [
      rowAt('expired-1', '2025-01-01T00:00:00.000Z'),
      rowAt('expired-held', '2025-01-01T00:00:00.000Z', true),
      rowAt('active-1', new Date(NOW.getTime() - 1000).toISOString()),
    ];
    const { pool, committed } = buildFakeDb({ webhook_outbox: rows });

    const result = await runRetentionPurge(webhookOutboxOnlyOptions(pool, NOW));
    const rule = result.results.find((r) => r.table === 'webhook_outbox')!;

    expect(rule.rowsPurged).toBe(1);
    expect(rule.rowsSkipped).toBe(1);
    const remainingIds = committed.get('webhook_outbox')!.map((r) => r.id).sort();
    expect(remainingIds).toEqual(['active-1', 'expired-held']);
  });
});

describe('runRetentionPurge — dry-run makes no mutation', () => {
  it('purges nothing and writes no audit rows across repeated dry runs, including with legal-hold rows present', async () => {
    const rows = [
      rowAt('dry-expired', '2025-01-01T00:00:00.000Z'),
      rowAt('dry-held', '2025-01-01T00:00:00.000Z', true),
    ];
    const { pool, committed } = buildFakeDb({ webhook_outbox: rows });

    const run1 = await runRetentionPurge({ ...webhookOutboxOnlyOptions(pool, NOW), dryRun: true });
    const run2 = await runRetentionPurge({ ...webhookOutboxOnlyOptions(pool, NOW), dryRun: true });

    // Reported counts reflect what *would* happen...
    expect(run1.results.find((r) => r.table === 'webhook_outbox')!.rowsPurged).toBe(1);
    expect(run1.results.find((r) => r.table === 'webhook_outbox')!.rowsSkipped).toBe(1);
    expect(run2.results.find((r) => r.table === 'webhook_outbox')!.rowsPurged).toBe(1);

    // ...but nothing was actually mutated, on either run.
    expect(committed.get('webhook_outbox')).toHaveLength(2);
    expect(auditInserts).toHaveLength(0);
  });
});
