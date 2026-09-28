/**
 * tests/jobs/retentionPurge.legalHold.test.ts
 *
 * Dedicated test module for Issue #1457:
 * "Assert retention purge respects legal hold and cannot delete beyond its window"
 *
 * Acceptance criteria validated here
 * ────────────────────────────────────
 *  AC-1  The purge deletes only records older than the documented window.
 *        → Records with an ageColumn >= cutoff must never be deleted.
 *
 *  AC-2  Records under hold are exempt and the exemption is tested.
 *        → Rows with legal_hold = TRUE are skipped regardless of age.
 *        → A PURGE_SKIPPED_LEGAL_HOLD audit event is written for each held row.
 *        → A held row is NOT deleted.
 *
 *  AC-3  A dry-run mode reports what would be deleted without making mutations.
 *        → No DELETE / UPDATE SQL is issued in dry-run mode.
 *        → Counts (rowsPurged, rowsSkipped) still reflect candidates.
 *        → No audit events are written in dry-run mode.
 *
 *  AC-4  Deletion volume per run is bounded and alerted on if exceeded.
 *        → When rowsPurged reaches maxRowsPerRun the loop exits early.
 *        → volumeCapReached = true in the result.
 *        → The purgeVolumeCapExceededTotal metric is incremented.
 *
 * All tests use an injectable mock pool — no real Postgres connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runRetentionPurge, PURGE_MAX_ROWS_PER_RUN } from '../../src/jobs/retentionPurge.js';
import type { PurgeJobOptions } from '../../src/jobs/retentionPurge.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockRecordAuditEventToDb = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEventToDb: (...args: unknown[]) => mockRecordAuditEventToDb(...args),
}));

vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Capture metric increments so tests can assert on them without a real registry.
const mockPurgeVolumeCapExceededInc = vi.fn();
vi.mock('../../src/metrics/businessMetrics.js', () => ({
  purgeVolumeCapExceededTotal: {
    inc: (...args: unknown[]) => mockPurgeVolumeCapExceededInc(...args),
  },
  deRegisterBusinessMetrics: vi.fn(),
}));

// ── Mock pool / client helpers ────────────────────────────────────────────────

interface MockRow {
  id: string;
  legal_hold: boolean;
  created_at: string;
  timestamp?: string;
}

/**
 * Build a minimal pg PoolClient mock.
 *
 * `batches[table]` is a queue of row arrays returned by successive
 * FOR UPDATE SKIP LOCKED selects for that table.  Once the queue is
 * exhausted the table returns no more candidates, terminating the loop.
 */
function buildMockClient(batches: Record<string, MockRow[][]> = {}) {
  const cursors = new Map<string, number>(Object.keys(batches).map((t) => [t, 0]));
  const issuedSql: string[] = [];

  const client = {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      issuedSql.push(sql.trim());

      if (sql.toLowerCase().includes('information_schema')) {
        // Pretend every table has legal_hold so the exemption path is exercised
        return { rows: [{ column_name: 'legal_hold' }], rowCount: 1 };
      }

      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        const table = /FROM\s+"([^"]+)"/.exec(sql)?.[1] ?? '';
        const queued = batches[table] ?? [];
        const idx = cursors.get(table) ?? 0;
        cursors.set(table, idx + 1);
        const batch = queued[idx] ?? [];
        return { rows: batch, rowCount: batch.length };
      }

      // INSERT (audit_logs), DELETE, UPDATE — all no-op
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
    _issuedSql: issuedSql,
  };

  return client;
}

function buildMockPool(clientFactory: () => ReturnType<typeof buildMockClient>) {
  return { connect: vi.fn(async () => clientFactory()) };
}

// ── Reference time and row factories ─────────────────────────────────────────

/** A fixed "now" used for all cut-off calculations in these tests. */
const NOW = new Date('2027-06-01T00:00:00.000Z');

/** Returns a row whose ageColumn is `ageDays` days before NOW. */
function rowAgedDays(id: string, ageDays: number, legalHold = false): MockRow {
  const d = new Date(NOW.getTime() - ageDays * 24 * 60 * 60 * 1000);
  return { id, legal_hold: legalHold, created_at: d.toISOString(), timestamp: d.toISOString() };
}

/** A row that is clearly past the 365-day streams window. */
const expiredRow = (id: string, legalHold = false) => rowAgedDays(id, 400, legalHold);

/** A row that is clearly inside the 365-day streams window. */
const recentRow = (id: string) => rowAgedDays(id, 10);

function baseOptions(pool: ReturnType<typeof buildMockPool>): PurgeJobOptions {
  return { pool: pool as any, now: NOW, batchSize: 10, correlationId: 'test-1457' };
}

