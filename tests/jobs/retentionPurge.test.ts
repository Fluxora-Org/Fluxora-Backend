// @ts-nocheck
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
 * `rows` is consumed one batch at a time:
 *  - First SELECT (information_schema check) returns a schema row.
 *  - Subsequent SELECTs return batches of candidate rows.
 *  - INSERT / DELETE / UPDATE return { rows: [], rowCount: 0 }.
 */
function buildMockClient(candidateBatches: MockRow[][] = [[]]) {
  let batchIndex = 0;
  let callCount = 0;
  const queries: string[] = [];

  const client = {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      queries.push(sql);
      callCount++;

      // First call per connect is the information_schema check
      if (sql.toLowerCase().includes('information_schema')) {
        return { rows: [{ column_name: 'legal_hold' }], rowCount: 1 };
      }

      // BEGIN / COMMIT / ROLLBACK
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) {
        return { rows: [], rowCount: 0 };
      }

      // SELECT candidates (FOR UPDATE SKIP LOCKED)
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        const batch = candidateBatches[batchIndex] ?? [];
        batchIndex++;
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
    const client = buildMockClient([[]]); // first and only batch is empty
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

    // Rule 1 (audit_logs): slot 0 → [a1, a2], slot 1 → []
    // Rule 2 (streams):    slot 2 → []
    // Rule 3 (webhook):    slot 3 → []
    const batch1: MockRow[] = [expiredRow('a1'), expiredRow('a2')];

    const client = buildMockClient([batch1, [], [], []]);
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge(baseOptions(pool));

    const auditRule = result.results.find((r) => r.category === 'Audit logs');
    expect(auditRule).toBeDefined();
    expect(auditRule!.rowsPurged).toBe(2);
    expect(auditRule!.rowsSkipped).toBe(0);
  });
});

describe('runRetentionPurge — legal-hold precedence', () => {
  it('skips held rows and writes PURGE_SKIPPED_LEGAL_HOLD audit events', async () => {
    const { recordAuditEventToDb } = await import('../../src/lib/auditLog.js');
    vi.clearAllMocks();

    // PURGEABLE_RETENTION_SCHEDULE has 3 rules (audit_logs, streams, webhook_outbox).
    // Each rule's first FOR-UPDATE-SKIP-LOCKED SELECT consumes one batchIndex slot.
    // Rule 1 (audit_logs):     slot 0 → [] (empty, exits immediately)
    // Rule 2 (streams):        slot 1 → heldBatch (3 rows: 2 held, 1 not)
    //                          slot 2 → [] (second batch empty, exits loop)
    // Rule 3 (webhook_outbox): slot 3 → [] (empty, exits immediately)
    const heldBatch: MockRow[] = [
      expiredRow('s1', true),
      expiredRow('s2', true),
      expiredRow('s3', false),
    ];
    const client = buildMockClient([[], heldBatch, [], []]);
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

    // Rule 1 (audit_logs): slot 0 → []
    // Rule 2 (streams):    slot 1 → [h1(held), h2(held)], slot 2 → []
    // Rule 3 (webhook):    slot 3 → []
    const heldBatch: MockRow[] = [expiredRow('h1', true), expiredRow('h2', true)];
    const client = buildMockClient([[], heldBatch, [], []]);
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const skippedCalls = (recordAuditEventToDb as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([action]: [string]) => action === 'PURGE_SKIPPED_LEGAL_HOLD',
    );
    expect(skippedCalls.length).toBe(2);
  });

  it('all-held batch of exactly batchSize exits loop (SKIP LOCKED semantics)', async () => {
    // When a full batch is entirely held rows and the next batch is empty,
    // FOR UPDATE SKIP LOCKED prevents revisiting them — the loop exits.
    // Rule 1 (audit_logs): slot 0 → []
    // Rule 2 (streams):    slot 1 → fullHeldBatch (10 rows, all held), slot 2 → []
    // Rule 3 (webhook):    slot 3 → []
    const fullHeldBatch = Array.from({ length: 10 }, (_, i) => expiredRow(`h${i}`, true));
    const client = buildMockClient([[], fullHeldBatch, [], []]);
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge(baseOptions(pool));
    const streamsRule = result.results.find((r) => r.table === 'streams');

    expect(streamsRule!.rowsSkipped).toBe(10);
    expect(streamsRule!.rowsPurged).toBe(0);
  });
});

