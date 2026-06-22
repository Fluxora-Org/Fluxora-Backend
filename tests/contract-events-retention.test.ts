import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgClientMocks = {
  connect: vi.fn(),
  end: vi.fn(),
  query: vi.fn(),
};

vi.mock('pg', () => {
  function MockClient() {
    return pgClientMocks;
  }
  return { default: { Client: MockClient } };
});

import { enforceContractEventsRetention } from '../src/scripts/db-ops.js';

const DATABASE_URL = 'postgres://user:secret@localhost:5432/fluxora';

function mockCurrentLedger(value = 10_000): void {
  pgClientMocks.query.mockResolvedValueOnce({
    rows: [{ current_ledger: value }],
  });
}

function mockPartitions(): void {
  pgClientMocks.query.mockResolvedValueOnce({
    rows: [
      {
        partition_name: 'contract_events_ledger_0_1000',
        start_ledger: 0,
        end_ledger: 1000,
        row_estimate: 123,
      },
      {
        partition_name: 'contract_events_ledger_9000_10000',
        start_ledger: 9000,
        end_ledger: 10000,
        row_estimate: 456,
      },
    ],
  });
}

describe('enforceContractEventsRetention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pgClientMocks.connect.mockResolvedValue(undefined);
    pgClientMocks.end.mockResolvedValue(undefined);
    pgClientMocks.query.mockReset();
  });

  it('rejects non-postgres URLs before connecting', async () => {
    const result = await enforceContractEventsRetention({
      databaseUrl: 'mysql://localhost/db',
      retainLedgers: 1000,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('PostgreSQL');
    expect(pgClientMocks.connect).not.toHaveBeenCalled();
  });

  it('rejects invalid retention windows before connecting', async () => {
    const result = await enforceContractEventsRetention({
      databaseUrl: DATABASE_URL,
      retainLedgers: 0,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('positive integer');
    expect(pgClientMocks.connect).not.toHaveBeenCalled();
  });

  it('defaults to dry-run and reports only partitions ending before the cutoff ledger', async () => {
    mockCurrentLedger(10_000);
    mockPartitions();

    const result = await enforceContractEventsRetention({
      databaseUrl: DATABASE_URL,
      retainLedgers: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.cutoffLedger).toBe(5001);
    expect(result.partitions.map((partition) => partition.name)).toEqual([
      'contract_events_ledger_0_1000',
    ]);
    expect(result.executedPartitions).toEqual([]);
    expect(pgClientMocks.query).not.toHaveBeenCalledWith('BEGIN');
  });

  it('requires confirm true for live detach operations', async () => {
    const result = await enforceContractEventsRetention({
      databaseUrl: DATABASE_URL,
      retainLedgers: 5000,
      dryRun: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('confirm');
    expect(pgClientMocks.connect).not.toHaveBeenCalled();
  });

  it('requires backup confirmation before dropping partitions', async () => {
    const result = await enforceContractEventsRetention({
      databaseUrl: DATABASE_URL,
      retainLedgers: 5000,
      dryRun: false,
      confirm: true,
      mode: 'drop',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('backupConfirmed');
    expect(pgClientMocks.connect).not.toHaveBeenCalled();
  });

  it('detaches eligible partitions and writes audit rows when confirmed', async () => {
    mockCurrentLedger(10_000);
    mockPartitions();
    pgClientMocks.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // DETACH
      .mockResolvedValueOnce({ rows: [{ audit_table: 'audit_logs' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit insert
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await enforceContractEventsRetention({
      databaseUrl: DATABASE_URL,
      retainLedgers: 5000,
      dryRun: false,
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(result.executedPartitions).toEqual(['contract_events_ledger_0_1000']);
    expect(pgClientMocks.query).toHaveBeenCalledWith('BEGIN');
    expect(pgClientMocks.query).toHaveBeenCalledWith(
      'ALTER TABLE "contract_events" DETACH PARTITION "contract_events_ledger_0_1000"',
    );
    expect(pgClientMocks.query).toHaveBeenCalledWith('COMMIT');
  });

  it('drops only when mode is drop and backupConfirmed is true', async () => {
    mockCurrentLedger(10_000);
    mockPartitions();
    pgClientMocks.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // DROP
      .mockResolvedValueOnce({ rows: [{ audit_table: null }] })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await enforceContractEventsRetention({
      databaseUrl: DATABASE_URL,
      retainLedgers: 5000,
      dryRun: false,
      confirm: true,
      backupConfirmed: true,
      mode: 'drop',
    });

    expect(result.success).toBe(true);
    expect(pgClientMocks.query).toHaveBeenCalledWith(
      'DROP TABLE "contract_events_ledger_0_1000"',
    );
  });

  it('rolls back and redacts DATABASE_URL credentials when execution fails', async () => {
    mockCurrentLedger(10_000);
    mockPartitions();
    pgClientMocks.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(new Error(`connection failed for ${DATABASE_URL}`))
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const result = await enforceContractEventsRetention({
      databaseUrl: DATABASE_URL,
      retainLedgers: 5000,
      dryRun: false,
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('postgres://***@localhost');
    expect(result.error).not.toContain('secret');
    expect(pgClientMocks.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
