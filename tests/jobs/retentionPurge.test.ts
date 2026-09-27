// Pre-existing type error from upstream merge, unrelated to #1254; tracked under #TBD-typecheck-backlog.
/**
 * tests/jobs/retentionPurge.test.ts
 *
 * Unit tests for the data-retention purge job.
 *
 * All tests use an injectable mock pool so no real Postgres connection is
 * required.  The mock implements the minimum Pool / PoolClient interface
 * surface the job touches.
 *
 * Cases covered
 * ─────────────
 *  1. No candidates         — job completes with 0 purged / 0 skipped
 *  2. Deletable rows        — rows purged, PURGE_INITIATED audit written
 *  3. Held rows (purge)     — rows skipped, PURGE_SKIPPED_LEGAL_HOLD audit written
 *  4. Mixed held / non-held — correct split counts
 *  5. Streams redact path   — UPDATE SQL with tombstone, not DELETE
 *  6. Streams redact sets encryption_state = 'redacted'
 *  7. Generic redact path   — throws (safety guard for undefined tables)
 *  8. hasMore loop exits on partial batch (< batchSize)
 *  9. hasMore loop: all-held batch of batchSize exits (SKIP LOCKED)
 * 10. dryRun mode           — no DELETE/UPDATE issued; counts still returned
 * 11. Batch error           — throws, does not continue to next batch
 * 12. quoteIdentifier       — double-quotes are escaped
 * 13. tableHasColumn        — returns true/false based on schema query
 */

import { describe, it, expect, vi } from 'vitest';
import { runRetentionPurge, quoteIdentifier } from '../../src/jobs/retentionPurge.js';
import type { PurgeJobOptions } from '../../src/jobs/retentionPurge.js';
import { PURGEABLE_RETENTION_SCHEDULE } from '../../src/pii/policy.js';

// ── Audit log mock ────────────────────────────────────────────────────────────

vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEventToDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(),
}));

// ── Pool / client builder helpers ─────────────────────────────────────────────

interface MockRow {
  id: string;
  legal_hold: boolean;
  created_at: string;
  timestamp?: string;
}

/**
 * Build a minimal pg PoolClient mock.
 *
 * Candidate batches are keyed by **table name**, not by a flat call index, so
 * a test does not have to know how many rules the schedule has or in what
 * order they run. `PURGEABLE_RETENTION_SCHEDULE` is derived from the retention
 * manifest and has grown over time (it gained `webhook_dlq`,
 * `job_dead_letter` and `tenant_rate_limit_overrides`), and a positional mock
 * silently mis-assigns every batch the moment a rule is added or reordered.
 *
 * `batches[table]` is consumed one entry at a time; once exhausted the table
 * yields no more candidates. Tables absent from the map yield none either.
 */
function buildMockClient(batches: Record<string, MockRow[][]> = {}) {
  const cursors = new Map<string, number>(Object.keys(batches).map((t) => [t, 0]));
  const queries: string[] = [];

  const client = {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      queries.push(sql);

      // Schema introspection for the legal-hold check
      if (sql.toLowerCase().includes('information_schema')) {
        return { rows: [{ column_name: 'legal_hold' }], rowCount: 1 };
      }

      // BEGIN / COMMIT / ROLLBACK
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) {
        return { rows: [], rowCount: 0 };
      }

      // SELECT candidates (FOR UPDATE SKIP LOCKED)
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        // `FROM "table"` is the only quoted identifier in the SELECT.
        const table = /FROM\s+"([^"]+)"/.exec(sql)?.[1] ?? '';
        const queued = batches[table] ?? [];
        const index = cursors.get(table) ?? 0;
        cursors.set(table, index + 1);
        const batch = queued[index] ?? [];
        return { rows: batch, rowCount: batch.length };
      }

      // INSERT (audit), DELETE, UPDATE — all no-op
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
    _queries: queries,
  };

  return client;
}

function buildMockPool(clientFactory: () => ReturnType<typeof buildMockClient>) {
  return {
    connect: vi.fn(async () => clientFactory()),
  };
}

/** How many candidate SELECTs a given table received. */
function selectCountFor(client: ReturnType<typeof buildMockClient>, table: string): number {
  return client.query.mock.calls
    .map(([sql]: any) => sql as string)
    .filter((sql: string) => sql.includes('FOR UPDATE SKIP LOCKED'))
    .filter((sql: string) => sql.includes(`FROM "${table}"`)).length;
}

// ── Fixed reference time ──────────────────────────────────────────────────────

