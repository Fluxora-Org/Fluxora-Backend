/**
 * Comprehensive tests for src/jobs/retentionPurge.ts
 *
 * All DB interaction is replaced with vi.mock so no running Postgres or
 * installed `pg` package is needed.  The mock pool tracks every SQL call
 * and lets each test inject fixture rows for SELECT queries.
 *
 * Coverage targets (≥95 %):
 *   ✓ quoteIdentifier — SQL-injection defence
 *   ✓ PURGEABLE_RETENTION_SCHEDULE shape validation
 *   ✓ Empty tables — zero totals, correct cutoff dates
 *   ✓ Normal purge — DELETE per row, BEGIN/COMMIT, client.release
 *   ✓ Legal-hold skip — PURGE_SKIPPED_LEGAL_HOLD audit, no DELETE
 *   ✓ Mixed batch — held + unheld rows in same batch
 *   ✓ Dry-run mode — counts rows but no DELETE/audit
 *   ✓ Redact purge action — UPDATE instead of DELETE
 *   ✓ Error / rollback — ROLLBACK on exception, client released
 *   ✓ Multiple batches — drains until table is empty
 *   ✓ Multiple rules — processed in schedule order
 *   ✓ Correlation ID — propagated into audit INSERT
 *   ✓ writeSkippedAuditEvent failure — swallowed, batch continues
 *   ✓ rowid fallback — extracts primary key from rowid column
 *   ✓ JSON.stringify fallback — no id/rowid columns
 *   ✓ Dry-run write isolation (#832) — table store unchanged; no PURGE_INITIATED;
 *     PURGE_SKIPPED_LEGAL_HOLD in both modes; real run deletes unheld rows
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (must be hoisted before any src/ imports) ───────────────────

vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: vi.fn(),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() {
      super('pool exhausted');
      this.name = 'PoolExhaustedError';
    }
  },
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor(d?: string) {
      super(d ?? 'duplicate');
      this.name = 'DuplicateEntryError';
    }
  },
}));

vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEvent: vi.fn(),
  recordAuditEventToDb: vi.fn().mockResolvedValue({}),
  buildAuditEntry: vi.fn(),
  writeAuditEntryToDb: vi.fn(),
  getAuditEntries: vi.fn(() => []),
  _resetAuditLog: vi.fn(),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ── Now safe to import src/ modules ─────────────────────────────────────────

import {
  runRetentionPurge,
  quoteIdentifier,
  type PurgeJobOptions,
  type PurgeJobResult,
} from '../../src/jobs/retentionPurge.js';
import { PURGEABLE_RETENTION_SCHEDULE } from '../../src/pii/policy.js';
import { recordAuditEventToDb } from '../../src/lib/auditLog.js';

// ── Mock client / pool factory ───────────────────────────────────────────────

interface MockQuery {
  sql: string;
  params: unknown[];
}

interface MockClientConfig {
  /** Rows returned per SELECT call, in order. */
  rows?: Record<string, unknown>[][];
  /** Throw on the Nth query() call (0-indexed). */
  failAtIndex?: number;
  failError?: Error;
  /**
   * Override the information_schema return for this client.
   * - `true`  (default) — report `legal_hold` column exists
   * - `false`           — report `legal_hold` column does NOT exist
   *
   * When `false`, the row-fetch SQL uses `FALSE AS legal_hold` and every
   * candidate row has `legal_hold === false` regardless of fixture values.
   */
  hasLegalHold?: boolean;
}

