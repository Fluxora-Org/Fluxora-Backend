/**
 * Partition maintenance job — pre-creates monthly range partitions ahead of
 * schedule for `contract_events` (and, once partitioned, `audit_logs`) so
 * that write traffic never has to fall back to the unindexed `DEFAULT`
 * partition created by `20260627000000_contract_events_partitioning.ts`.
 *
 * @module jobs/partitionMaintenance
 *
 * ## What it does
 *
 * For every table in {@link CANDIDATE_TABLES}:
 *
 *  1. Checks whether the table is currently a RANGE-partitioned table
 *     (`pg_class.relkind = 'p'` and `pg_partitioned_table.partstrat = 'r'`).
 *     Tables that are not range-partitioned (e.g. `audit_logs` before it is
 *     migrated to partitioning) are skipped silently — this is expected
 *     steady state, not an error.
 *  2. For the current calendar month plus the next `monthsAhead` months,
 *     ensures a monthly partition named `<table>_y<YYYY>m<MM>` exists,
 *     creating it with `CREATE TABLE IF NOT EXISTS … PARTITION OF …` when
 *     missing.
 *  3. If the **current month's** partition is found missing, that means an
 *     earlier scheduled run failed to create it while it was still in the
 *     future — rows for *today* may already be landing in the unindexed
 *     `DEFAULT` partition. This is reported as "behind schedule" via a
 *     structured error log and the `partitionMaintenanceBehindScheduleTotal`
 *     counter, in addition to being self-healed immediately.
 *
 * ## Idempotency / concurrency safety
 *
 * The entire run is guarded by a single Postgres advisory lock
 * ({@link PARTITION_MAINTENANCE_LOCK_ID}), acquired with `pg_try_advisory_lock`
 * (non-blocking). If another instance already holds the lock, this run is a
 * no-op — it does **not** wait, retry, or error. This keeps multiple app
 * instances (or an overlapping cron + manual invocation) from racing to
 * `CREATE TABLE` the same partition concurrently.
 *
 * Partition creation itself is additionally idempotent at the SQL level via
 * `CREATE TABLE IF NOT EXISTS`, so even a partition that appears between our
 * existence check and the DDL call (e.g. created manually by an operator)
 * cannot cause an error.
 *
 * Re-running this job when every partition already exists is a safe no-op:
 * no DDL is executed, no rows are touched, and the result simply reports
 * zero created partitions.
 *
 * ## Security assumptions
 *
 * - Table names are drawn exclusively from the developer-controlled
 *   {@link CANDIDATE_TABLES} constant — never from user input.
 * - Partition names are derived deterministically from the table name plus
 *   a UTC year/month computed from the server clock (or the injected `now`
 *   option in tests) — never from user input.
 * - Both table and partition identifiers are additionally passed through
 *   {@link quoteIdentifier} before being interpolated into DDL, as
 *   defence-in-depth against a future change that widens the input surface.
 * - Partition bound literals are ISO-8601 UTC timestamps produced by
 *   `Date#toISOString()` and are validated against a strict regex
 *   ({@link isoRangeBound}) before being interpolated into DDL — DDL bound
 *   expressions cannot be parameterized via the `pg` driver's extended query
 *   protocol, so this validation is the substitute safety net.
 * - The job runs with the application's DB principal, which must have
 *   `CREATE` on the parent table (to add child partitions). It does not
 *   require super-user access.
 */

import type { Pool } from 'pg';
import { logger } from '../lib/logger.js';
import { query } from '../db/pool.js';
import {
  partitionsCreatedTotal,
  partitionMaintenanceBehindScheduleTotal,
} from '../metrics/businessMetrics.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Advisory lock key used to serialize partition-maintenance runs across
 * concurrent app instances / worker processes. Any bigint works for
 * `pg_try_advisory_lock`; this value is reserved exclusively for this job —
 * do not reuse it elsewhere.
 */
export const PARTITION_MAINTENANCE_LOCK_ID = 123_456_789;

/**
 * Tables managed by this job, in the order they are processed.
 *
 * `audit_logs` is included pre-emptively for when it is migrated to range
 * partitioning; until then {@link isRangePartitioned} reports it as
 * unmanaged and it is skipped without error.
 */
export const CANDIDATE_TABLES = ['contract_events', 'audit_logs'] as const;

export type CandidateTable = (typeof CANDIDATE_TABLES)[number];

/** Default number of future months pre-created beyond the current month. */
export const DEFAULT_MONTHS_AHEAD = 3;

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Options accepted by {@link runPartitionMaintenance}.
 */
export interface PartitionMaintenanceOptions {
  /** Number of future months (beyond the current month) to pre-create. Defaults to {@link DEFAULT_MONTHS_AHEAD}. */
  monthsAhead?: number;
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
  /** Correlation id threaded into every log line emitted by this run. */
  correlationId?: string;
}

