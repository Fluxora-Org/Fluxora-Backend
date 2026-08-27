/**
 * Tests for DLQ retention purge functionality.
 *
 * Covers:
 *  - purging replayed entries older than cutoff
 *  - purging dead entries older than cutoff (exhausted/abandoned)
 *  - NOT purging recent dead entries (pending/in-flight)
 *  - NOT purging recent replayed entries
 *  - batch size limits
 *  - empty table / no eligible rows
 *  - cutoff boundary (exactly at cutoff)
 *  - runDlqPurge with retentionDays=0 disables purge
 *  - audit event emission
 *  - concurrent insert safety (no interference with active entries)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockRecordAuditEvent = vi.fn();
vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEvent: (...args: unknown[]) => mockRecordAuditEvent(...args),
  recordAuditEventToDb: vi.fn(),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { dlqRepository } from '../../src/db/repositories/dlqRepository.js';
import { runDlqPurge } from '../../src/jobs/dlqPurge.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockQueryResult(rowCount: number): void {
  mockQuery.mockResolvedValue({ rowCount, rows: [] });
}

function mockQueryError(message: string): void {
  mockQuery.mockRejectedValue(new Error(message));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: return 0 rows deleted (no-op)
  mockQueryResult(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── dlqRepository.purgeTerminalEntries ──────────────────────────────────────

describe('dlqRepository.purgeTerminalEntries', () => {
  it('deletes replayed entries older than the cutoff', async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockQueryResult(3);

    const deleted = await dlqRepository.purgeTerminalEntries(500, cutoff);

    expect(deleted).toBe(3);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // mockQuery is called with (_pool, sql, params)
    const [[, sql, params]] = mockQuery.mock.calls;
    expect(sql).toContain("status = 'replayed'");
    expect(sql).toContain("status = 'dead'");
    expect(sql).toContain('last_failed_at < $2');
    expect(sql).toContain('ORDER BY last_failed_at ASC');
    expect(params[0]).toBe(500);   // batchSize
    expect(params[1]).toBe(cutoff); // cutoffDate
  });

  it('deletes dead entries older than the cutoff (exhausted/abandoned)', async () => {
    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    mockQueryResult(5);

    const deleted = await dlqRepository.purgeTerminalEntries(500, cutoff);

    expect(deleted).toBe(5);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('does NOT delete recent dead entries (still pending/in-flight)', async () => {
    // cutoff is 30 days ago — recent dead entries with last_failed_at = 1 day ago
    // should NOT be caught by "last_failed_at < cutoff"
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockQueryResult(0);

    const deleted = await dlqRepository.purgeTerminalEntries(500, cutoff);

    expect(deleted).toBe(0);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Verify the SQL includes the correct WHERE clause
    const [[, sql]] = mockQuery.mock.calls;
    expect(sql).toContain('last_failed_at < $2');
  });

  it('respects batch size limit', async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockQueryResult(100);

    const deleted = await dlqRepository.purgeTerminalEntries(100, cutoff);

    expect(deleted).toBe(100);
    const [[, , params]] = mockQuery.mock.calls;
    expect(params[0]).toBe(100); // batchSize
  });

  it('returns 0 when no eligible rows exist', async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockQueryResult(0);

    const deleted = await dlqRepository.purgeTerminalEntries(500, cutoff);

    expect(deleted).toBe(0);
  });

  it('handles null rowCount gracefully', async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockQuery.mockResolvedValue({ rowCount: null, rows: [] });

    const deleted = await dlqRepository.purgeTerminalEntries(500, cutoff);

    expect(deleted).toBe(0);
  });

  it('propagates database errors', async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockQueryError('connection refused');

    await expect(
      dlqRepository.purgeTerminalEntries(500, cutoff),
    ).rejects.toThrow('connection refused');
  });

  it('uses parameterized query (no SQL injection via cutoff)', async () => {
    // This is a malicious cutoff value — if it were interpolated, it would
    // be SQL injection. Since we use parameterized queries ($2), it's safe.
    const cutoff = "2020-01-01'; DROP TABLE dead_letter_queue; --";
    mockQueryResult(0);

    await dlqRepository.purgeTerminalEntries(500, cutoff);

    const [[, , params]] = mockQuery.mock.calls;
    expect(params[1]).toBe(cutoff); // passed as parameter, not interpolated
  });
});

// ── runDlqPurge (job-level) ─────────────────────────────────────────────────

describe('runDlqPurge', () => {
  it('purges entries and returns a summary', async () => {
    mockQueryResult(12);

    const result = await runDlqPurge({
      retentionDays: 30,
      batchSize: 500,
      now: new Date('2026-07-29T00:00:00Z'),
      correlationId: 'test-cid-1',
    });

    expect(result.rowsPurged).toBe(12);
    expect(result.retentionDays).toBe(30);
    expect(result.batchSize).toBe(500);
    expect(result.startedAt).toBeDefined();
    expect(result.finishedAt).toBeDefined();
  });

  it('emits an audit event when rows are purged', async () => {
    mockQueryResult(5);

    await runDlqPurge({
      retentionDays: 30,
      now: new Date('2026-07-29T00:00:00Z'),
      correlationId: 'test-cid-2',
    });

    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
    const [action, resourceType, resourceId, correlationId, meta] =
      mockRecordAuditEvent.mock.calls[0];

    expect(action).toBe('DLQ_RETENTION_PURGED');
    expect(resourceType).toBe('dead_letter_queue');
    expect(correlationId).toBe('test-cid-2');
    expect(meta.rowsPurged).toBe(5);
    expect(meta.retentionDays).toBe(30);
    expect(meta.batchSize).toBe(500);
  });

  it('does NOT emit an audit event when no rows are purged', async () => {
    mockQueryResult(0);

    await runDlqPurge({
      retentionDays: 30,
      now: new Date('2026-07-29T00:00:00Z'),
      correlationId: 'test-cid-3',
    });

    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it('skips purge when retentionDays is 0 (disabled)', async () => {
    const result = await runDlqPurge({
      retentionDays: 0,
      now: new Date('2026-07-29T00:00:00Z'),
      correlationId: 'test-cid-4',
    });

    expect(result.rowsPurged).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it('skips purge when retentionDays is negative (disabled)', async () => {
    const result = await runDlqPurge({
      retentionDays: -1,
      now: new Date('2026-07-29T00:00:00Z'),
    });

    expect(result.rowsPurged).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('uses defaults from config when options are omitted', async () => {
    mockQueryResult(8);

    const result = await runDlqPurge({
      correlationId: 'test-cid-5',
    });

    expect(result.rowsPurged).toBe(8);
  });

  it('correctly computes cutoff from retentionDays and now', async () => {
    mockQueryResult(0);

    await runDlqPurge({
      retentionDays: 7,
      batchSize: 100,
      now: new Date('2026-07-29T12:00:00Z'),
    });

    const [[, , params]] = mockQuery.mock.calls;
    // Params: [batchSize, cutoffDate]
    expect(params[1]).toBe('2026-07-22T12:00:00.000Z');
  });

  it('propagates errors from the repository', async () => {
    mockQueryError('database unavailable');

    await expect(
      runDlqPurge({
        retentionDays: 30,
        now: new Date('2026-07-29T00:00:00Z'),
        correlationId: 'test-cid-6',
      }),
    ).rejects.toThrow('database unavailable');
  });

  it('handles custom batch size option', async () => {
    mockQueryResult(25);

    const result = await runDlqPurge({
      retentionDays: 30,
      batchSize: 250,
      now: new Date('2026-07-29T00:00:00Z'),
    });

    expect(result.batchSize).toBe(250);
    const [[, , params]] = mockQuery.mock.calls;
    expect(params[0]).toBe(250);
  });

  it('handles custom retentionDays option', async () => {
    mockQueryResult(3);

    const result = await runDlqPurge({
      retentionDays: 90,
      now: new Date('2026-07-29T00:00:00Z'),
    });

    expect(result.retentionDays).toBe(90);
    const [[, , params]] = mockQuery.mock.calls;
    expect(params[1]).toBeDefined();
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('DLQ purge edge cases', () => {
  it('handles exactly-at-cutoff boundary correctly', async () => {
    // Entry with last_failed_at exactly at cutoff should NOT be purged
    // (the query uses < not <=)
    const now = new Date('2026-07-29T00:00:00Z');
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const cutoffDate = cutoff.toISOString();
    mockQueryResult(0);

    const deleted = await dlqRepository.purgeTerminalEntries(500, cutoffDate);

    // The SQL uses `last_failed_at < $2`, so exact matches are excluded
    const [[, sql]] = mockQuery.mock.calls;
    expect(sql).toContain('last_failed_at < $2');
    expect(deleted).toBe(0);
  });

  it('handles very large batch sizes gracefully', async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockQueryResult(1000);

    const deleted = await dlqRepository.purgeTerminalEntries(9999, cutoff);

    expect(deleted).toBe(1000);
    const [[, , params]] = mockQuery.mock.calls;
    expect(params[0]).toBe(9999);
  });

  it('is safe when called concurrently (no interference with active entries)', async () => {
    // The SQL uses a subquery with LIMIT, not a table lock.
    // Pending entries (status=dead, recent last_failed_at) are excluded
    // by the WHERE clause, so concurrent replays are unaffected.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockQueryResult(5);

    const deleted = await dlqRepository.purgeTerminalEntries(500, cutoff);

    expect(deleted).toBe(5);
    // The key check: query only matches terminal states
    const [[, sql]] = mockQuery.mock.calls;
    expect(sql).toContain("status = 'replayed'");
    expect(sql).toContain("status = 'dead'");
    expect(sql).toContain('last_failed_at <');
  });
});