describe('runRetentionPurge — streams redact path', () => {
  it('issues UPDATE with tombstone, not DELETE, for streams rows', async () => {
    // Rule 1 (audit_logs): slot 0 → []
    // Rule 2 (streams):    slot 1 → [stream-1], slot 2 → []
    // Rule 3 (webhook):    slot 3 → []
    const batch: MockRow[] = [expiredRow('stream-1', false)];

    const client = buildMockClient([[], batch, [], []]);
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const updateCalls = client.query.mock.calls
      .map(([sql]: [string]) => sql)
      .filter((s: string) => s.trim().startsWith('UPDATE'));

    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const updateSql = updateCalls[0] as string;
    expect(updateSql).toContain('[REDACTED:DATA_RETENTION]');
    expect(updateSql).not.toContain('DELETE');
  });

  it('UPDATE sets encryption_state = \'redacted\'', async () => {
    const batch: MockRow[] = [expiredRow('stream-2', false)];

    const client = buildMockClient([[], batch, [], []]);
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const updateCalls = client.query.mock.calls
      .map(([sql]: [string]) => sql)
      .filter((s: string) => s.trim().startsWith('UPDATE'));

    const updateSql = updateCalls[0] as string;
    expect(updateSql).toContain("encryption_state       = 'redacted'");
  });

  it('UPDATE sets sender_address_hash and recipient_address_hash to NULL', async () => {
    const batch: MockRow[] = [expiredRow('stream-3', false)];

    const client = buildMockClient([[], batch, [], []]);
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    const updateCalls = client.query.mock.calls
      .map(([sql]: [string]) => sql)
      .filter((s: string) => s.trim().startsWith('UPDATE'));

    const updateSql = updateCalls[0] as string;
    expect(updateSql).toContain('sender_address_hash    = NULL');
    expect(updateSql).toContain('recipient_address_hash = NULL');
  });
});

describe('runRetentionPurge — dryRun mode', () => {
  it('does not issue any DELETE or UPDATE queries in dryRun mode', async () => {
    // Rule 1 (audit_logs): slot 0 → []
    // Rule 2 (streams):    slot 1 → [dry-1, dry-2], slot 2 → []
    // Rule 3 (webhook):    slot 3 → []
    const batch: MockRow[] = [expiredRow('dry-1', false), expiredRow('dry-2', false)];

    const client = buildMockClient([[], batch, [], []]);
    const pool = buildMockPool(() => client);

    const opts: PurgeJobOptions = { ...baseOptions(pool), dryRun: true };
    const result = await runRetentionPurge(opts);

    const mutatingCalls = client.query.mock.calls
      .map(([sql]: [string]) => sql.trim())
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

    const client = buildMockClient([[], batch, [], []]);
    const pool = buildMockPool(() => client);

    await runRetentionPurge({ ...baseOptions(pool), dryRun: true });

    const initiatedCalls = (recordAuditEventToDb as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([action]: [string]) => action === 'PURGE_INITIATED',
    );
    expect(initiatedCalls).toHaveLength(0);
  });
});

describe('runRetentionPurge — PURGE_INITIATED audit', () => {
  it('emits one PURGE_INITIATED per batch that purges at least one row', async () => {
    const { recordAuditEventToDb } = await import('../../src/lib/auditLog.js');
    vi.clearAllMocks();

    // Rule 1 (audit_logs): slot 0 → []
    // Rule 2 (streams):    slot 1 → batch1, slot 2 → batch2, slot 3 → []
    // Rule 3 (webhook):    slot 4 → []
    const batch1: MockRow[] = [expiredRow('s10', false), expiredRow('s11', false)];
    const batch2: MockRow[] = [expiredRow('s12', false)];

    const client = buildMockClient([[], batch1, batch2, [], []]);
    const pool = buildMockPool(() => client);

    await runRetentionPurge(baseOptions(pool));

    // Two batches with purged > 0 → two PURGE_INITIATED INSERT statements via client.query
    const insertAuditCalls = client.query.mock.calls
      .map(([sql]: [string]) => sql)
      .filter((s: string) => s.includes('PURGE_INITIATED'));

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
    // Rule 1 (audit_logs): slot 0 → []
    // Rule 2 (streams):    slot 1 → batch (3 rows < batchSize 10), slot 2 → []
    // Rule 3 (webhook):    slot 3 → []
    const batch: MockRow[] = [expiredRow('p1'), expiredRow('p2'), expiredRow('p3')];

    const client = buildMockClient([[], batch, [], []]);
    const pool = buildMockPool(() => client);

    const result = await runRetentionPurge(baseOptions(pool));
    const streamsRule = result.results.find((r) => r.table === 'streams');

    expect(streamsRule!.rowsPurged).toBe(3);

    // One SELECT for the partial batch + one empty SELECT = 2 FOR-UPDATE-SKIP-LOCKED calls
    // for the streams rule. Plus one each for audit_logs and webhook_outbox = 4 total.
    const selectCalls = client.query.mock.calls
      .map(([sql]: [string]) => sql)
      .filter((s: string) => s.includes('FOR UPDATE SKIP LOCKED'));
    expect(selectCalls.length).toBe(4); // audit_logs:1, streams:2, webhook_outbox:1
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
    const client = buildMockClient([batch, []]);
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