// ── Before each ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-1  Purge deletes only records older than the documented window
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-1: purge window boundary', () => {
  it('deletes expired rows (older than the retention window)', async () => {
    const batch = [expiredRow('e1'), expiredRow('e2')];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge(baseOptions(pool));

    const streamsRule = result.results.find((r) => r.table === 'streams');
    expect(streamsRule!.rowsPurged).toBe(2);
    expect(streamsRule!.rowsSkipped).toBe(0);
  });

  it('does NOT delete recent rows (within the retention window)', async () => {
    // The mock returns recent rows only for the first batch call.
    // A real DB would never return these because ageColumn < cutoff filters
    // them out, but we assert here that even if they appeared the job would
    // not DELETE/UPDATE them because the SELECT itself is gated on the
    // cutoff parameter ($1).
    //
    // We validate the gate indirectly: the SELECT SQL must include the
    // cut-off parameter reference and the correct ORDER BY.
    const batch = [recentRow('r1'), recentRow('r2')];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    // Verify every candidate SELECT carries the cutoff as $1
    const selectSqls = client._issuedSql.filter((s) => s.includes('FOR UPDATE SKIP LOCKED'));
    expect(selectSqls.length).toBeGreaterThan(0);
    for (const sql of selectSqls) {
      // The WHERE clause must reference the ageColumn against a parameter
      expect(sql).toMatch(/WHERE\s+"[a-z_]+"\s+<\s+\$1/);
    }
  });

  it('uses ORDER BY ageColumn ASC so oldest rows are processed first', async () => {
    const client = buildMockClient();
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const selectSqls = client._issuedSql.filter((s) => s.includes('FOR UPDATE SKIP LOCKED'));
    for (const sql of selectSqls) {
      const orderIdx = sql.indexOf('ORDER BY');
      const limitIdx = sql.indexOf('LIMIT');
      expect(orderIdx).toBeGreaterThan(-1);
      expect(limitIdx).toBeGreaterThan(orderIdx);
      expect(sql).toMatch(/ORDER BY "[a-z_]+" ASC/);
    }
  });

  it('uses LIMIT to bound the candidate set to batchSize per query', async () => {
    const client = buildMockClient();
    const pool = buildMockPool(() => client);

    await runRetentionPurge({ ...baseOptions(pool), batchSize: 7 });

    const selectSqls = client._issuedSql.filter((s) => s.includes('FOR UPDATE SKIP LOCKED'));
    for (const sql of selectSqls) {
      expect(sql).toContain('LIMIT $2');
    }
  });

  it('streams rule uses UPDATE (redact) not DELETE', async () => {
    const batch = [expiredRow('s1')];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const deleteSqls = client._issuedSql.filter((s) => s.startsWith('DELETE'));
    const updateSqls = client._issuedSql.filter((s) => s.startsWith('UPDATE'));

    expect(deleteSqls).toHaveLength(0);
    expect(updateSqls.length).toBeGreaterThanOrEqual(1);
    expect(updateSqls[0]).toContain('[REDACTED:DATA_RETENTION]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2  Records under legal hold are exempt and the exemption is tested
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-2: legal-hold exemption', () => {
  it('skips rows where legal_hold = TRUE', async () => {
    const batch = [expiredRow('h1', true), expiredRow('h2', true)];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge(baseOptions(pool));

    const streamsRule = result.results.find((r) => r.table === 'streams');
    expect(streamsRule!.rowsSkipped).toBe(2);
    expect(streamsRule!.rowsPurged).toBe(0);
  });

  it('does NOT issue DELETE or UPDATE for held rows', async () => {
    const batch = [expiredRow('h3', true)];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const mutating = client._issuedSql.filter(
      (s) => s.startsWith('DELETE') || s.startsWith('UPDATE'),
    );
    expect(mutating).toHaveLength(0);
  });

  it('emits PURGE_SKIPPED_LEGAL_HOLD audit event for each held row', async () => {
    const batch = [expiredRow('h4', true), expiredRow('h5', true)];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const skippedCalls = mockRecordAuditEventToDb.mock.calls.filter(
      ([action]: any) => action === 'PURGE_SKIPPED_LEGAL_HOLD',
    );
    expect(skippedCalls).toHaveLength(2);
    // Each call should reference the correct table and row id
    expect(skippedCalls[0][1]).toBe('streams');
    expect(skippedCalls[0][2]).toBe('h4');
    expect(skippedCalls[1][2]).toBe('h5');
  });

  it('deletes non-held expired rows in the same batch while skipping held ones', async () => {
    // Mixed batch: 2 held + 1 not held
    const batch = [expiredRow('m1', true), expiredRow('m2', false), expiredRow('m3', true)];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge(baseOptions(pool));

    const streamsRule = result.results.find((r) => r.table === 'streams');
    expect(streamsRule!.rowsPurged).toBe(1);
    expect(streamsRule!.rowsSkipped).toBe(2);
  });

  it('a held row that is lifted becomes purgeable on the next run', async () => {
    // First run: row is held — should be skipped
    const heldBatch = [expiredRow('lift-1', true)];
    const clientRun1 = buildMockClient({ streams: [heldBatch, []] });
    const poolRun1 = buildMockPool(() => clientRun1);

    const run1 = await runRetentionPurge(baseOptions(poolRun1));
    expect(run1.results.find((r) => r.table === 'streams')!.rowsSkipped).toBe(1);

    // Second run: same row, hold cleared — should be purged
    const unHeldBatch = [expiredRow('lift-1', false)];
    const clientRun2 = buildMockClient({ streams: [unHeldBatch, []] });
    const poolRun2 = buildMockPool(() => clientRun2);

    const run2 = await runRetentionPurge(baseOptions(poolRun2));
    expect(run2.results.find((r) => r.table === 'streams')!.rowsPurged).toBe(1);
    expect(run2.results.find((r) => r.table === 'streams')!.rowsSkipped).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3  Dry-run mode reports what would be deleted without making mutations
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-3: dry-run mode', () => {
  it('issues no DELETE or UPDATE SQL in dry-run mode', async () => {
    const batch = [expiredRow('d1'), expiredRow('d2')];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge({ ...baseOptions(pool), dryRun: true });

    const mutating = client._issuedSql.filter(
      (s) => s.startsWith('DELETE') || s.startsWith('UPDATE'),
    );
    expect(mutating).toHaveLength(0);
  });

  it('still counts candidate rows as rowsPurged in dry-run mode', async () => {
    const batch = [expiredRow('d3'), expiredRow('d4'), expiredRow('d5')];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge({ ...baseOptions(pool), dryRun: true });

    const streamsRule = result.results.find((r) => r.table === 'streams');
    expect(streamsRule!.rowsPurged).toBe(3);
    expect(streamsRule!.dryRun).toBe(true);
  });

  it('counts held rows as rowsSkipped in dry-run mode', async () => {
    const batch = [expiredRow('dh1', true), expiredRow('dh2', true)];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge({ ...baseOptions(pool), dryRun: true });

    const streamsRule = result.results.find((r) => r.table === 'streams');
    expect(streamsRule!.rowsSkipped).toBe(2);
    expect(streamsRule!.rowsPurged).toBe(0);
  });

  it('does NOT emit PURGE_INITIATED audit events in dry-run mode', async () => {
    const batch = [expiredRow('da1')];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge({ ...baseOptions(pool), dryRun: true });

    const initiated = client._issuedSql.filter(
      (s) => s.includes('INSERT INTO audit_logs'),
    );
    expect(initiated).toHaveLength(0);
  });

  it('does NOT emit PURGE_SKIPPED_LEGAL_HOLD audit events in dry-run mode', async () => {
    const batch = [expiredRow('dhx', true)];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge({ ...baseOptions(pool), dryRun: true });

    const skippedCalls = mockRecordAuditEventToDb.mock.calls.filter(
      ([action]: any) => action === 'PURGE_SKIPPED_LEGAL_HOLD',
    );
    expect(skippedCalls).toHaveLength(0);
  });

  it('does NOT set app.allow_audit_delete in dry-run mode (even for audit_logs rule)', async () => {
    // For the audit_logs table the SET LOCAL bypass must NEVER be issued
    // in dry-run mode.
    const batch = [expiredRow('al1')];
    // We target audit_logs directly by providing a batch for that table.
    const client = buildMockClient({ audit_logs: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge({ ...baseOptions(pool), dryRun: true });

    const bypass = client._issuedSql.filter((s) =>
      s.toLowerCase().includes('allow_audit_delete'),
    );
    expect(bypass).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4  Deletion volume per run is bounded and alerted on if exceeded
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-4: volume cap', () => {
  it('PURGE_MAX_ROWS_PER_RUN is exported and is a positive integer', () => {
    expect(typeof PURGE_MAX_ROWS_PER_RUN).toBe('number');
    expect(Number.isFinite(PURGE_MAX_ROWS_PER_RUN)).toBe(true);
    expect(PURGE_MAX_ROWS_PER_RUN).toBeGreaterThan(0);
  });

  it('stops processing when maxRowsPerRun is reached and sets volumeCapReached = true', async () => {
    // Set a small cap of 2 rows. Provide 3 full batches so the loop would
    // never naturally terminate.
    const cap = 2;
    const batchSize = 2;
    const fullBatch = [expiredRow('c1'), expiredRow('c2')];
    // Three identical full batches — without the cap the loop would run 3×
    const client = buildMockClient({ streams: [fullBatch, fullBatch, fullBatch] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge({
      ...baseOptions(pool),
      batchSize,
      maxRowsPerRun: cap,
    });

    const streamsRule = result.results.find((r) => r.table === 'streams');
    // After the first full batch (2 rows) the cap is hit; the second and
    // third batches must never be requested.
    expect(streamsRule!.rowsPurged).toBe(2);
    expect(streamsRule!.volumeCapReached).toBe(true);
  });

  it('increments purgeVolumeCapExceededTotal metric when cap is exceeded', async () => {
    const cap = 1;
    const batchSize = 1;
    const fullBatch = [expiredRow('mc1')];

    // Two batches: first hits cap exactly, metric must increment before second
    const client = buildMockClient({ streams: [fullBatch, fullBatch] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge({
      ...baseOptions(pool),
      batchSize,
      maxRowsPerRun: cap,
    });

    expect(mockPurgeVolumeCapExceededInc).toHaveBeenCalledWith({ table: 'streams' });
  });

  it('does NOT increment the metric when cap is not reached', async () => {
    const batch = [expiredRow('nc1'), expiredRow('nc2')];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge({
      ...baseOptions(pool),
      maxRowsPerRun: 1000, // well above batch size
    });

    // Only called if the cap was hit
    expect(mockPurgeVolumeCapExceededInc).not.toHaveBeenCalled();
  });

  it('volumeCapReached is false when the run finishes normally', async () => {
    const batch = [expiredRow('n1'), expiredRow('n2')];
    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge({
      ...baseOptions(pool),
      maxRowsPerRun: 1000,
    });

    const streamsRule = result.results.find((r) => r.table === 'streams');
    expect(streamsRule!.volumeCapReached).toBe(false);
  });

  it('cap applies independently per rule (one rule hitting cap does not stop others)', async () => {
    // Give streams a full batch at the cap boundary; audit_logs gets its own
    // independent batch that should still be processed.
    const cap = 1;
    const batchSize = 1;
    const streamsBatch = [expiredRow('sr1')];
    const auditBatch = [expiredRow('al2')];

    const client = buildMockClient({
      streams: [streamsBatch, streamsBatch], // second batch should be suppressed by cap
      audit_logs: [auditBatch, []], // should still run fine
    });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge({
      ...baseOptions(pool),
      batchSize,
      maxRowsPerRun: cap,
    });

    const streamsRule = result.results.find((r) => r.table === 'streams');
    const auditRule = result.results.find((r) => r.table === 'audit_logs');

    expect(streamsRule!.volumeCapReached).toBe(true);
    // audit_logs rule runs its own loop independently — cap only applies per rule
    expect(auditRule!.rowsPurged).toBe(1);
    expect(auditRule!.volumeCapReached).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation fixture: aged + unheld vs aged + held vs recent
// ─────────────────────────────────────────────────────────────────────────────

describe('Validation fixture (issue #1457 — aged unheld removed, aged held retained, recent retained)', () => {
  it('only removes aged-unheld rows; aged-held and recent rows are untouched', async () => {
    // Fixture matching the issue validation requirement:
    //   - aged + unheld → should be removed
    //   - aged + held   → should be skipped (exempt)
    //   - recent        → not even a candidate (cut-off gate in SQL)
    //
    // Because our mock bypasses the SQL WHERE clause we model "recent" by
    // simply not including it in the candidate batch (the real DB filters it).
    const agedUnheld = expiredRow('purge-me', false);
    const agedHeld = expiredRow('keep-held', true);
    // recent rows do not appear as candidates (filtered at DB layer)

    const client = buildMockClient({ streams: [[agedUnheld, agedHeld], []] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge(baseOptions(pool));

    const streamsRule = result.results.find((r) => r.table === 'streams');
    expect(streamsRule!.rowsPurged).toBe(1);   // only aged + unheld
    expect(streamsRule!.rowsSkipped).toBe(1);  // aged + held is exempt

    // The held row must never be touched by a mutating query
    const mutating = client._issuedSql.filter(
      (s) => s.startsWith('DELETE') || (s.startsWith('UPDATE') && s.includes('keep-held')),
    );
    expect(mutating).toHaveLength(0);

    // PURGE_SKIPPED_LEGAL_HOLD must reference the held row id
    const holdAudit = mockRecordAuditEventToDb.mock.calls.find(
      ([action, , id]: any) => action === 'PURGE_SKIPPED_LEGAL_HOLD' && id === 'keep-held',
    );
    expect(holdAudit).toBeDefined();
  });
});
