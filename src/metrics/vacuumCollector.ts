import { Gauge } from 'prom-client';
import type pg from 'pg';
import { registry } from '../metrics.js';
import { logger } from '../lib/logger.js';

// Tables with high write throughput that accumulate dead tuples fastest.
export const MONITORED_TABLES = [
  'streams',
  'contract_events',
  'audit_logs',
  'webhook_outbox',
] as const;

export type MonitoredTable = (typeof MONITORED_TABLES)[number];

// ── Gauge definitions ─────────────────────────────────────────────────────────

export const pgDeadTuples =
  (registry.getSingleMetric('fluxora_pg_dead_tuples') as Gauge<'table'>) ||
  new Gauge({
    name: 'fluxora_pg_dead_tuples',
    help: 'Dead tuple count per monitored table (pg_stat_user_tables.n_dead_tup)',
    labelNames: ['table'] as const,
    registers: [registry],
  });

export const pgBloatRatio =
  (registry.getSingleMetric('fluxora_pg_bloat_ratio') as Gauge<'table'>) ||
  new Gauge({
    name: 'fluxora_pg_bloat_ratio',
    help: 'Estimated bloat ratio per table: n_dead_tup / (n_live_tup + n_dead_tup)',
    labelNames: ['table'] as const,
    registers: [registry],
  });

export const pgLastAutovacuumAgeSeconds =
  (registry.getSingleMetric('fluxora_pg_last_autovacuum_age_seconds') as Gauge<'table'>) ||
  new Gauge({
    name: 'fluxora_pg_last_autovacuum_age_seconds',
    help: 'Seconds since the last autovacuum on each monitored table; -1 when autovacuum has never run',
    labelNames: ['table'] as const,
    registers: [registry],
  });

// ── Query ─────────────────────────────────────────────────────────────────────

const VACUUM_STATS_SQL = `
  WITH RECURSIVE tables AS (
    SELECT oid, relname AS root_table, relname AS table_name
    FROM pg_class
    WHERE relname = ANY($1::text[]) AND relkind IN ('r', 'p')
    UNION ALL
    SELECT i.inhrelid, t.root_table, c.relname
    FROM pg_inherits i
    JOIN tables t ON t.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
  )
  SELECT
    t.root_table AS table_name,
    SUM(s.n_dead_tup) AS n_dead_tup,
    SUM(s.n_live_tup) AS n_live_tup,
    MAX(s.last_autovacuum) AS last_autovacuum
  FROM tables t
  JOIN pg_stat_user_tables s ON s.relid = t.oid
  GROUP BY t.root_table
`;


interface VacuumRow {
  table_name: string;
  n_dead_tup: string;
  n_live_tup: string;
  last_autovacuum: Date | null;
}

// ── Collector ─────────────────────────────────────────────────────────────────

/**
 * Query pg_stat_user_tables for the four core tables and update the three
 * prom-client Gauges. Errors are logged as warnings and do not throw so that
 * a transient DB outage cannot crash the metrics collection loop.
 */
export async function collectVacuumMetrics(pool: pg.Pool): Promise<void> {
  let rows: VacuumRow[];

  try {
    const result = await pool.query<VacuumRow>(VACUUM_STATS_SQL, [MONITORED_TABLES]);
    rows = result.rows;
  } catch (err) {
    logger.warn('Vacuum metrics collection failed — skipping this interval', undefined, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const row of rows) {
    const table = row.table_name;
    const dead = parseInt(row.n_dead_tup, 10);
    const live = parseInt(row.n_live_tup, 10);
    const total = live + dead;
    const bloat = total > 0 ? dead / total : 0;

    pgDeadTuples.set({ table }, dead);
    pgBloatRatio.set({ table }, bloat);

    if (row.last_autovacuum === null) {
      // Table exists but autovacuum has never run — signal with -1.
      pgLastAutovacuumAgeSeconds.set({ table }, -1);
    } else {
      const ageMs = Date.now() - new Date(row.last_autovacuum).getTime();
      pgLastAutovacuumAgeSeconds.set({ table }, ageMs / 1000);
    }
  }
}

/**
 * Start the periodic vacuum-metrics collector.
 *
 * Runs one immediate collection then schedules subsequent collections every
 * `intervalMs` milliseconds (default 60 seconds). Returns the interval handle
 * so callers can stop it during graceful shutdown.
 */
export function startVacuumCollector(
  pool: pg.Pool,
  intervalMs = 60_000,
): NodeJS.Timeout {
  void collectVacuumMetrics(pool);
  return setInterval(() => {
    void collectVacuumMetrics(pool);
  }, intervalMs);
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Remove all vacuum Gauges from the registry — used between test runs. */
export function deRegisterVacuumMetrics(): void {
  registry.removeSingleMetric('fluxora_pg_dead_tuples');
  registry.removeSingleMetric('fluxora_pg_bloat_ratio');
  registry.removeSingleMetric('fluxora_pg_last_autovacuum_age_seconds');
}
