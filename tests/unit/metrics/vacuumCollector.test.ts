import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type pg from 'pg';
import {
  rowToVacuumRow,
  startVacuumCollector,
  deRegisterVacuumMetrics,
} from '../../../src/metrics/vacuumCollector.js';
import { BIGINT_SAFE_MAX, RowMappingError } from '../../../src/db/rowMapping.js';
import { registry } from '../../../src/metrics.js';

describe('rowToVacuumRow', () => {
  it('maps a well-formed row to a VacuumRow', () => {
    const lastAutovacuum = new Date('2026-01-01T00:00:00Z');
    const row = {
      table_name: 'streams',
      n_dead_tup: '12',
      n_live_tup: '88',
      last_autovacuum: lastAutovacuum,
    };

    expect(rowToVacuumRow(row)).toEqual({
      table_name: 'streams',
      n_dead_tup: '12',
      n_live_tup: '88',
      last_autovacuum: lastAutovacuum,
    });
  });

  it('accepts zero dead/live tuples and a null last_autovacuum (never vacuumed)', () => {
    const row = {
      table_name: 'audit_logs',
      n_dead_tup: '0',
      n_live_tup: '0',
      last_autovacuum: null,
    };

    expect(rowToVacuumRow(row)).toEqual({
      table_name: 'audit_logs',
      n_dead_tup: '0',
      n_live_tup: '0',
      last_autovacuum: null,
    });
  });

  it('accepts a tuple count at BIGINT_SAFE_MAX', () => {
    const row = {
      table_name: 'contract_events',
      n_dead_tup: String(BIGINT_SAFE_MAX),
      n_live_tup: '0',
      last_autovacuum: null,
    };

    expect(rowToVacuumRow(row).n_dead_tup).toBe(String(BIGINT_SAFE_MAX));
  });

  it('rejects a tuple count one past BIGINT_SAFE_MAX', () => {
    const row = {
      table_name: 'contract_events',
      n_dead_tup: String(BIGINT_SAFE_MAX + 1),
      n_live_tup: '0',
      last_autovacuum: null,
    };

    expect(() => rowToVacuumRow(row)).toThrow(RowMappingError);
  });

  it('rejects a negative tuple count', () => {
    const row = {
      table_name: 'streams',
      n_dead_tup: '-1',
      n_live_tup: '0',
      last_autovacuum: null,
    };

    try {
      rowToVacuumRow(row);
      expect.unreachable('expected rowToVacuumRow to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RowMappingError);
      expect((err as RowMappingError).column).toBe('n_dead_tup');
    }
  });

  it('rejects a row missing table_name', () => {
    const row = {
      n_dead_tup: '0',
      n_live_tup: '0',
      last_autovacuum: null,
    };

    try {
      rowToVacuumRow(row);
      expect.unreachable('expected rowToVacuumRow to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RowMappingError);
      expect((err as RowMappingError).column).toBe('table_name');
    }
  });
});

describe('startVacuumCollector', () => {
  const fakePool = (): pg.Pool =>
    ({ query: vi.fn().mockResolvedValue({ rows: [] }) }) as unknown as pg.Pool;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs one collection immediately, before any interval elapses', () => {
    const pool = fakePool();

    startVacuumCollector(pool);

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('schedules subsequent collections every 60 seconds by default', async () => {
    const pool = fakePool();

    startVacuumCollector(pool);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pool.query).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it('honours a custom intervalMs', async () => {
    const pool = fakePool();

    startVacuumCollector(pool, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    // one immediate + two interval fires
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it('returns a handle that stops collection when cleared', async () => {
    const pool = fakePool();

    const handle = startVacuumCollector(pool, 1_000);
    clearInterval(handle);

    await vi.advanceTimersByTimeAsync(10_000);

    // only the immediate collection ran; the interval never fired
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('deRegisterVacuumMetrics', () => {
  it('removes all vacuum metrics from the registry', () => {
    expect(registry.getSingleMetric('fluxora_pg_dead_tuples')).toBeDefined();
    expect(registry.getSingleMetric('fluxora_pg_bloat_ratio')).toBeDefined();
    expect(registry.getSingleMetric('fluxora_pg_last_autovacuum_age_seconds')).toBeDefined();
    expect(registry.getSingleMetric('fluxora_pg_vacuum_rows_rejected_total')).toBeDefined();

    deRegisterVacuumMetrics();

    expect(registry.getSingleMetric('fluxora_pg_dead_tuples')).toBeUndefined();
    expect(registry.getSingleMetric('fluxora_pg_bloat_ratio')).toBeUndefined();
    expect(registry.getSingleMetric('fluxora_pg_last_autovacuum_age_seconds')).toBeUndefined();
    expect(registry.getSingleMetric('fluxora_pg_vacuum_rows_rejected_total')).toBeUndefined();
  });
});
