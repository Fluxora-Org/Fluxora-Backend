import { Counter, Gauge } from 'prom-client';
import type pg from 'pg';
import { registry } from '../metrics.js';
import { logger } from '../lib/logger.js';
import { rowReader, RowMappingError, BIGINT_SAFE_MAX } from '../db/rowMapping.js';

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

export const pgVacuumRowsRejectedTotal =
  (registry.getSingleMetric('fluxora_pg_vacuum_rows_rejected_total') as Counter<'column'>) ||
  new Counter({
    name: 'fluxora_pg_vacuum_rows_rejected_total',
    help: 'Vacuum stat rows quarantined because a column violated its contract',
    labelNames: ['column'] as const,
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

/**
 * Map a raw `pg_stat_user_tables` aggregate row into a typed {@link VacuumRow}.
 *
 * Never pass `VacuumRow` (or any bare domain interface) as the generic argument
 * to `pool.query<T>()` — pg requires `QueryResultRow`. Query with
 * `Record<string, unknown>` and map through this helper instead.
 * See `src/db/repositories/README.md`.
 *
 * Contract, derived from the shape of {@link VACUUM_STATS_SQL}:
 *
 * | Column            | Source                          | Nullable |
 * | ----------------- | ------------------------------- | -------- |
 * | `table_name`      | `pg_class.relname`              | no       |
 * | `n_dead_tup`      | `SUM(s.n_dead_tup)` → `numeric` | no       |
 * | `n_live_tup`      | `SUM(s.n_live_tup)` → `numeric` | no       |
 * | `last_autovacuum` | `MAX(s.last_autovacuum)`        | **yes**  |
 *
 * Tuple counts are non-negative and summed across partitions, so they are read
 * as `bigint`-range integers and re-emitted as canonical decimal strings. The
 * `string` shape is kept because {@link collectVacuumMetrics} parses it back,
 * but the value is now guaranteed to survive `parseInt` — previously a NULL
 * became `'0'` and a wrongly-typed value became `'NaN'`, and both were fed
 * straight into a Gauge as a real reading.
 *
 * `last_autovacuum` is genuinely nullable: a table that has never been
 * autovacuumed reports NULL, which the collector surfaces as the sentinel -1
 * rather than as an age.
 *
 * @throws {RowMappingError} if any column violates the contract above.
 */
export function rowToVacuumRow(row: Record<string, unknown>): VacuumRow {
  const r = rowReader('pg_stat_user_tables', row);
  const bounds = { min: 0, max: BIGINT_SAFE_MAX };

  return {
    table_name: r.requireString('table_name'),
    n_dead_tup: String(r.requireInt('n_dead_tup', bounds)),
    n_live_tup: String(r.requireInt('n_live_tup', bounds)),
    last_autovacuum: r.optionalDate('last_autovacuum'),
  };
}

// ── Collector ─────────────────────────────────────────────────────────────────

/**
 * Query pg_stat_user_tables for the four core tables and update the three
 * prom-client Gauges. Errors are logged as warnings and do not throw so that
 * a transient DB outage cannot crash the metrics collection loop.
 */
export async function collectVacuumMetrics(pool: pg.Pool): Promise<void> {
  let rawRows: Record<string, unknown>[];

  try {
    const result = await pool.query<Record<string, unknown>>(VACUUM_STATS_SQL, [MONITORED_TABLES]);
    rawRows = result.rows;
  } catch (err) {
    logger.warn('Vacuum metrics collection failed — skipping this interval', undefined, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Quarantine, not fail-fast: one unmappable row must not blank out the
  // gauges for the other monitored tables, and must not kill the collection
  // loop. A rejected row is counted and logged so the quarantine is visible —
  // dropping it silently would be the same failure mode as coercing it.
  const rows: VacuumRow[] = [];
  for (const rawRow of rawRows) {
    try {
      rows.push(rowToVacuumRow(rawRow));
    } catch (err) {
      if (!(err instanceof RowMappingError)) throw err;
      pgVacuumRowsRejectedTotal.inc({ column: err.column });
      logger.warn('Skipping unmappable vacuum stat row', undefined, {
        table: err.table,
        column: err.column,
        reason: err.reason,
        received: err.received,
      });
    }
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
  registry.removeSingleMetric('fluxora_pg_vacuum_rows_rejected_total');
}
