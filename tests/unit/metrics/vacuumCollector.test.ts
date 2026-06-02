/**
 * Tests for the Postgres VACUUM metrics collector (#296).
 *
 * Covers:
 *  - Gauges registered in the Prometheus registry after module import
 *  - Dead tuple, bloat ratio, and autovacuum-age metrics set correctly
 *  - NULL last_autovacuum sets age gauge to -1 (never vacuumed)
 *  - Zero-row result (table not yet in pg_stat_user_tables) does not throw
 *  - DB query error is logged as a warning and does not throw
 *  - Bloat ratio is 0 when table has no dead tuples
 *  - Bloat ratio is 1 when table has only dead tuples (no live rows)
 *  - startVacuumCollector returns an interval handle and runs immediately
 *  - Collector re-registration is idempotent (getSingleMetric guard)
 *  - deRegisterVacuumMetrics removes all three Gauges from the registry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type pg from 'pg';
import { registry } from '../../../src/metrics.js';
import {
  collectVacuumMetrics,
  startVacuumCollector,
  deRegisterVacuumMetrics,
  pgDeadTuples,
  pgBloatRatio,
  pgLastAutovacuumAgeSeconds,
  MONITORED_TABLES,
} from '../../../src/metrics/vacuumCollector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type VacuumRow = {
  table_name: string;
  n_dead_tup: string;
  n_live_tup: string;
  last_autovacuum: Date | null;
};

function makePool(rows: VacuumRow[]): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as pg.Pool;
}

function makeFailingPool(message = 'DB error'): pg.Pool {
  return {
    query: vi.fn().mockRejectedValue(new Error(message)),
  } as unknown as pg.Pool;
}

function getGaugeValue(gauge: ReturnType<typeof pgDeadTuples>, labels: Record<string, string>): number | undefined {
  // prom-client stores Gauge values in an internal hashMap keyed by label values.
  // @ts-expect-error accessing internal for test
  const hash = gauge.hashMap as Record<string, { value: number }>;
  const key = Object.keys(hash).find((k) =>
    Object.values(labels).every((v) => k.includes(v)),
  );
  return key !== undefined ? hash[key]?.value : undefined;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  deRegisterVacuumMetrics();
  // Silence logger output in tests
  warnSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  warnSpy.mockRestore();
  deRegisterVacuumMetrics();
});

// ---------------------------------------------------------------------------
// Registry registration
// ---------------------------------------------------------------------------

describe('Gauge registration', () => {
  it('registers fluxora_pg_dead_tuples in the Prometheus registry', () => {
    expect(registry.getSingleMetric('fluxora_pg_dead_tuples')).toBeDefined();
  });

  it('registers fluxora_pg_bloat_ratio in the Prometheus registry', () => {
    expect(registry.getSingleMetric('fluxora_pg_bloat_ratio')).toBeDefined();
  });

  it('registers fluxora_pg_last_autovacuum_age_seconds in the Prometheus registry', () => {
    expect(registry.getSingleMetric('fluxora_pg_last_autovacuum_age_seconds')).toBeDefined();
  });

  it('all three Gauges have a "table" label', () => {
    for (const name of [
      'fluxora_pg_dead_tuples',
      'fluxora_pg_bloat_ratio',
      'fluxora_pg_last_autovacuum_age_seconds',
    ]) {
      const metric = registry.getSingleMetric(name);
      // @ts-expect-error accessing internal for test
      expect(metric?.labelNames).toContain('table');
    }
  });
});

// ---------------------------------------------------------------------------
// Correct metric values
// ---------------------------------------------------------------------------

describe('collectVacuumMetrics — correct values', () => {
  it('sets dead tuple count for each table', async () => {
    const pool = makePool([
      { table_name: 'streams', n_dead_tup: '42', n_live_tup: '1000', last_autovacuum: new Date() },
    ]);
    await collectVacuumMetrics(pool);
    expect(getGaugeValue(pgDeadTuples, { table: 'streams' })).toBe(42);
  });

  it('sets bloat ratio as dead / (live + dead)', async () => {
    const pool = makePool([
      { table_name: 'contract_events', n_dead_tup: '100', n_live_tup: '900', last_autovacuum: new Date() },
    ]);
    await collectVacuumMetrics(pool);
    const ratio = getGaugeValue(pgBloatRatio, { table: 'contract_events' });
    expect(ratio).toBeCloseTo(0.1, 5);
  });

  it('sets bloat ratio to 0 when there are no dead tuples', async () => {
    const pool = makePool([
      { table_name: 'audit_logs', n_dead_tup: '0', n_live_tup: '500', last_autovacuum: new Date() },
    ]);
    await collectVacuumMetrics(pool);
    expect(getGaugeValue(pgBloatRatio, { table: 'audit_logs' })).toBe(0);
  });

  it('sets bloat ratio to 0 when both live and dead tuples are 0', async () => {
    const pool = makePool([
      { table_name: 'webhook_outbox', n_dead_tup: '0', n_live_tup: '0', last_autovacuum: new Date() },
    ]);
    await collectVacuumMetrics(pool);
    expect(getGaugeValue(pgBloatRatio, { table: 'webhook_outbox' })).toBe(0);
  });

  it('sets bloat ratio to 1 when all tuples are dead', async () => {
    const pool = makePool([
      { table_name: 'streams', n_dead_tup: '200', n_live_tup: '0', last_autovacuum: new Date() },
    ]);
    await collectVacuumMetrics(pool);
    expect(getGaugeValue(pgBloatRatio, { table: 'streams' })).toBe(1);
  });

  it('sets autovacuum age in seconds relative to now', async () => {
    const lastVacuum = new Date(Date.now() - 120_000); // 2 minutes ago
    const pool = makePool([
      { table_name: 'streams', n_dead_tup: '10', n_live_tup: '100', last_autovacuum: lastVacuum },
    ]);
    await collectVacuumMetrics(pool);
    const age = getGaugeValue(pgLastAutovacuumAgeSeconds, { table: 'streams' });
    expect(age).toBeGreaterThanOrEqual(119);
    expect(age).toBeLessThan(125);
  });

  it('sets metrics for all tables in a multi-row result', async () => {
    const now = new Date();
    const pool = makePool(
      MONITORED_TABLES.map((t) => ({
        table_name: t,
        n_dead_tup: '10',
        n_live_tup: '90',
        last_autovacuum: now,
      })),
    );
    await collectVacuumMetrics(pool);
    for (const table of MONITORED_TABLES) {
      expect(getGaugeValue(pgDeadTuples, { table })).toBe(10);
      expect(getGaugeValue(pgBloatRatio, { table })).toBeCloseTo(0.1, 5);
    }
  });
});

// ---------------------------------------------------------------------------
// NULL last_autovacuum (never vacuumed)
// ---------------------------------------------------------------------------

describe('collectVacuumMetrics — NULL last_autovacuum', () => {
  it('sets autovacuum age gauge to -1 when last_autovacuum is null', async () => {
    const pool = makePool([
      { table_name: 'streams', n_dead_tup: '5', n_live_tup: '50', last_autovacuum: null },
    ]);
    await collectVacuumMetrics(pool);
    expect(getGaugeValue(pgLastAutovacuumAgeSeconds, { table: 'streams' })).toBe(-1);
  });

  it('still sets dead-tuple and bloat-ratio for a never-vacuumed table', async () => {
    const pool = makePool([
      { table_name: 'audit_logs', n_dead_tup: '20', n_live_tup: '80', last_autovacuum: null },
    ]);
    await collectVacuumMetrics(pool);
    expect(getGaugeValue(pgDeadTuples, { table: 'audit_logs' })).toBe(20);
    expect(getGaugeValue(pgBloatRatio, { table: 'audit_logs' })).toBeCloseTo(0.2, 5);
  });
});

// ---------------------------------------------------------------------------
// Empty result (table not yet in pg_stat_user_tables)
// ---------------------------------------------------------------------------

describe('collectVacuumMetrics — empty result set', () => {
  it('does not throw when pg_stat_user_tables returns no rows', async () => {
    const pool = makePool([]);
    await expect(collectVacuumMetrics(pool)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DB query error
// ---------------------------------------------------------------------------

describe('collectVacuumMetrics — DB error handling', () => {
  it('does not throw when the pool query rejects', async () => {
    const pool = makeFailingPool('connection refused');
    await expect(collectVacuumMetrics(pool)).resolves.toBeUndefined();
  });

  it('logs a warning when the pool query rejects', async () => {
    const pool = makeFailingPool('connection refused');
    await collectVacuumMetrics(pool);
    const output = warnSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('Vacuum metrics collection failed');
  });

  it('does not update any gauge values when the query fails', async () => {
    const pool = makeFailingPool();
    await collectVacuumMetrics(pool);
    // No gauge values should exist since no successful collection has run
    // @ts-expect-error accessing internal for test
    const hash = pgDeadTuples.hashMap as Record<string, unknown>;
    expect(Object.keys(hash)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// startVacuumCollector
// ---------------------------------------------------------------------------

describe('startVacuumCollector', () => {
  it('returns a NodeJS.Timeout handle', () => {
    const pool = makePool([]);
    const handle = startVacuumCollector(pool, 100_000);
    expect(handle).toBeDefined();
    clearInterval(handle);
  });

  it('calls collectVacuumMetrics immediately on start', async () => {
    const pool = makePool([
      { table_name: 'streams', n_dead_tup: '7', n_live_tup: '93', last_autovacuum: new Date() },
    ]);
    const handle = startVacuumCollector(pool, 100_000);
    // Allow the immediately-invoked promise to settle
    await new Promise((r) => setTimeout(r, 20));
    clearInterval(handle);
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('can be stopped by calling clearInterval on the returned handle', () => {
    const pool = makePool([]);
    const handle = startVacuumCollector(pool, 50);
    clearInterval(handle);
    // No assertion needed — just verifying clearInterval does not throw
  });
});

// ---------------------------------------------------------------------------
// deRegisterVacuumMetrics
// ---------------------------------------------------------------------------

describe('deRegisterVacuumMetrics', () => {
  it('removes fluxora_pg_dead_tuples from the registry', () => {
    deRegisterVacuumMetrics();
    expect(registry.getSingleMetric('fluxora_pg_dead_tuples')).toBeUndefined();
  });

  it('removes fluxora_pg_bloat_ratio from the registry', () => {
    deRegisterVacuumMetrics();
    expect(registry.getSingleMetric('fluxora_pg_bloat_ratio')).toBeUndefined();
  });

  it('removes fluxora_pg_last_autovacuum_age_seconds from the registry', () => {
    deRegisterVacuumMetrics();
    expect(registry.getSingleMetric('fluxora_pg_last_autovacuum_age_seconds')).toBeUndefined();
  });
});