/** Per-table outcome of a single {@link runPartitionMaintenance} run. */
export interface TablePartitionResult {
  /** Table name as listed in {@link CANDIDATE_TABLES}. */
  table: CandidateTable;
  /** `false` when the table does not exist or is not range-partitioned (skipped). */
  managed: boolean;
  /** Number of monthly partitions checked for existence (0 when `managed` is `false`). */
  partitionsChecked: number;
  /** Names of partitions that were newly created during this run. */
  partitionsCreated: string[];
  /** `true` when the current month's partition was found missing (see module docs). */
  behindSchedule: boolean;
}

/** Aggregate result of a full {@link runPartitionMaintenance} run. */
export interface PartitionMaintenanceResult {
  /** `false` when another instance already held the advisory lock — the run was a no-op. */
  lockAcquired: boolean;
  /** ISO-8601 timestamp when the run started. */
  startedAt: string;
  /** ISO-8601 timestamp when the run finished. */
  finishedAt: string;
  /** Per-table breakdown. Empty when `lockAcquired` is `false`. */
  tables: TablePartitionResult[];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute the partition maintenance job.
 *
 * Acquires a non-blocking Postgres advisory lock, then ensures the current
 * month plus `monthsAhead` future monthly partitions exist for every
 * range-partitioned table in {@link CANDIDATE_TABLES}.
 *
 * @param pool - PostgreSQL pool (or a mock exposing a compatible `query`) to run against.
 * @param options - Tuning / injection parameters, or (for backward compatibility)
 *                  a bare `monthsAhead` number.
 * @returns A summary of what was (or would have needed to be) created.
 * @throws {Error} If `monthsAhead` is not a non-negative integer.
 *
 * @example
 * ```ts
 * // Invoked by the job queue on a daily cron schedule (src/jobs/queue.ts)
 * const result = await runPartitionMaintenance(pool, { correlationId: ctx.id });
 * logger.info('Partition maintenance complete', ctx.id, result);
 * ```
 */
export async function runPartitionMaintenance(
  pool: Pool,
  optionsOrMonthsAhead: PartitionMaintenanceOptions | number = {},
): Promise<PartitionMaintenanceResult> {
  const options: PartitionMaintenanceOptions =
    typeof optionsOrMonthsAhead === 'number'
      ? { monthsAhead: optionsOrMonthsAhead }
      : optionsOrMonthsAhead;

  const monthsAhead = options.monthsAhead ?? DEFAULT_MONTHS_AHEAD;
  const correlationId = options.correlationId;
  const now = options.now ?? new Date();
  const startedAt = new Date().toISOString();

  if (!Number.isInteger(monthsAhead) || monthsAhead < 0) {
    throw new Error(`runPartitionMaintenance: monthsAhead must be a non-negative integer, got ${monthsAhead}`);
  }

  const lockRes = await query<{ pg_try_advisory_lock: boolean }>(
    pool,
    'SELECT pg_try_advisory_lock($1)',
    [PARTITION_MAINTENANCE_LOCK_ID],
  );

  if (lockRes.rows[0]?.pg_try_advisory_lock !== true) {
    logger.info('Partition maintenance: another instance holds the lock, skipping this run', correlationId, {
      event: 'partition_maintenance_skipped_lock_held',
    });
    return { lockAcquired: false, startedAt, finishedAt: new Date().toISOString(), tables: [] };
  }

  const tables: TablePartitionResult[] = [];
  try {
    for (const table of CANDIDATE_TABLES) {
      tables.push(await maintainTablePartitions(pool, table, monthsAhead, now, correlationId));
    }
  } finally {
    // Always release the lock, even if a table's maintenance throws, so a
    // single failure never wedges the job for every future run.
    await query(pool, 'SELECT pg_advisory_unlock($1)', [PARTITION_MAINTENANCE_LOCK_ID]);
  }

  const finishedAt = new Date().toISOString();
  logger.info('Partition maintenance run complete', correlationId, {
    event: 'partition_maintenance_complete',
    monthsAhead,
    tables: tables.map((t) => ({
      table: t.table,
      managed: t.managed,
      created: t.partitionsCreated,
      behindSchedule: t.behindSchedule,
    })),
  });

  return { lockAcquired: true, startedAt, finishedAt, tables };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Ensure the current month plus `monthsAhead` future monthly partitions
 * exist for a single table.
 *
 * Skips (returns `managed: false`) when the table does not exist or is not
 * a RANGE-partitioned table — this is the expected state for `audit_logs`
 * until it is migrated to partitioning.
 */
async function maintainTablePartitions(
  pool: Pool,
  table: CandidateTable,
  monthsAhead: number,
  now: Date,
  correlationId: string | undefined,
): Promise<TablePartitionResult> {
  const managed = await isRangePartitioned(pool, table);
  if (!managed) {
    logger.debug(`Partition maintenance: '${table}' is not range-partitioned, skipping`, correlationId, {
      event: 'partition_maintenance_table_not_managed',
      table,
    });
    return { table, managed: false, partitionsChecked: 0, partitionsCreated: [], behindSchedule: false };
  }

  const created: string[] = [];
  let behindSchedule = false;

  for (let i = 0; i <= monthsAhead; i++) {
    const rangeStart = monthStartUtc(now, i);
    const rangeEnd = monthStartUtc(now, i + 1);
    const partitionName = partitionNameFor(table, rangeStart);

    const exists = await partitionExists(pool, partitionName);
    if (exists) continue;

    if (i === 0) {
      // The current month's partition should already have been created by
      // an earlier run, while it was still `i` months in the future. Its
      // absence now means a prior scheduled run was missed or failed, and
      // inserts for TODAY may already be landing in the unindexed DEFAULT
      // partition. Alert loudly, then self-heal by creating it below.
      behindSchedule = true;
      partitionMaintenanceBehindScheduleTotal.inc({ table });
      logger.error('Partition maintenance fell behind schedule: current-month partition was missing', correlationId, {
        event: 'partition_maintenance_behind_schedule',
        table,
        partition: partitionName,
      });
    }

    await createPartition(pool, table, partitionName, rangeStart, rangeEnd);
    created.push(partitionName);
    partitionsCreatedTotal.inc({ table });
    logger.info('Partition maintenance: created partition', correlationId, {
      event: 'partition_maintenance_partition_created',
      table,
      partition: partitionName,
      rangeStart: rangeStart.toISOString(),
      rangeEnd: rangeEnd.toISOString(),
    });
  }

  return { table, managed: true, partitionsChecked: monthsAhead + 1, partitionsCreated: created, behindSchedule };
}

/**
 * Returns `true` when `table` currently resolves to a RANGE-partitioned
 * table (`relkind = 'p'`, `partstrat = 'r'`). Returns `false` (never throws)
 * when the table does not exist, is a plain table, or uses LIST/HASH
 * partitioning.
 */
async function isRangePartitioned(pool: Pool, table: string): Promise<boolean> {
  const res = await query<{ relkind: string; partstrat: string | null }>(
    pool,
    `SELECT c.relkind::text AS relkind, p.partstrat::text AS partstrat
       FROM pg_class c
       LEFT JOIN pg_partitioned_table p ON p.partrelid = c.oid
      WHERE c.oid = to_regclass($1)`,
    [table],
  );
  const row = res.rows[0];
  return !!row && row.relkind === 'p' && row.partstrat === 'r';
}

/** Returns `true` when a relation named `partitionName` already exists. */
async function partitionExists(pool: Pool, partitionName: string): Promise<boolean> {
  const res = await query<{ exists: boolean }>(
    pool,
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [partitionName],
  );
  return res.rows[0]?.exists === true;
}

/**
 * Create a monthly partition. Uses `IF NOT EXISTS` so a benign TOCTOU race
 * (another process creating the same partition between our existence check
 * and this call) is a silent no-op rather than an error.
 */
async function createPartition(
  pool: Pool,
  table: CandidateTable,
  partitionName: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<void> {
  const tableId = quoteIdentifier(table);
  const partitionId = quoteIdentifier(partitionName);
  const startLiteral = isoRangeBound(rangeStart);
  const endLiteral = isoRangeBound(rangeEnd);

  await query(
    pool,
    `CREATE TABLE IF NOT EXISTS ${partitionId} PARTITION OF ${tableId}
       FOR VALUES FROM ('${startLiteral}') TO ('${endLiteral}')`,
  );
}

/** Returns the first instant (UTC) of the month `offsetMonths` after `base`'s month. */
function monthStartUtc(base: Date, offsetMonths: number): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offsetMonths, 1, 0, 0, 0, 0));
}