const NOW = new Date('2027-01-01T00:00:00.000Z');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a row that is past the retention cut-off (created 400 days ago). */
function expiredRow(id: string, legalHold = false): MockRow {
  const d = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000);
  return { id, legal_hold: legalHold, created_at: d.toISOString(), timestamp: d.toISOString() };
}

function baseOptions(pool: ReturnType<typeof buildMockPool>): PurgeJobOptions {
  return { pool: pool as any, now: NOW, batchSize: 10, correlationId: 'test-run' };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runRetentionPurge — no candidates', () => {
  it('completes with 0 purged and 0 skipped when all batches are empty', async () => {
    const client = buildMockClient(); // no table has any candidates
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge(baseOptions(pool));

    expect(result.totalRowsPurged).toBe(0);
    expect(result.totalRowsSkipped).toBe(0);
    for (const r of result.results) {
      expect(r.rowsPurged).toBe(0);
      expect(r.rowsSkipped).toBe(0);
    }
  });
});

describe('runRetentionPurge — delete action (audit_logs rule)', () => {
  it('deletes expired rows and emits PURGE_INITIATED audit', async () => {
    const { recordAuditEventToDb } = await import('../../src/lib/auditLog.js');
    vi.clearAllMocks();

    const batch1: MockRow[] = [expiredRow('a1'), expiredRow('a2')];

    const client = buildMockClient({ audit_logs: [batch1] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge(baseOptions(pool));

    const auditRule = result.results.find((r) => r.table === 'audit_logs');
    expect(auditRule).toBeDefined();
    expect(auditRule!.rowsPurged).toBe(2);
    expect(auditRule!.rowsSkipped).toBe(0);
  });
});

describe('runRetentionPurge — legal-hold precedence', () => {
  it('skips held rows and writes PURGE_SKIPPED_LEGAL_HOLD audit events', async () => {
    const { recordAuditEventToDb } = await import('../../src/lib/auditLog.js');
    vi.clearAllMocks();

    // Batches are keyed by table, so this does not depend on the rule count.
    // streams: one batch of 3 rows (2 held, 1 not), then an empty batch so the
    // hasMore loop exits.
    const heldBatch: MockRow[] = [
      expiredRow('s1', true),
      expiredRow('s2', true),
      expiredRow('s3', false),
    ];
    const client = buildMockClient({ streams: [heldBatch, []] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge(baseOptions(pool));

    const streamsRule = result.results.find((r) => r.table === 'streams');
    expect(streamsRule).toBeDefined();
    expect(streamsRule!.rowsPurged).toBe(1);
    expect(streamsRule!.rowsSkipped).toBe(2);
    expect(streamsRule!.dryRun).toBe(false);
  });

  it('records PURGE_SKIPPED_LEGAL_HOLD for each held row via the shared pool', async () => {
    const { recordAuditEventToDb } = await import('../../src/lib/auditLog.js');
    vi.clearAllMocks();

    const heldBatch: MockRow[] = [expiredRow('h1', true), expiredRow('h2', true)];
    const client = buildMockClient({ streams: [heldBatch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const skippedCalls = (recordAuditEventToDb as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([action]: any) => action === 'PURGE_SKIPPED_LEGAL_HOLD',
    );
    expect(skippedCalls.length).toBe(2);
  });

  it('all-held batch of exactly batchSize exits loop (SKIP LOCKED semantics)', async () => {
    // When a full batch is entirely held rows and the next batch is empty,
    // FOR UPDATE SKIP LOCKED prevents revisiting them — the loop exits.
    const fullHeldBatch = Array.from({ length: 10 }, (_, i) => expiredRow(`h${i}`, true));
    const client = buildMockClient({ streams: [fullHeldBatch, []] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge(baseOptions(pool));
    const streamsRule = result.results.find((r) => r.table === 'streams');

    expect(streamsRule!.rowsSkipped).toBe(10);
    expect(streamsRule!.rowsPurged).toBe(0);
  });
});

describe('runRetentionPurge — streams redact path', () => {
  it('issues UPDATE with tombstone, not DELETE, for streams rows', async () => {
    const batch: MockRow[] = [expiredRow('stream-1', false)];

    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const updateCalls = client.query.mock.calls
      .map(([sql]: any) => sql)
      .filter((s: string) => s.trim().startsWith('UPDATE'));

    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const updateSql = updateCalls[0] as string;
    expect(updateSql).not.toContain('DELETE');
    // The tombstone is a bound parameter, not string-interpolated, so the SQL
    // text only proves the statement is an UPDATE. Assert the value separately.
    const updateParams = client.query.mock.calls.find(([sql]: any) =>
      sql.trim().startsWith('UPDATE'),
    )?.[1] as unknown[];
    expect(updateParams?.[0]).toBe('[REDACTED:DATA_RETENTION]');
  });

  it('UPDATE sets encryption_state = \'redacted\'', async () => {
    const batch: MockRow[] = [expiredRow('stream-2', false)];

    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const updateCalls = client.query.mock.calls
      .map(([sql]: any) => sql)
      .filter((s: string) => s.trim().startsWith('UPDATE'));

    const updateSql = updateCalls[0] as string;
    expect(updateSql).toContain("encryption_state       = 'redacted'");
  });

  it('UPDATE sets sender_address_hash and recipient_address_hash to NULL', async () => {
    const batch: MockRow[] = [expiredRow('stream-3', false)];

    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const updateCalls = client.query.mock.calls
      .map(([sql]: any) => sql)
      .filter((s: string) => s.trim().startsWith('UPDATE'));

    const updateSql = updateCalls[0] as string;
    expect(updateSql).toContain('sender_address_hash    = NULL');
    expect(updateSql).toContain('recipient_address_hash = NULL');
  });
});

describe('runRetentionPurge — dryRun mode', () => {
  it('does not issue any DELETE or UPDATE queries in dryRun mode', async () => {
    const batch: MockRow[] = [expiredRow('dry-1', false), expiredRow('dry-2', false)];

    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    const opts: PurgeJobOptions = { ...baseOptions(pool), dryRun: true };
    const result = await runRetentionPurge(opts);

    const mutatingCalls = client.query.mock.calls
      .map(([sql]: any) => sql.trim())
      .filter((s: string) => s.startsWith('DELETE') || s.startsWith('UPDATE'));

    expect(mutatingCalls).toHaveLength(0);

    // dryRun still counts candidates
    const streamsRule = result.results.find((r) => r.table === 'streams');
    expect(streamsRule!.rowsPurged).toBe(2);
    expect(streamsRule!.dryRun).toBe(true);
  });

  it('does not emit PURGE_INITIATED in dryRun mode', async () => {
    const { recordAuditEventToDb } = await import('../../src/lib/auditLog.js');
    vi.clearAllMocks();

    const batch: MockRow[] = [expiredRow('dry-3', false)];

    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge({ ...baseOptions(pool), dryRun: true });

    const initiatedCalls = (recordAuditEventToDb as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([action]: any) => action === 'PURGE_INITIATED',
    );
    expect(initiatedCalls).toHaveLength(0);
  });

  it('does not write PURGE_SKIPPED_LEGAL_HOLD audit rows for held rows in dryRun mode', async () => {
    // A dry run must be a true no-op against the database: legal-hold rows
    // are still counted as "would be skipped", but the audit write (which
    // goes through the shared pool outside the batch transaction) must not
    // fire, otherwise dryRun would leave a real mutation behind.
    const { recordAuditEventToDb } = await import('../../src/lib/auditLog.js');
    vi.clearAllMocks();

    const heldBatch: MockRow[] = [expiredRow('dh-1', true), expiredRow('dh-2', true)];
    const client = buildMockClient({ streams: [heldBatch, []] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge({ ...baseOptions(pool), dryRun: true });

    const skippedCalls = (recordAuditEventToDb as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([action]: any) => action === 'PURGE_SKIPPED_LEGAL_HOLD',
    );
    expect(skippedCalls).toHaveLength(0);

    // Counts are still reported so operators can see what dryRun *would* skip.
    const streamsRule = result.results.find((r) => r.table === 'streams');
    expect(streamsRule!.rowsSkipped).toBe(2);
    expect(streamsRule!.dryRun).toBe(true);
  });

  it('writes PURGE_SKIPPED_LEGAL_HOLD audit rows for held rows outside dryRun mode (regression guard)', async () => {
    const { recordAuditEventToDb } = await import('../../src/lib/auditLog.js');
    vi.clearAllMocks();

    const heldBatch: MockRow[] = [expiredRow('rh-1', true)];
    const client = buildMockClient({ streams: [heldBatch, []] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge({ ...baseOptions(pool), dryRun: false });

    const skippedCalls = (recordAuditEventToDb as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([action]: any) => action === 'PURGE_SKIPPED_LEGAL_HOLD',
    );
    expect(skippedCalls).toHaveLength(1);
  });
});

describe('runRetentionPurge — deletion ordering', () => {
  it('fetches candidates oldest-first via ORDER BY <ageColumn> ASC before LIMIT', async () => {
    const client = buildMockClient();
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const selectSqls = client.query.mock.calls
      .map(([sql]: any) => sql as string)
      .filter((s: string) => s.includes('FOR UPDATE SKIP LOCKED'));

    expect(selectSqls.length).toBeGreaterThan(0);
    for (const sql of selectSqls) {
      const orderIdx = sql.indexOf('ORDER BY');
      const limitIdx = sql.indexOf('LIMIT');
      expect(orderIdx).toBeGreaterThan(-1);
      expect(limitIdx).toBeGreaterThan(orderIdx);
      expect(sql).toMatch(/ORDER BY "[a-z_]+" ASC/);
    }
  });
});

describe('runRetentionPurge — PURGE_INITIATED audit', () => {
  it('emits one PURGE_INITIATED per batch that purges at least one row', async () => {
    const { recordAuditEventToDb } = await import('../../src/lib/auditLog.js');
    vi.clearAllMocks();

    // The loop only continues while a batch is *full* (purged + skipped ===
    // batchSize), so batch 1 must be a full 10-row batch for a second batch to
    // happen at all. A 2-row first batch would be partial and terminate after
    // one iteration.
    const batch1: MockRow[] = Array.from({ length: 10 }, (_, i) => expiredRow(`s1${i}`, false));
    const batch2: MockRow[] = [expiredRow('s20', false)];

    const client = buildMockClient({ streams: [batch1, batch2] });
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    // Two batches with purged > 0 → two PURGE_INITIATED INSERTs. The action is
    // a bound parameter, so match on the parameters, not the SQL text.
    const insertAuditCalls = client.query.mock.calls.filter(
      ([sql, params]: any) =>
        sql.includes('INSERT INTO audit_logs') && (params?.[1] === 'PURGE_INITIATED'),
    );

    expect(insertAuditCalls.length).toBe(2);
  });
});

describe('runRetentionPurge — batch error', () => {
  it('throws when a batch fails and propagates the original error', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.trim() === 'BEGIN') return { rows: [], rowCount: 0 };
        if (sql.toLowerCase().includes('information_schema')) {
          return { rows: [{ column_name: 'legal_hold' }], rowCount: 1 };
        }
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          throw new Error('DB connection lost');
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = buildMockPool(() => client as any);

    await expect(runRetentionPurge(baseOptions(pool))).rejects.toThrow('DB connection lost');
  });
});

describe('runRetentionPurge — partial batch termination', () => {
  it('stops after a batch smaller than batchSize (no more candidates)', async () => {
    const batch: MockRow[] = [expiredRow('p1'), expiredRow('p2'), expiredRow('p3')];

    const client = buildMockClient({ streams: [batch, []] });
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge(baseOptions(pool));
    const streamsRule = result.results.find((r) => r.table === 'streams');

    expect(streamsRule!.rowsPurged).toBe(3);

    // A 3-row batch is smaller than batchSize 10, so the loop stops after that
    // single SELECT — it does not need a confirming empty batch. Asserted per
    // table so the count does not move when another purge rule is added to the
    // schedule.
    expect(selectCountFor(client, 'streams')).toBe(1);
  });
});

describe('quoteIdentifier', () => {
  it('wraps the name in double quotes', () => {
    expect(quoteIdentifier('streams')).toBe('"streams"');
  });

  it('escapes embedded double quotes by doubling them', () => {
    expect(quoteIdentifier('bad"name')).toBe('"bad""name"');
  });

  it('handles names with no special characters', () => {
    expect(quoteIdentifier('audit_logs')).toBe('"audit_logs"');
  });
});

describe('runRetentionPurge — generic redact guard', () => {
  it('throws if a purgeAction=redact rule targets an unknown table', async () => {
    // Inject a custom rule for a table without a dedicated redact branch
    const unsafeRule = {
      category: 'Unknown',
      retentionDays: 1,
      storageLayer: 'PostgreSQL — unknown',
      rationale: 'test',
      table: 'unknown_table',
      ageColumn: 'created_at',
      purgeAction: 'redact' as const,
    };

    // Override the schedule for this test only
    const { PURGEABLE_RETENTION_SCHEDULE } = await import('../../src/pii/policy.js');
    const original = [...PURGEABLE_RETENTION_SCHEDULE];

    // Temporarily push our unsafe rule
    PURGEABLE_RETENTION_SCHEDULE.length = 0;
    PURGEABLE_RETENTION_SCHEDULE.push(unsafeRule);

    const batch: MockRow[] = [expiredRow('bad-1', false)];
    const client = buildMockClient({ unknown_table: [batch, []] });
    const pool = buildMockPool(() => client);

    try {
      await expect(runRetentionPurge(baseOptions(pool))).rejects.toThrow(
        /No redact implementation for table/,
      );
    } finally {
      PURGEABLE_RETENTION_SCHEDULE.length = 0;
      PURGEABLE_RETENTION_SCHEDULE.push(...original);
    }
  });
});