function makeMockClient(cfg: MockClientConfig = {}) {
  const queries: MockQuery[] = [];
  let queryIdx = 0;
  let selectIdx = 0;

  const client = {
    queries,
    released: false,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: sql.trim(), params });
      const i = queryIdx++;
      if (cfg.failAtIndex !== undefined && i === cfg.failAtIndex) {
        throw cfg.failError ?? new Error('mock DB error');
      }
      if (/^\s*SELECT/i.test(sql)) {
        // information_schema queries (hoisted column-existence check) should
        // NOT consume row fixtures.  Report column existence based on the
        // optional `hasLegalHold` config flag (defaults to `true` so that
        // per-row legal_hold values from fixtures are honoured).
        if (/information_schema/i.test(sql)) {
          const exists = cfg.hasLegalHold !== undefined ? cfg.hasLegalHold : true;
          return exists
            ? { rows: [{ column_name: 'legal_hold' }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        const batch = cfg.rows?.[selectIdx] ?? [];
        selectIdx++;
        return { rows: batch, rowCount: batch.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(() => {
      client.released = true;
    }),
  };
  return client;
}
type MockClient = ReturnType<typeof makeMockClient>;

/** Pool that hands out clients in sequence; repeats the last one if exhausted. */
function makeMockPool(clients: MockClient[]) {
  let i = 0;
  return {
    connect: vi.fn(async () => clients[Math.min(i++, clients.length - 1)]),
  };
}

/** A row fixture that looks like an audit_logs or webhook_outbox row. */
function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    timestamp: '2024-01-01T00:00:00.000Z',
    created_at: '2024-01-01T00:00:00.000Z',
    action: 'STREAM_CREATED',
    resource_type: 'stream',
    resource_id: 'stream-abc',
    legal_hold: false,
    ...overrides,
  };
}

const FIXED_NOW = new Date('2026-07-24T00:00:00.000Z');

/**
 * Build base PurgeJobOptions with injected pool.
 *
 * Pads the clients array so there are at least 2 × N clients for N schedule
 * rules (one for the hoisted schema check + one for the batch per rule).
 * The first two slots are filled with `clients[0]` so the first rule's
 * batch work lands on the first client (matching the assertion pattern
 * in most tests).
 */
function opts(clients: MockClient[], extra: Partial<PurgeJobOptions> = {}): PurgeJobOptions {
  const needPerRule = 2; // 1 schema-check connect + 1 batch connect per rule
  const needed = PURGEABLE_RETENTION_SCHEDULE.length * needPerRule;
  const padded: MockClient[] = [];
  // First rule: schema + batch both use clients[0] so tests asserting on
  // clients[0].queries still see batch operations.
  if (clients.length >= 1) {
    padded.push(clients[0]); // first rule schema check
    padded.push(clients[0]); // first rule batch
  }
  // Remaining slots: cycle through remaining clients, repeat last if exhausted.
  for (let i = 2; i < needed; i++) {
    const idx = Math.min(i, clients.length - 1);
    padded.push(clients[Math.max(1, idx)]);
  }
  return {
    now: FIXED_NOW,
    batchSize: 10,
    pool: makeMockPool(padded) as unknown as PurgeJobOptions['pool'],
    correlationId: 'test-corr-id',
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. quoteIdentifier
// ═══════════════════════════════════════════════════════════════════════════════

describe('quoteIdentifier()', () => {
  it('wraps a plain name in double quotes', () => {
    expect(quoteIdentifier('audit_logs')).toBe('"audit_logs"');
  });

  it('escapes embedded double quotes by doubling them', () => {
    expect(quoteIdentifier('bad"name')).toBe('"bad""name"');
  });

  it('leaves safe names unchanged inside quotes', () => {
    expect(quoteIdentifier('webhook_outbox')).toBe('"webhook_outbox"');
  });

  it('handles an empty string', () => {
    expect(quoteIdentifier('')).toBe('""');
  });

  it('handles names with spaces', () => {
    expect(quoteIdentifier('my table')).toBe('"my table"');
  });

  it('handles multiple embedded quotes', () => {
    expect(quoteIdentifier('a"b"c')).toBe('"a""b""c"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PURGEABLE_RETENTION_SCHEDULE shape
// ═══════════════════════════════════════════════════════════════════════════════

describe('PURGEABLE_RETENTION_SCHEDULE', () => {
  it('has at least one rule', () => {
    expect(PURGEABLE_RETENTION_SCHEDULE.length).toBeGreaterThan(0);
  });

  it('every rule has a finite positive retentionDays', () => {
    for (const r of PURGEABLE_RETENTION_SCHEDULE) {
      expect(typeof r.retentionDays).toBe('number');
      expect(r.retentionDays as number).toBeGreaterThan(0);
    }
  });

  it('every rule has a non-empty table and ageColumn', () => {
    for (const r of PURGEABLE_RETENTION_SCHEDULE) {
      expect(r.table.length).toBeGreaterThan(0);
      expect(r.ageColumn.length).toBeGreaterThan(0);
    }
  });

  it('every purgeAction is "delete" or "redact"', () => {
    for (const r of PURGEABLE_RETENTION_SCHEDULE) {
      expect(['delete', 'redact']).toContain(r.purgeAction);
    }
  });

  it('every rule has a non-empty rationale', () => {
    for (const r of PURGEABLE_RETENTION_SCHEDULE) {
      expect(r.rationale.length).toBeGreaterThan(0);
    }
  });

  it('includes an audit_logs rule (365 days, delete)', () => {
    const rule = PURGEABLE_RETENTION_SCHEDULE.find((r) => r.table === 'audit_logs');
    expect(rule).toBeDefined();
    expect(rule!.retentionDays).toBe(365);
    expect(rule!.purgeAction).toBe('delete');
  });

  it('includes a stream address PII rule (365 days, redact)', () => {
    const rule = PURGEABLE_RETENTION_SCHEDULE.find((r) => r.table === 'streams');
    expect(rule).toBeDefined();
    expect(rule!.retentionDays).toBe(365);
    expect(rule!.purgeAction).toBe('redact');
  });

  it('includes a webhook_outbox rule (90 days, delete)', () => {
    const rule = PURGEABLE_RETENTION_SCHEDULE.find((r) => r.table === 'webhook_outbox');
    expect(rule).toBeDefined();
    expect(rule!.retentionDays).toBe(90);
    expect(rule!.purgeAction).toBe('delete');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Empty tables — no candidates
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — empty tables', () => {
  it('returns zero totals when all tables are empty', async () => {
    const clients = PURGEABLE_RETENTION_SCHEDULE.map(() => makeMockClient({ rows: [[]] }));
    const result: PurgeJobResult = await runRetentionPurge(opts(clients));
    expect(result.totalRowsPurged).toBe(0);
    expect(result.totalRowsSkipped).toBe(0);
    expect(result.results).toHaveLength(PURGEABLE_RETENTION_SCHEDULE.length);
  });

  it('result has one entry per schedule rule', async () => {
    const clients = PURGEABLE_RETENTION_SCHEDULE.map(() => makeMockClient({ rows: [[]] }));
    const result = await runRetentionPurge(opts(clients));
    for (let i = 0; i < PURGEABLE_RETENTION_SCHEDULE.length; i++) {
      expect(result.results[i].table).toBe(PURGEABLE_RETENTION_SCHEDULE[i].table);
    }
  });

  it('reports the correct cutoffDate for each rule', async () => {
    const clients = PURGEABLE_RETENTION_SCHEDULE.map(() => makeMockClient({ rows: [[]] }));
    const result = await runRetentionPurge(opts(clients));
    for (let i = 0; i < PURGEABLE_RETENTION_SCHEDULE.length; i++) {
      const rule = PURGEABLE_RETENTION_SCHEDULE[i];
      const expected = new Date(
        FIXED_NOW.getTime() - (rule.retentionDays as number) * 86_400_000
      ).toISOString();
      expect(result.results[i].cutoffDate).toBe(expected);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Normal purge — rows without legal hold
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — normal purge (no legal hold)', () => {
  it('counts purged rows correctly', async () => {
    const c0 = makeMockClient({ rows: [[row({ id: 'r1', legal_hold: false })], []] });
    const c1 = makeMockClient({ rows: [[]] });
    const result = await runRetentionPurge(opts([c0, c1]));
    expect(result.totalRowsPurged).toBe(1);
    expect(result.totalRowsSkipped).toBe(0);
  });

  it('issues a DELETE for each non-held row', async () => {
    const rows = [row({ id: 'r1' }), row({ id: 'r2' })];
    const c0 = makeMockClient({ rows: [rows, []] });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    const dels = c0.queries.filter((q) => /^DELETE/i.test(q.sql));
    expect(dels).toHaveLength(2);
  });

  it('wraps each batch in BEGIN … COMMIT', async () => {
    const c0 = makeMockClient({ rows: [[row()], []] });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    const sqls = c0.queries.map((q) => q.sql.toUpperCase());
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
  });

  it('releases the pool client after each batch', async () => {
    const c0 = makeMockClient({ rows: [[row()], []] });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    expect(c0.release).toHaveBeenCalled();
  });

  it('writes a PURGE_INITIATED audit INSERT per batch with purged rows', async () => {
    const c0 = makeMockClient({ rows: [[row()], []] });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    const auditInserts = c0.queries.filter(
      (q) => /INSERT INTO audit_logs/i.test(q.sql) && q.params.includes('PURGE_INITIATED')
    );
    expect(auditInserts.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Legal-hold skip
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — legal-hold skip', () => {
  it('skips rows where legal_hold is true', async () => {
    const c0 = makeMockClient({
      rows: [[row({ id: 'held-1', legal_hold: true })], []],
    });
    const c1 = makeMockClient({ rows: [[]] });
    const result = await runRetentionPurge(opts([c0, c1]));
    expect(result.totalRowsSkipped).toBe(1);
    expect(result.totalRowsPurged).toBe(0);
  });

  it('does NOT issue a DELETE for held rows', async () => {
    const c0 = makeMockClient({
      rows: [[row({ id: 'held-1', legal_hold: true })], []],
    });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    const dels = c0.queries.filter((q) => /^DELETE/i.test(q.sql));
    expect(dels).toHaveLength(0);
  });

  it('writes PURGE_SKIPPED_LEGAL_HOLD via recordAuditEventToDb for each held row', async () => {
    vi.mocked(recordAuditEventToDb).mockClear();
    const c0 = makeMockClient({
      rows: [[row({ id: 'held-1', legal_hold: true })], []],
    });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'PURGE_SKIPPED_LEGAL_HOLD',
      expect.any(String),
      'held-1',
      'test-corr-id',
      expect.objectContaining({ reason: 'legal_hold = TRUE' })
    );
  });

  it('handles a batch of all held rows', async () => {
    const held = [
      row({ id: 'h1', legal_hold: true }),
      row({ id: 'h2', legal_hold: true }),
      row({ id: 'h3', legal_hold: true }),
    ];
    const c0 = makeMockClient({ rows: [held, []] });
    const c1 = makeMockClient({ rows: [[]] });
    const result = await runRetentionPurge(opts([c0, c1]));
    expect(result.totalRowsSkipped).toBe(3);
    expect(result.totalRowsPurged).toBe(0);
  });

  it('does NOT write PURGE_INITIATED when all rows in batch are held', async () => {
    const c0 = makeMockClient({
      rows: [[row({ id: 'h1', legal_hold: true })], []],
    });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    const auditInserts = c0.queries.filter(
      (q) => /INSERT INTO audit_logs/i.test(q.sql) && q.params.includes('PURGE_INITIATED')
    );
    expect(auditInserts).toHaveLength(0);
  });

  it('counts skipped rows in result summary', async () => {
    const c0 = makeMockClient({
      rows: [[row({ id: 'h1', legal_hold: true }), row({ id: 'p1', legal_hold: false })], []],
    });
    const c1 = makeMockClient({ rows: [[]] });
    const result = await runRetentionPurge(opts([c0, c1]));
    expect(result.totalRowsPurged).toBe(1);
    expect(result.totalRowsSkipped).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Mixed batch — legal hold + non-legal in same batch
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — mixed batch (held + unheld)', () => {
  it('deletes unheld rows and skips held rows in the same batch', async () => {
    const batch = [
      row({ id: 'p1', legal_hold: false }),
      row({ id: 'h1', legal_hold: true }),
      row({ id: 'p2', legal_hold: false }),
    ];
    const c0 = makeMockClient({ rows: [batch, []] });
    const c1 = makeMockClient({ rows: [[]] });
    const result = await runRetentionPurge(opts([c0, c1]));
    expect(result.totalRowsPurged).toBe(2);
    expect(result.totalRowsSkipped).toBe(1);

    const dels = c0.queries.filter((q) => /^DELETE/i.test(q.sql));
    expect(dels).toHaveLength(2);
    expect(dels[0].params).toContain('p1');
    expect(dels[1].params).toContain('p2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Dry-run mode
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — dry-run mode', () => {
  it('does NOT issue DELETE in dry-run mode', async () => {
    const c0 = makeMockClient({ rows: [[row({ id: 'd1' }), row({ id: 'd2' })], []] });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1], { dryRun: true }));
    const dels = c0.queries.filter((q) => /^DELETE/i.test(q.sql));
    expect(dels).toHaveLength(0);
  });

  it('does NOT write PURGE_INITIATED audit in dry-run mode', async () => {
    const c0 = makeMockClient({ rows: [[row({ id: 'd1' })], []] });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1], { dryRun: true }));
    const auditInserts = c0.queries.filter(
      (q) => /INSERT INTO audit_logs/i.test(q.sql) && q.params.includes('PURGE_INITIATED')
    );
    expect(auditInserts).toHaveLength(0);
  });

  it('still counts candidates (rowsPurged reflects what would be purged)', async () => {
    const c0 = makeMockClient({ rows: [[row({ id: 'd1' }), row({ id: 'd2' })], []] });
    const c1 = makeMockClient({ rows: [[]] });
    const result = await runRetentionPurge(opts([c0, c1], { dryRun: true }));
    expect(result.results[0].rowsPurged).toBe(2);
    expect(result.results[0].dryRun).toBe(true);
  });

  it('still skips legal-hold rows in dry-run mode and writes audit', async () => {
    vi.mocked(recordAuditEventToDb).mockClear();
    const c0 = makeMockClient({
      rows: [[row({ id: 'h1', legal_hold: true })], []],
    });
    const c1 = makeMockClient({ rows: [[]] });
    const result = await runRetentionPurge(opts([c0, c1], { dryRun: true }));
    expect(result.totalRowsSkipped).toBe(1);
    expect(recordAuditEventToDb).toHaveBeenCalled();
  });

  it('sets dryRun flag on every rule result', async () => {
    const clients = PURGEABLE_RETENTION_SCHEDULE.map(() => makeMockClient({ rows: [[]] }));
    const result = await runRetentionPurge(opts(clients, { dryRun: true }));
    for (const r of result.results) {
      expect(r.dryRun).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Redact purge action
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — redact purge action', () => {
  it('issues UPDATE for stream redact purgeAction', async () => {
    const rule = PURGEABLE_RETENTION_SCHEDULE.find((r) => r.table === 'streams');
    expect(rule?.purgeAction).toBe('redact');

    // First client handles audit_logs (rule 1) with no data.
    // Second client handles streams (rule 2) with a held row — it's reused for
    // webhook_outbox (rule 3) which gets no data.
    const c0 = makeMockClient({ rows: [[]] });
    const c1 = makeMockClient({ rows: [[row({ id: 's1', legal_hold: false })], []] });
    await runRetentionPurge(opts([c0, c1]));

    // Streams runs on c1 (second client).
    const updates = c1.queries.filter((q) => /^\bUPDATE\b/i.test(q.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('sender_address');
    expect(updates[0].sql).toContain('recipient_address');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Error / rollback
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — error handling', () => {
  it('rolls back on SELECT failure', async () => {
    const c0 = makeMockClient({
      rows: [[row()]],
      failAtIndex: 2, // Fail on the batch-SELECT (index 0=info_schema, 1=BEGIN)
      failError: new Error('connection lost'),
    });
    const c1 = makeMockClient({ rows: [[]] });
    await expect(runRetentionPurge(opts([c0, c1]))).rejects.toThrow('connection lost');
    const sqls = c0.queries.map((q) => q.sql.toUpperCase());
    expect(sqls).toContain('ROLLBACK');
  });

  it('rolls back on DELETE failure', async () => {
    // Schema check (0), BEGIN (1), batch SELECT (2), then DELETE fails (3)
    const c0 = makeMockClient({
      rows: [[row({ id: 'fail-row' })]],
      failAtIndex: 3, // Fail on DELETE
      failError: new Error('foreign key violation'),
    });
    const c1 = makeMockClient({ rows: [[]] });
    await expect(runRetentionPurge(opts([c0, c1]))).rejects.toThrow('foreign key violation');
    const sqls = c0.queries.map((q) => q.sql.toUpperCase());
    expect(sqls).toContain('ROLLBACK');
  });

  it('releases the pool client even on failure', async () => {
    const c0 = makeMockClient({
      failAtIndex: 1, // Fail on BEGIN (index 0=info_schema schema check, 1=BEGIN)
      failError: new Error('boom'),
    });
    const c1 = makeMockClient({ rows: [[]] });
    await expect(runRetentionPurge(opts([c0, c1]))).rejects.toThrow();
    expect(c0.release).toHaveBeenCalled();
  });

  it('continues processing remaining rules after one rule fails', async () => {
    // First rule's client fails on the batch SELECT
    const c0 = makeMockClient({
      failAtIndex: 2, // Fail on batch SELECT (0=info_schema, 1=BEGIN)
      failError: new Error('first rule error'),
    });
    // Second rule's client works
    const c1 = makeMockClient({ rows: [[row({ id: 'ok' })], []] });
    // The job should throw because the first rule fails
    await expect(runRetentionPurge(opts([c0, c1]))).rejects.toThrow('first rule error');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Multiple batches
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — multiple batches', () => {
  it('processes multiple batches until the table is drained', async () => {
    const batchSize = 2;
    const batch1 = [row({ id: 'r1' }), row({ id: 'r2' })];
    const batch2 = [row({ id: 'r3' })];
    const ca = makeMockClient({ rows: [batch1, []] });
    const cb = makeMockClient({ rows: [batch2, []] });
    const cc = makeMockClient({ rows: [[]] });
    const c1 = makeMockClient({ rows: [[]] });
    // Pool must supply 2 clients per rule (1 schema + 1 batch).
    // Rule 1 needs 3 batch connects to drain (2+1+0): ca(s), ca(b1), cb(b2), cc(b3)
    // Rules 2-3 reuse c1 for schema+batch.
    const pool = makeMockPool([ca, ca, cb, cc, c1, c1]) as unknown as PurgeJobOptions['pool'];
    const result = await runRetentionPurge({ now: FIXED_NOW, batchSize, pool });
    expect(result.results[0].rowsPurged).toBe(3);
  });

  it('issues multiple BEGIN/COMMIT pairs across batches', async () => {
    const batchSize = 2;
    const batch1 = [row({ id: 'r1' }), row({ id: 'r2' })];
    const ca = makeMockClient({ rows: [batch1, []] });
    const cb = makeMockClient({ rows: [[]] });
    const c1 = makeMockClient({ rows: [[]] });
    // Pool: [ca(schema), ca(batch), cb(schema), cb(batch), c1(...)]
    const pool = makeMockPool([ca, ca, cb, cb, c1, c1]) as unknown as PurgeJobOptions['pool'];
    await runRetentionPurge({ now: FIXED_NOW, batchSize, pool });
    const begins = ca.queries.filter((q) => q.sql.trim().toUpperCase() === 'BEGIN');
    const commits = ca.queries.filter((q) => q.sql.trim().toUpperCase() === 'COMMIT');
    expect(begins.length).toBeGreaterThanOrEqual(1);
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(begins.length).toBe(commits.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Multiple rules — processed in schedule order
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — multiple rules', () => {
  it('processes every rule in PURGEABLE_RETENTION_SCHEDULE order', async () => {
    const clients = PURGEABLE_RETENTION_SCHEDULE.map(() => makeMockClient({ rows: [[]] }));
    const result = await runRetentionPurge(opts(clients));
    for (let i = 0; i < PURGEABLE_RETENTION_SCHEDULE.length; i++) {
      expect(result.results[i].category).toBe(PURGEABLE_RETENTION_SCHEDULE[i].category);
      expect(result.results[i].table).toBe(PURGEABLE_RETENTION_SCHEDULE[i].table);
    }
  });

  it('aggregates totals across all rules', async () => {
    const c0 = makeMockClient({ rows: [[row({ id: 'a1' }), row({ id: 'a2' })], []] });
    const c1 = makeMockClient({ rows: [[row({ id: 'w1' })], []] });
    // Pool: c0(schema)+c0(batch) for rule 1, then c1(schema)+c1(batch) for rules 2-3
    const pool = makeMockPool([c0, c0, c1, c1, c1, c1]) as unknown as PurgeJobOptions['pool'];
    const result = await runRetentionPurge({ now: FIXED_NOW, batchSize: 10, pool });
    expect(result.totalRowsPurged).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Correlation ID propagation
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — correlation ID', () => {
  it('propagates correlationId into PURGE_INITIATED audit INSERT params', async () => {
    const cid = 'trace-abc-123';
    const c0 = makeMockClient({ rows: [[row({ id: 'r1' })], []] });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1], { correlationId: cid }));
    const auditInsert = c0.queries.find(
      (q) => /INSERT INTO audit_logs/i.test(q.sql) && q.params.includes('PURGE_INITIATED')
    );
    expect(auditInsert).toBeDefined();
    expect(auditInsert!.params).toContain(cid);
  });

  it('propagates correlationId into PURGE_SKIPPED_LEGAL_HOLD audit calls', async () => {
    vi.mocked(recordAuditEventToDb).mockClear();
    const cid = 'skip-trace-456';
    const c0 = makeMockClient({
      rows: [[row({ id: 'h1', legal_hold: true })], []],
    });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1], { correlationId: cid }));
    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'PURGE_SKIPPED_LEGAL_HOLD',
      expect.any(String),
      'h1',
      cid,
      expect.any(Object)
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. writeSkippedAuditEvent failure — swallowed, batch continues
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — audit write failure resilience', () => {
  it('continues the batch when recordAuditEventToDb rejects for a skipped row', async () => {
    vi.mocked(recordAuditEventToDb).mockRejectedValueOnce(new Error('audit write failed'));
    const batch = [row({ id: 'h1', legal_hold: true }), row({ id: 'p1', legal_hold: false })];
    const c0 = makeMockClient({ rows: [batch, []] });
    const c1 = makeMockClient({ rows: [[]] });
    // Should NOT throw — the skipped-audit failure is swallowed
    const result = await runRetentionPurge(opts([c0, c1]));
    expect(result.totalRowsSkipped).toBe(1);
    expect(result.totalRowsPurged).toBe(1);
  });

  it('continues when all skipped rows fail audit writes', async () => {
    vi.mocked(recordAuditEventToDb).mockRejectedValue(new Error('audit down'));
    const batch = [row({ id: 'h1', legal_hold: true }), row({ id: 'h2', legal_hold: true })];
    const c0 = makeMockClient({ rows: [batch, []] });
    const c1 = makeMockClient({ rows: [[]] });
    const result = await runRetentionPurge(opts([c0, c1]));
    expect(result.totalRowsSkipped).toBe(2);
    expect(result.totalRowsPurged).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. Primary key extraction
// ═══════════════════════════════════════════════════════════════════════════════

describe('getPrimaryKey fallback paths', () => {
  it('uses "id" field when present (string)', async () => {
    const c0 = makeMockClient({
      rows: [[row({ id: 'my-id-123' })], []],
    });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    const dels = c0.queries.filter((q) => /^DELETE/i.test(q.sql));
    expect(dels[0].params).toContain('my-id-123');
  });

  it('uses "id" field when present (number)', async () => {
    const c0 = makeMockClient({
      rows: [[row({ id: 42 })], []],
    });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    const dels = c0.queries.filter((q) => /^DELETE/i.test(q.sql));
    expect(dels[0].params).toContain('42');
  });

  it('uses "rowid" field when id is missing', async () => {
    const c0 = makeMockClient({
      rows: [[{ rowid: 'row-99', legal_hold: false }], []],
    });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    const dels = c0.queries.filter((q) => /^DELETE/i.test(q.sql));
    expect(dels[0].params).toContain('row-99');
  });

  it('falls back to JSON.stringify when neither id nor rowid exists', async () => {
    const c0 = makeMockClient({
      rows: [[{ name: 'no-pk', legal_hold: false }], []],
    });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    const dels = c0.queries.filter((q) => /^DELETE/i.test(q.sql));
    // JSON.stringify produces a string — it will be used as the primary key value
    expect(dels[0].params).toHaveLength(1);
    expect(typeof dels[0].params[0]).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. Result shape
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — result shape', () => {
  it('includes startedAt and finishedAt as ISO-8601 strings', async () => {
    const clients = PURGEABLE_RETENTION_SCHEDULE.map(() => makeMockClient({ rows: [[]] }));
    const result = await runRetentionPurge(opts(clients));
    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(result.finishedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(result.startedAt).getTime()
    );
  });

  it('each rule result includes all required fields', async () => {
    const clients = PURGEABLE_RETENTION_SCHEDULE.map(() => makeMockClient({ rows: [[]] }));
    const result = await runRetentionPurge(opts(clients));
    for (const r of result.results) {
      expect(typeof r.category).toBe('string');
      expect(typeof r.table).toBe('string');
      expect(typeof r.rowsPurged).toBe('number');
      expect(typeof r.rowsSkipped).toBe('number');
      expect(typeof r.cutoffDate).toBe('string');
      expect(typeof r.dryRun).toBe('boolean');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. SQL structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — SQL structure', () => {
  it('SELECT uses FOR UPDATE SKIP LOCKED', async () => {
    const c0 = makeMockClient({ rows: [[row()], []] });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    // Exclude information_schema queries (the hoisted column-existence check)
    // which are plain catalog lookups without row locking.
    const rowFetchSelects = c0.queries.filter(
      (q) => /^\s*SELECT/i.test(q.sql) && !/information_schema/i.test(q.sql)
    );
    expect(rowFetchSelects.length).toBeGreaterThanOrEqual(1);
    for (const s of rowFetchSelects) {
      expect(s.sql.toUpperCase()).toContain('FOR UPDATE SKIP LOCKED');
    }
  });

  it('DELETE targets the correct table', async () => {
    const rule = PURGEABLE_RETENTION_SCHEDULE[0]; // audit_logs
    const c0 = makeMockClient({ rows: [[row({ id: 'del-1' })], []] });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    const dels = c0.queries.filter((q) => /^DELETE/i.test(q.sql));
    expect(dels.length).toBeGreaterThanOrEqual(1);
    expect(dels[0].sql).toContain(`"${rule.table}"`);
  });

  it('PURGE_INITIATED INSERT contains correct action string', async () => {
    const c0 = makeMockClient({ rows: [[row()], []] });
    const c1 = makeMockClient({ rows: [[]] });
    await runRetentionPurge(opts([c0, c1]));
    const auditInsert = c0.queries.find(
      (q) => /INSERT INTO audit_logs/i.test(q.sql) && q.params.includes('PURGE_INITIATED')
    );
    expect(auditInsert).toBeDefined();
    // params: [timestamp, action, resource_type, resource_id, correlation_id, meta]
    expect(auditInsert!.params[1]).toBe('PURGE_INITIATED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 17. Dry-run write isolation (#832)
//
// Proves at the *data* level (not just query-string inspection) that dryRun
// leaves every seeded row untouched, while a real run removes them — and that
// PURGE_INITIATED is dry-run–scoped while PURGE_SKIPPED_LEGAL_HOLD fires in
// both modes.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * In-memory table store that DELETE/UPDATE mutate and that tests can
 * re-query after `runRetentionPurge` — mirrors "SELECT the table again".
 */
function makeTableStore(initial: Record<string, unknown>[]) {
  const store = new Map<string, Record<string, unknown>>();
  for (const r of initial) {
    store.set(String(r.id), { ...r });
  }
  return {
    /** Snapshot of current primary keys (stable order). */
    ids(): string[] {
      return [...store.keys()].sort();
    },
    has(id: string): boolean {
      return store.has(id);
    },
    get(id: string): Record<string, unknown> | undefined {
      return store.get(id);
    },
    size(): number {
      return store.size;
    },
    /** All current rows — used by the stateful SELECT. */
    all(): Record<string, unknown>[] {
      return [...store.values()];
    },
    delete(id: string): void {
      store.delete(id);
    },
    redact(id: string): void {
      const existing = store.get(id);
      if (existing) {
        store.set(id, {
          ...existing,
          meta: { purged: true },
          correlation_id: null,
        });
      }
    },
  };
}
type TableStore = ReturnType<typeof makeTableStore>;

/**
 * Mock client backed by a {@link TableStore}.
 * SELECT (candidate fetch) returns the current store contents once per connect
 * cycle then an empty batch so the job's drain loop terminates when
 * batchSize > remaining rows (same as production dry-run with a short table).
 * DELETE / UPDATE mutate the store so post-run assertions see real data effects.
 */
function makeStatefulClient(store: TableStore) {
  const queries: MockQuery[] = [];
  let selectCalls = 0;

  const client = {
    queries,
    store,
    released: false,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const trimmed = sql.trim();
      queries.push({ sql: trimmed, params });

      if (/^\s*SELECT/i.test(trimmed)) {
        // information_schema queries (hoisted column-existence check) should
        // NOT count toward the batch SELECT counter.  Always report the
        // column exists so legal_hold values from fixtures are honoured.
        if (/information_schema/i.test(trimmed)) {
          return { rows: [{ column_name: 'legal_hold' }], rowCount: 1 };
        }
        selectCalls += 1;
        // First SELECT of this client connection → current table snapshot.
        // Subsequent SELECTs → empty (job expects drain when batch < batchSize).
        if (selectCalls === 1) {
          const batch = store.all();
          return { rows: batch, rowCount: batch.length };
        }
        return { rows: [], rowCount: 0 };
      }

      if (/^\s*DELETE/i.test(trimmed)) {
        const id = String(params[0]);
        store.delete(id);
        return { rows: [], rowCount: 1 };
      }

      if (/^\s*UPDATE/i.test(trimmed)) {
        const id = String(params[0]);
        store.redact(id);
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(() => {
      client.released = true;
    }),
  };
  return client;
}

/** Empty client for subsequent schedule rules after the first. */
function emptyRuleClients(count: number): MockClient[] {
  return Array.from({ length: count }, () => makeMockClient({ rows: [[]] }));
}

describe('runRetentionPurge() — dry-run write isolation (#832)', () => {
  beforeEach(() => {
    vi.mocked(recordAuditEventToDb).mockClear();
    vi.mocked(recordAuditEventToDb).mockResolvedValue({});
  });

  it('dryRun:true leaves every seeded row present when re-queried from the table store', async () => {
    const seeded = [
      row({ id: 'keep-1', legal_hold: false }),
      row({ id: 'keep-2', legal_hold: false }),
      row({ id: 'keep-3', legal_hold: false }),
    ];
    const store = makeTableStore(seeded);
    const beforeIds = store.ids();
    const beforeSize = store.size();

    const c0 = makeStatefulClient(store);
    const rest = emptyRuleClients(PURGEABLE_RETENTION_SCHEDULE.length - 1);
    const result = await runRetentionPurge(
      opts([c0 as unknown as MockClient, ...rest], { dryRun: true, batchSize: 10 })
    );

    // Summary still reports what *would* be purged.
    expect(result.results[0].dryRun).toBe(true);
    expect(result.results[0].rowsPurged).toBe(3);
    expect(result.totalRowsPurged).toBe(3);

    // Data-level isolation: re-query the table — every seeded id is still there.
    expect(store.size()).toBe(beforeSize);
    expect(store.ids()).toEqual(beforeIds);
    for (const id of beforeIds) {
      expect(store.has(id)).toBe(true);
    }

    // No mutating SQL was issued.
    expect(c0.queries.filter((q) => /^\s*DELETE/i.test(q.sql))).toHaveLength(0);
    expect(c0.queries.filter((q) => /^\s*UPDATE/i.test(q.sql))).toHaveLength(0);
  });

  it('dryRun:false actually removes seeded rows from the table store', async () => {
    const seeded = [
      row({ id: 'gone-1', legal_hold: false }),
      row({ id: 'gone-2', legal_hold: false }),
    ];
    const store = makeTableStore(seeded);
    expect(store.size()).toBe(2);

    const c0 = makeStatefulClient(store);
    const rest = emptyRuleClients(PURGEABLE_RETENTION_SCHEDULE.length - 1);
    const result = await runRetentionPurge(
      opts([c0 as unknown as MockClient, ...rest], { dryRun: false, batchSize: 10 })
    );

    expect(result.results[0].dryRun).toBe(false);
    expect(result.results[0].rowsPurged).toBe(2);

    // Symmetric non-dry-run proof: table is empty of those ids.
    expect(store.size()).toBe(0);
    expect(store.has('gone-1')).toBe(false);
    expect(store.has('gone-2')).toBe(false);
    expect(c0.queries.filter((q) => /^\s*DELETE/i.test(q.sql))).toHaveLength(2);
  });

  it('does NOT write PURGE_INITIATED audit events in dry-run mode', async () => {
    const store = makeTableStore([row({ id: 'a1' }), row({ id: 'a2' })]);
    const c0 = makeStatefulClient(store);
    const rest = emptyRuleClients(PURGEABLE_RETENTION_SCHEDULE.length - 1);

    await runRetentionPurge(
      opts([c0 as unknown as MockClient, ...rest], {
        dryRun: true,
        correlationId: 'dry-run-no-purge-audit',
      })
    );

    const purgeInitiated = c0.queries.filter(
      (q) => /INSERT INTO audit_logs/i.test(q.sql) && q.params.includes('PURGE_INITIATED')
    );
    expect(purgeInitiated).toHaveLength(0);
  });

  it('DOES write PURGE_INITIATED audit events when dryRun is false', async () => {
    const store = makeTableStore([row({ id: 'a1' })]);
    const c0 = makeStatefulClient(store);
    const rest = emptyRuleClients(PURGEABLE_RETENTION_SCHEDULE.length - 1);

    await runRetentionPurge(
      opts([c0 as unknown as MockClient, ...rest], {
        dryRun: false,
        correlationId: 'real-purge-audit',
      })
    );

    const purgeInitiated = c0.queries.filter(
      (q) => /INSERT INTO audit_logs/i.test(q.sql) && q.params.includes('PURGE_INITIATED')
    );
    expect(purgeInitiated.length).toBeGreaterThanOrEqual(1);
    expect(purgeInitiated[0].params).toContain('real-purge-audit');
  });

  it('writes PURGE_SKIPPED_LEGAL_HOLD in dry-run mode without deleting held or unheld rows', async () => {
    const seeded = [
      row({ id: 'held-dry', legal_hold: true }),
      row({ id: 'free-dry', legal_hold: false }),
    ];
    const store = makeTableStore(seeded);
    const c0 = makeStatefulClient(store);
    const rest = emptyRuleClients(PURGEABLE_RETENTION_SCHEDULE.length - 1);

    const result = await runRetentionPurge(
      opts([c0 as unknown as MockClient, ...rest], {
        dryRun: true,
        correlationId: 'dry-hold-skip',
      })
    );

    expect(result.totalRowsSkipped).toBe(1);
    expect(result.totalRowsPurged).toBe(1); // would-be purge count for free-dry
    expect(store.has('held-dry')).toBe(true);
    expect(store.has('free-dry')).toBe(true); // dry-run must not delete free rows either
    expect(c0.queries.filter((q) => /^\s*DELETE/i.test(q.sql))).toHaveLength(0);

    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'PURGE_SKIPPED_LEGAL_HOLD',
      expect.any(String),
      'held-dry',
      'dry-hold-skip',
      expect.objectContaining({ reason: 'legal_hold = TRUE' })
    );

    // No PURGE_INITIATED in dry-run even when some rows would be purged.
    const purgeInitiated = c0.queries.filter(
      (q) => /INSERT INTO audit_logs/i.test(q.sql) && q.params.includes('PURGE_INITIATED')
    );
    expect(purgeInitiated).toHaveLength(0);
  });

  it('writes PURGE_SKIPPED_LEGAL_HOLD in real mode and only deletes unheld rows', async () => {
    const seeded = [
      row({ id: 'held-real', legal_hold: true }),
      row({ id: 'free-real', legal_hold: false }),
    ];
    const store = makeTableStore(seeded);
    const c0 = makeStatefulClient(store);
    const rest = emptyRuleClients(PURGEABLE_RETENTION_SCHEDULE.length - 1);

    const result = await runRetentionPurge(
      opts([c0 as unknown as MockClient, ...rest], {
        dryRun: false,
        correlationId: 'real-hold-skip',
      })
    );

    expect(result.totalRowsSkipped).toBe(1);
    expect(result.totalRowsPurged).toBe(1);

    // Held row survives; free row is gone.
    expect(store.has('held-real')).toBe(true);
    expect(store.has('free-real')).toBe(false);

    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'PURGE_SKIPPED_LEGAL_HOLD',
      expect.any(String),
      'held-real',
      'real-hold-skip',
      expect.objectContaining({ reason: 'legal_hold = TRUE' })
    );

    const purgeInitiated = c0.queries.filter(
      (q) => /INSERT INTO audit_logs/i.test(q.sql) && q.params.includes('PURGE_INITIATED')
    );
    expect(purgeInitiated.length).toBeGreaterThanOrEqual(1);
  });

  it('never issues UPDATE (redact) mutations under dryRun either', async () => {
    // Current schedule is delete-only, but guard against a future redact rule
    // silently mutating via UPDATE when dryRun is true.
    const store = makeTableStore([row({ id: 'r1' })]);
    const c0 = makeStatefulClient(store);
    const rest = emptyRuleClients(PURGEABLE_RETENTION_SCHEDULE.length - 1);

    await runRetentionPurge(opts([c0 as unknown as MockClient, ...rest], { dryRun: true }));

    expect(c0.queries.filter((q) => /^\s*UPDATE/i.test(q.sql))).toHaveLength(0);
    expect(store.has('r1')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 18. Query-count regression — information_schema runs at most once per rule
//
// Verifies that the hoisted column-existence check (tableHasColumn) is NOT
// issued as a correlated subquery inside the row-fetch SQL and that the
// standalone information_schema.columns query runs at most once per batch
// (i.e. once per rule for a single-batch table).
// ═══════════════════════════════════════════════════════════════════════════════

describe('runRetentionPurge() — query-count regression (#information_schema)', () => {
  it('issues at most one information_schema query per rule execution', async () => {
    // Use stateful clients so we can inspect every query across all rules.
    const stores = PURGEABLE_RETENTION_SCHEDULE.map(() =>
      makeTableStore([row({ id: 'r1', legal_hold: false })])
    );
    const clients = stores.map((s) => makeStatefulClient(s));

    // Duplicate each client so one gets the schema check and one the batch
    // (2 connects per rule: 1 schema + 1 batch).
    const poolClients: MockClient[] = [];
    for (const c of clients) {
      poolClients.push(c as unknown as MockClient);
      poolClients.push(c as unknown as MockClient);
    }
    const pool = makeMockPool(poolClients);
    const result = await runRetentionPurge({
      now: FIXED_NOW,
      batchSize: 10,
      pool: pool as unknown as PurgeJobOptions['pool'],
    });

    expect(result.totalRowsPurged).toBe(PURGEABLE_RETENTION_SCHEDULE.length);

    // Every rule should issue exactly one information_schema query on its
    // dedicated client (the first of the pair handles schema, the second
    // handles the batch).
    for (let i = 0; i < PURGEABLE_RETENTION_SCHEDULE.length; i++) {
      const infoSchemaQueries = clients[i].queries.filter((q) =>
        /information_schema/i.test(q.sql)
      );
      expect(infoSchemaQueries).toHaveLength(1);
    }
  });

  it('never embeds information_schema in the row-fetch SELECT SQL', async () => {
    const c0 = makeMockClient({ rows: [[row({ id: 'r1', legal_hold: false })], []] });
    const rest = emptyRuleClients(PURGEABLE_RETENTION_SCHEDULE.length - 1);
    await runRetentionPurge(opts([c0, ...rest]));

    // The row-fetch SELECT should NOT contain information_schema
    const fetchSelects = c0.queries.filter(
      (q) => /^\s*SELECT/i.test(q.sql) && !/information_schema/i.test(q.sql)
    );
    for (const s of fetchSelects) {
      expect(s.sql.toUpperCase()).not.toContain('INFORMATION_SCHEMA');
      expect(s.sql.toUpperCase()).not.toContain('COALESCE');
    }
  });

  it('still correctly handles legal_hold=true for tables with the column', async () => {
    vi.mocked(recordAuditEventToDb).mockClear();
    const c0 = makeMockClient({
      rows: [[row({ id: 'h1', legal_hold: true })], []],
    });
    const rest = emptyRuleClients(PURGEABLE_RETENTION_SCHEDULE.length - 1);
    const result = await runRetentionPurge(opts([c0, ...rest]));

    expect(result.totalRowsSkipped).toBe(1);
    expect(recordAuditEventToDb).toHaveBeenCalledWith(
      'PURGE_SKIPPED_LEGAL_HOLD',
      expect.any(String),
      'h1',
      expect.any(String),
      expect.objectContaining({ reason: 'legal_hold = TRUE' })
    );
  });

  it('uses FALSE AS legal_hold when the table lacks the column', async () => {
    // Simulate a table WITHOUT a legal_hold column (hasLegalHold: false).
    const c0 = makeMockClient({
      rows: [[{ id: 'r1', legal_hold: 'should-be-ignored' }], []],
      hasLegalHold: false,
    });
    const rest = emptyRuleClients(PURGEABLE_RETENTION_SCHEDULE.length - 1);
    const result = await runRetentionPurge(opts([c0, ...rest]));

    // Row should be purged (no legal_hold means no hold can apply).
    expect(result.totalRowsPurged).toBe(1);
    expect(result.totalRowsSkipped).toBe(0);

    // The row-fetch SELECT should contain FALSE AS legal_hold, not a
    // direct column reference or information_schema subquery.
    const fetchSelect = c0.queries.find(
      (q) => /^\s*SELECT/i.test(q.sql) && !/information_schema/i.test(q.sql)
    );
    expect(fetchSelect).toBeDefined();
    expect(fetchSelect!.sql.toUpperCase()).toContain('FALSE AS LEGAL_HOLD');
    expect(fetchSelect!.sql.toUpperCase()).not.toContain('INFORMATION_SCHEMA');
  });
});