/** Builds the deterministic partition name `<table>_y<YYYY>m<MM>` for a given month start. */
function partitionNameFor(table: CandidateTable, monthStart: Date): string {
  const year = monthStart.getUTCFullYear();
  const month = (monthStart.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${table}_y${year}m${month}`;
}

/**
 * Validate and format a `Date` as an ISO-8601 UTC literal for interpolation
 * into a `FOR VALUES FROM (...) TO (...)` DDL clause.
 *
 * DDL bound expressions cannot be passed as query parameters via the `pg`
 * driver's extended query protocol, so — unlike ordinary data queries in
 * this codebase — the literal must be interpolated directly. The strict
 * regex check is a defence-in-depth assertion: every caller constructs
 * `rangeStart`/`rangeEnd` exclusively via {@link monthStartUtc}, so this can
 * only fail if that invariant is broken by a future change.
 *
 * @throws {Error} If `date.toISOString()` does not match the expected shape.
 */
function isoRangeBound(date: Date): string {
  const iso = date.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) {
    throw new Error(`Internal error: unexpected ISO-8601 date format for partition bound: ${iso}`);
  }
  return iso;
}

/**
 * Safely quote a PostgreSQL identifier (table or partition name).
 *
 * Escapes double-quotes by doubling them per the SQL standard. Defence in
 * depth — identifiers passed here are always developer-controlled constants
 * or names derived deterministically from them, never user input.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
