/**
 * Contract tests for the retention purge job's audit_logs bypass wiring
 * (issue #1481): `audit_logs` is append-only at the storage layer, so the
 * purge job must carry the transaction-local opt-in (`SET LOCAL
 * app.allow_audit_delete = 'on'`) for `audit_logs` batches — and only there.
 *
 *  - audit_logs batch with candidates (real run) → SET LOCAL issued before
 *    the first DELETE, exactly once per batch transaction.
 *  - streams / webhook_outbox batches → never carry SET LOCAL.
 *  - dryRun with audit_logs candidates → no SET LOCAL and no DELETE/UPDATE.
 *
 * Uses an injectable mock pool; no real Postgres required.
 */

import { describe, it, expect, vi } from 'vitest';
import { runRetentionPurge } from '../../src/jobs/retentionPurge.js';
import type { PurgeJobOptions } from '../../src/jobs/retentionPurge.js';

vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEventToDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(),
}));

const NOW = new Date('2027-01-01T00:00:00.000Z');

function expiredAuditRow(id: string) {
  const d = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000);
  return { id, legal_hold: false, timestamp: d.toISOString(), created_at: d.toISOString() };
}

/**
 * Mock client: only the audit_logs candidate SELECT returns rows; every
 * other rule's SELECT returns []. Records every statement in order.
 */
function buildBypassMockClient() {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      queries.push(sql);
      if (sql.toLowerCase().includes('information_schema')) {
        return { rows: [{ column_name: 'legal_hold' }], rowCount: 1 };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim()) || sql.startsWith('SET LOCAL')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        if (sql.includes('FROM "audit_logs"')) {
          // One non-empty batch, then empty — but only on the first call;
          // subsequent calls return [] so the loop terminates.
          const seen = queries.filter((q) => q.includes('FROM "audit_logs"') && q.includes('FOR UPDATE')).length;
          if (seen <= 1) {
            const batch = [expiredAuditRow('audit-old-1')];
            return { rows: batch, rowCount: batch.length };
          }
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('INSERT INTO audit_logs') || sql.startsWith('DELETE FROM')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
    _queries: queries,
  };
  return client;
}

function baseOptions(pool: unknown): PurgeJobOptions {
  return { pool: pool as never, now: NOW, batchSize: 10, correlationId: 'bypass-test' };
}

describe('runRetentionPurge — audit_logs storage-layer bypass wiring', () => {
  it('sets SET LOCAL app.allow_audit_delete before deleting audit_logs rows', async () => {
    const client = buildBypassMockClient();
    const pool = { connect: vi.fn(async () => client) };

    const result = await runRetentionPurge(baseOptions(pool));
    const auditRule = result.results.find((r) => r.table === 'audit_logs')!;
    expect(auditRule.rowsPurged).toBe(1);

    const queries = client._queries as string[];
    const setLocalIdx = queries.findIndex((q) => q.startsWith('SET LOCAL app.allow_audit_delete'));
    const deleteIdx = queries.findIndex((q) => q.startsWith('DELETE FROM "audit_logs"'));
    expect(setLocalIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(setLocalIdx).toBeLessThan(deleteIdx);
  });

  it('never sets the bypass for streams or webhook_outbox rules', async () => {
    const client = buildBypassMockClient();
    const pool = { connect: vi.fn(async () => client) };

    await runRetentionPurge(baseOptions(pool));

    const queries = client._queries as string[];
    const bypassCount = queries.filter((q) =>
      q.startsWith('SET LOCAL app.allow_audit_delete'),
    ).length;
    // Exactly one audit_logs batch ran → exactly one opt-in.
    expect(bypassCount).toBe(1);
  });

  it('dryRun with audit_logs candidates issues no SET LOCAL and no DELETE/UPDATE', async () => {
    const client = buildBypassMockClient();
    const pool = { connect: vi.fn(async () => client) };

    const result = await runRetentionPurge({ ...baseOptions(pool), dryRun: true });
    const auditRule = result.results.find((r) => r.table === 'audit_logs')!;
    expect(auditRule.dryRun).toBe(true);

    const queries = (client._queries as string[]).map((q) => q.trim());
    expect(queries.filter((q) => q.startsWith('SET LOCAL'))).toHaveLength(0);
    expect(queries.filter((q) => q.startsWith('DELETE') || q.startsWith('UPDATE'))).toHaveLength(0);
  });
});
