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
 *  2. For the current calendar month plus every month that begins within the
 *     configured **lead time** (see below), ensures a monthly partition named
 *     `<table>_y<YYYY>m<MM>` exists, creating it with
 *     `CREATE TABLE IF NOT EXISTS … PARTITION OF …` when missing.
 *  3. If the **current month's** partition is found missing, that means an
 *     earlier scheduled run failed to create it while it was still in the
 *     future — rows for *today* may already be landing in the unindexed
 *     `DEFAULT` partition. This is reported as "behind schedule" via a
 *     structured error log, an operator alert, and the
 *     `partitionMaintenanceBehindScheduleTotal` counter, in addition to being
 *     self-healed immediately.
 *
 * ## Lead time
 *
 * Partitions are created a documented interval **ahead of use**: the partition
 * covering month `M` is created during month `M - leadTimeMonths`, so it exists
 * for at least `leadTimeMonths` months (≈ 28 × `leadTimeMonths` days) before a
 * single row can require it. That buffer is what makes a failed or missed run
 * survivable: the next run self-heals long before the partition is *needed*,
 * rather than discovering the shortfall on the first insert of the month.
 *
 * The lead time is configurable, in whole calendar months, via (highest
 * precedence first):
 *
 *  1. the `leadTimeMonths` option passed to {@link runPartitionMaintenance};
 *  2. the deprecated `monthsAhead` option (same meaning, kept for callers
 *     written against the previous signature);
 *  3. the `PARTITION_MAINTENANCE_LEAD_TIME_MONTHS` environment variable, read
 *     through `config.partitionMaintenance.leadTimeMonths`;
 *  4. {@link DEFAULT_LEAD_TIME_MONTHS} (3 months).
 *
 * ## Alerting (failures are loud)
 *
 * Every failure that matters to an operator goes through
 * {@link raiseAlert} — not just a log line. That means each one produces a
 * structured `error` log record **and** an increment of
 * `fluxora_alerts_raised_total`, so metric-based alerting rules can page on it
 * even when no log shipping is configured:
 *
 *  - `partition_creation_failed` — a `CREATE TABLE … PARTITION OF` threw. The
 *    failure is re-thrown afterwards so the queue retries / dead-letters the
 *    run rather than pretending it succeeded.
 *  - `partition_maintenance_behind_schedule` — the current month's partition
 *    was missing (a previous run was missed or failed).
 *
 * ## Pre-write detection ({@link ensurePartitionCoverage})
 *
 * The job is the primary defence, but it is a *scheduled* defence: between two
 * runs, time can advance past the created partitions (a deploy that never
 * started the job, a long outage, a mis-set lead time). To make the shortfall
 * visible *before* it becomes an opaque write error, the same module exports
 * {@link ensurePartitionCoverage}, which the `contract_events` write path
 * calls immediately before issuing an insert: it probes whether the partitions
 * covering the batch's timestamps exist, raises `partition_shortfall_detected`
 * / `partition_creation_failed` alerts when they do not, and self-heals by
 * creating them — all in a single catalog round-trip in the happy path, and
 * strictly fail-open (an inconclusive probe leaves behaviour unchanged).
 *
 * ## Idempotency / concurrency safety
 *
 * The entire run is guarded by a single Postgres advisory lock
 * ({@link PARTITION_MAINTENANCE_LOCK_ID}), acquired with `pg_try_advisory_lock`
 * (non-blocking) **on a dedicated client session** checked out from the pool
 * via `pool.connect()`. All subsequent queries (partition checks, DDL) execute
 * on that same client, so the lock — which is session-scoped — remains held
 * for the full duration. If another instance already holds the lock, this run
 * is a no-op — it does **not** wait, retry, or error. This keeps multiple app
 * instances (or an overlapping cron + manual invocation) from racing to
 * `CREATE TABLE` the same partition concurrently.
 *
 * A configurable `lockTimeoutMs` (default 30 000 ms) is set via
 * `SET LOCAL statement_timeout` immediately after acquiring the lock, so a
 * hung maintenance run cannot hold the advisory lock indefinitely and starve
 * subsequent schedulers.
 *
 * Partition creation itself is additionally idempotent at the SQL level via
 * `CREATE TABLE IF NOT EXISTS`, so even a partition that appears between our
 * existence check and the DDL call (e.g. created manually by an operator)
 * cannot cause an error.
 *
 * Re-running this job when every partition already exists is a safe no-op:
 * no DDL is executed, no rows are touched, and the result simply reports
 * zero created partitions. There is no checkpoint table: like
 * `src/jobs/retentionPurge.ts` (the other destructive/structural
 * retention-adjacent job — see its module docs for the shared idempotency
 * contract), current state is always re-derived from `to_regclass()` /
 * `pg_partitioned_table`, so a crash mid-run and a run that happens to
 * straddle a calendar-month boundary both converge on the next run without
 * double-creating a partition or double-incrementing
 * `partitionsCreatedTotal`.
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

import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { logger } from '../lib/logger.js';
import { raiseAlert } from '../lib/alerts.js';
import { config } from '../config.js';
import {
  partitionsCreatedTotal,
  partitionMaintenanceBehindScheduleTotal,
  partitionMaintenanceFailuresTotal,
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

/**
 * Default partition lead time, in whole calendar months.
 *
 * The job ensures a partition exists for the current month plus every month
 * starting within this lead time, so the partition covering month `M` is
 * created about `DEFAULT_LEAD_TIME_MONTHS` months before `M` begins. Three
 * months absorbs a long run of failed or missed daily runs without ever
 * letting a write reach a month with no partition to hold it.
 */
export const DEFAULT_LEAD_TIME_MONTHS = 3;

/**
 * @deprecated Use {@link DEFAULT_LEAD_TIME_MONTHS}. Retained as an alias so
 * callers written against the pre-lead-time API keep compiling.
 */
export const DEFAULT_MONTHS_AHEAD = DEFAULT_LEAD_TIME_MONTHS;

/**
 * Default maximum duration (ms) for the entire lock-guarded maintenance
 * section. If the job exceeds this limit, `statement_timeout` will cancel
 * the active query, the `finally` block releases the lock, and the next
 * scheduled run can retry. Prevents a hung DDL from starving all future
 * maintenance runs.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Options accepted by {@link runPartitionMaintenance}.
 */
export interface PartitionMaintenanceOptions {
  /**
   * Lead time, in whole calendar months: partitions are ensured for the
   * current month plus every month that starts within this many months.
   * Defaults to `config.partitionMaintenance.leadTimeMonths`, which itself
   * defaults to {@link DEFAULT_LEAD_TIME_MONTHS}.
   */
  leadTimeMonths?: number;
  /**
   * @deprecated Renamed to {@link PartitionMaintenanceOptions.leadTimeMonths};
   * still honoured (with the same meaning) when `leadTimeMonths` is omitted.
   */
  monthsAhead?: number;
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
  /** Correlation id threaded into every log line emitted by this run. */
  correlationId?: string;
  /**
   * Maximum duration (ms) for the lock-guarded maintenance section.
   * A `statement_timeout` is applied to the dedicated client immediately
   * after acquiring the advisory lock. Defaults to {@link DEFAULT_LOCK_TIMEOUT_MS}.
   */
  lockTimeoutMs?: number;
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
  /** Lead time (in whole calendar months) this run was executed with. */
  leadTimeMonths: number;
  /** ISO-8601 timestamp when the run started. */
  startedAt: string;
  /** ISO-8601 timestamp when the run finished. */
  finishedAt: string;
  /** Per-table breakdown. Empty when `lockAcquired` is `false`. */
  tables: TablePartitionResult[];
}

// ── Internal query helper ─────────────────────────────────────────────────────

/**
 * Thin wrapper around `client.query()` so that all SQL in this module flows
 * through a single call-site. This keeps the mock surface in tests identical
 * to what the production path exercises and makes call-recording trivial.
 */
async function clientQuery<T extends QueryResultRow = QueryResultRow>(
  client: PartitionQueryable,
  sql: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return (await client.query(sql, params)) as { rows: T[]; rowCount?: number | null };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute the partition maintenance job.
 *
 * Checks out a **dedicated client** from the pool, acquires a non-blocking
 * Postgres advisory lock on that session, then ensures the current month
 * plus `monthsAhead` future monthly partitions exist for every
 * range-partitioned table in {@link CANDIDATE_TABLES}. All queries run on
 * the same client session, so the session-scoped advisory lock is held
 * throughout.
 *
 * @param pool - PostgreSQL pool (or a mock exposing a compatible `connect`) to run against.
 * @param options - Tuning / injection parameters, or (for backward compatibility)
 *                  a bare lead-time number of months.
 * @returns A summary of what was (or would have needed to be) created.
 * @throws {Error} If the lead time is not a non-negative integer.
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
      ? { leadTimeMonths: optionsOrMonthsAhead }
      : optionsOrMonthsAhead;

  const leadTimeMonths = resolveLeadTimeMonths(options);
  const correlationId = options.correlationId;
  const now = options.now ?? new Date();
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const startedAt = new Date().toISOString();

  if (!Number.isInteger(leadTimeMonths) || leadTimeMonths < 0) {
    throw new Error(
      `runPartitionMaintenance: leadTimeMonths must be a non-negative integer, got ${leadTimeMonths}`,
    );
  }

  // ── Check out a dedicated client so the advisory lock stays held ─────────
  //
  // `pg_try_advisory_lock` is session-scoped: it is bound to the underlying
  // connection, not to a transaction. Using `pool.query()` (which borrows
  // then immediately returns a connection) would lose the lock before any
  // DDL ran. By reserving a single client for the entire guarded section,
  // the lock is released only when we explicitly call `pg_advisory_unlock`
  // (or when the session terminates abnormally).
  const client = await pool.connect();

  try {
    const lockRes = await clientQuery<{ pg_try_advisory_lock: boolean }>(
      client,
      'SELECT pg_try_advisory_lock($1)',
      [PARTITION_MAINTENANCE_LOCK_ID],
    );

    if (lockRes.rows[0]?.pg_try_advisory_lock !== true) {
      logger.info('Partition maintenance: another instance holds the lock, skipping this run', correlationId, {
        event: 'partition_maintenance_skipped_lock_held',
      });
      // Release the client immediately — we never held the lock.
      client.release();
      return {
        lockAcquired: false,
        leadTimeMonths,
        startedAt,
        finishedAt: new Date().toISOString(),
        tables: [],
      };
    }

    // Apply a statement_timeout for the maintenance section so a hung DDL
    // cannot hold the advisory lock indefinitely. SET LOCAL scopes to the
    // current transaction; since we are not inside an explicit transaction,
    // use plain SET so it sticks for the remainder of this session checkout.
    await clientQuery(client, `SET statement_timeout = ${Number(lockTimeoutMs)}`);

    const tables: TablePartitionResult[] = [];
    try {
      for (const table of CANDIDATE_TABLES) {
        tables.push(await maintainTablePartitions(client, table, leadTimeMonths, now, correlationId));
      }
    } finally {
      // Always release the lock, even if a table's maintenance throws, so a
      // single failure never wedges the job for every future run.
      await clientQuery(client, 'SELECT pg_advisory_unlock($1)', [PARTITION_MAINTENANCE_LOCK_ID]);
    }

    const finishedAt = new Date().toISOString();
    logger.info('Partition maintenance run complete', correlationId, {
      event: 'partition_maintenance_complete',
      leadTimeMonths,
      tables: tables.map((t) => ({
        table: t.table,
        managed: t.managed,
        created: t.partitionsCreated,
        behindSchedule: t.behindSchedule,
      })),
    });

    return { lockAcquired: true, leadTimeMonths, startedAt, finishedAt, tables };
  } finally {
    // Unconditionally return the client to the pool. This is separate from
    // lock release: even if the unlock call above threw, the connection must
    // go back to the pool (or be destroyed) so we do not leak it.
    client.release();
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Ensure the current month plus every month starting within the lead time has
 * a partition, for a single table.
 *
 * Skips (returns `managed: false`) when the table does not exist or is not
 * a RANGE-partitioned table — this is the expected state for `audit_logs`
 * until it is migrated to partitioning.
 */
async function maintainTablePartitions(
  client: PoolClient,
  table: CandidateTable,
  leadTimeMonths: number,
  now: Date,
  correlationId: string | undefined,
): Promise<TablePartitionResult> {
  const managed = await isRangePartitioned(client, table);
  if (!managed) {
    logger.debug(`Partition maintenance: '${table}' is not range-partitioned, skipping`, correlationId, {
      event: 'partition_maintenance_table_not_managed',
      table,
    });
    return { table, managed: false, partitionsChecked: 0, partitionsCreated: [], behindSchedule: false };
  }

  const created: string[] = [];
  let behindSchedule = false;

  for (let i = 0; i <= leadTimeMonths; i++) {
    const rangeStart = monthStartUtc(now, i);
    const rangeEnd = monthStartUtc(now, i + 1);
    const partitionName = partitionNameFor(table, rangeStart);

    const exists = await partitionExists(client, partitionName);
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
      // Escalate to an operator alert as well: a log line nobody is watching
      // is exactly the failure mode this job must not have.
      raiseAlert({
        name: 'partition_maintenance_behind_schedule',
        severity: 'critical',
        message: `Partition maintenance fell behind schedule for '${table}': current-month partition '${partitionName}' was missing`,
        correlationId,
        context: { table, partition: partitionName },
      });
    }

    try {
      await createPartition(client, table, partitionName, rangeStart, rangeEnd);
    } catch (err) {
      // A failure to create a partition is never just a log line: alert, then
      // re-throw so the queue retries (and eventually dead-letters) the run.
      alertPartitionCreationFailure(table, partitionName, correlationId, err);
      throw err;
    }

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

  return {
    table,
    managed: true,
    partitionsChecked: leadTimeMonths + 1,
    partitionsCreated: created,
    behindSchedule,
  };
}

/**
 * Resolve the lead time for a run, in whole calendar months.
 *
 * Precedence: explicit `leadTimeMonths` → deprecated `monthsAhead` →
 * `PARTITION_MAINTENANCE_LEAD_TIME_MONTHS` (via `config`) →
 * {@link DEFAULT_LEAD_TIME_MONTHS}. A non-integer or negative configured value
 * is ignored in favour of the built-in default rather than being propagated,
 * so a typo in a deployment's environment cannot silently disable
 * pre-creation.
 */
function resolveLeadTimeMonths(options: PartitionMaintenanceOptions): number {
  const explicit = options.leadTimeMonths ?? options.monthsAhead;
  if (explicit !== undefined) return explicit;

  const configured = config.partitionMaintenance?.leadTimeMonths;
  return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_LEAD_TIME_MONTHS;
}

/**
 * Raise the standard alert (and metric) for a failed `CREATE TABLE …
 * PARTITION OF`. Shared by the scheduled job and the pre-write coverage guard
 * so both paths report the same alert name.
 */
function alertPartitionCreationFailure(
  table: string,
  partitionName: string,
  correlationId: string | undefined,
  err: unknown,
): void {
  partitionMaintenanceFailuresTotal.inc({ table: table as CandidateTable });
  raiseAlert({
    name: 'partition_creation_failed',
    severity: 'critical',
    message: `Failed to create partition '${partitionName}' for table '${table}'`,
    correlationId,
    context: {
      table,
      partition: partitionName,
      error: err instanceof Error ? err.message : String(err),
    },
  });
}

// ── Pre-write coverage guard ──────────────────────────────────────────────────

/**
 * Minimal query surface required by {@link ensurePartitionCoverage} and by the
 * internal helpers shared with the job.
 *
 * Deliberately non-generic (and `unknown`-typed rows) so that every query
 * surface in this codebase is assignable to it without a cast: `pg.PoolClient`
 * and `pg.Pool` from the driver, `PgClientLike` from `src/indexer/store.ts`, and
 * the mock clients used in tests. Rows are narrowed at each call site instead.
 */
export interface PartitionQueryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/** One row of the coverage probe: whether the parent is managed and whether one required partition exists. */
interface CoverageProbeRow {
  /** `true` when the parent table is RANGE-partitioned (and therefore managed by this module). */
  managed: boolean | null;
  /** Partition name the row refers to. */
  partition: string;
  /** Whether that partition currently exists. */
  partition_exists: boolean | null;
}

/** Outcome of a {@link ensurePartitionCoverage} probe. */
export interface PartitionCoverageResult {
  /** Table that was probed. */
  table: string;
  /**
   * `true` only when the probe conclusively established that the table is
   * RANGE-partitioned. `false` means "unmanaged or inconclusive" — the caller
   * must not treat it as "partitions are missing".
   */
  managed: boolean;
  /** Partition names required to cover the supplied timestamps. */
  required: string[];
  /** Required partitions that already existed at probe time. */
  present: string[];
  /** Required partitions that were missing at probe time and were created by this call. */
  healed: string[];
  /** Required partitions that were missing at probe time. */
  missing: string[];
  /** Required partitions that are *still* missing after the heal attempt. */
  failed: string[];
}

/**
 * Single-round-trip probe that reports, for one parent table, whether it is
 * RANGE-partitioned and which of the candidate partitions exist.
 *
 * Both facts come from one statement on purpose: the guard runs immediately
 * before a write, so it must not double the number of round-trips on the hot
 * ingest path. A zero-row result means "no such parent table" and is treated
 * as inconclusive.
 */
const COVERAGE_PROBE_SQL = `
  WITH parent AS (
    SELECT (c.relkind = 'p' AND p.partstrat = 'r') AS managed
      FROM pg_class c
      LEFT JOIN pg_partitioned_table p ON p.partrelid = c.oid
     WHERE c.oid = to_regclass($1)
  )
  SELECT parent.managed AS managed,
         n AS partition,
         to_regclass(n) IS NOT NULL AS partition_exists
    FROM parent
    CROSS JOIN unnest($2::text[]) AS n
`;

/**
 * Detect — before a write is attempted — whether the partitions covering the
 * supplied timestamps exist, and create the missing ones.
 *
 * This is the write-path half of the contract this module implements: the
 * scheduled job keeps partitions `DEFAULT_LEAD_TIME_MONTHS` ahead of use, and
 * this guard makes the residual case (time advanced past the created
 * partitions while the job was not running) visible as
 * `partition_shortfall_detected` instead of as an opaque
 * `no partition of relation "contract_events" found for row` insert failure.
 *
 * Behaviour:
 *
 *  - One catalog query per call, covering every distinct month in
 *    `timestamps`; no per-row work.
 *  - Timestamps that cannot be parsed, and duplicates within a month, are
 *    ignored.
 *  - When the parent is not RANGE-partitioned (or the probe is inconclusive),
 *    nothing happens and no alert is raised.
 *  - When a required partition is missing: raises `partition_shortfall_detected`
 *    (critical) and, unless `heal` is `false`, creates it — so the write that
 *    follows cannot fail for a reason we already detected. A failing create
 *    raises `partition_creation_failed` (critical) and is reported in
 *    {@link PartitionCoverageResult.failed}.
 *
 * **Never throws.** Observability and self-healing must not be able to turn a
 * writable batch into a failed one: probe errors, malformed rows and DDL
 * failures all degrade to "inconclusive" / `failed` results.
 *
 * @param client - Query surface (store client, pool client or pool).
 * @param table - Parent table name; quoted before use in DDL.
 * @param timestamps - ISO-8601 strings or `Date`s that will be written.
 * @param options - `heal: false` detects without creating; `correlationId` is
 *                  threaded into logs/alerts.
 * @returns What was required, present, missing, healed and still failing.
 */
export async function ensurePartitionCoverage(
  client: PartitionQueryable,
  table: string,
  timestamps: readonly (string | Date)[],
  options: { heal?: boolean; correlationId?: string } = {},
): Promise<PartitionCoverageResult> {
  const months = monthsCoveringTimestamps(timestamps);
  const required = months.map((monthStart) => partitionNameFor(table, monthStart));
  const monthStartByName = new Map<string, Date>(
    required.map((name, index) => [name, months[index] as Date]),
  );

  const inconclusive: PartitionCoverageResult = {
    table,
    managed: false,
    required,
    present: [],
    healed: [],
    missing: [],
    failed: [],
  };

  if (required.length === 0) return inconclusive;

  let rows: CoverageProbeRow[];
  try {
    const res = await client.query(COVERAGE_PROBE_SQL, [table, required]);
    rows = Array.isArray(res?.rows) ? (res.rows as CoverageProbeRow[]) : [];
  } catch (err) {
    // Fail open: the write path keeps its previous behaviour (the insert will
    // surface the problem if there really is one).
    logger.error('Partition coverage probe failed; continuing without pre-write check', options.correlationId, {
      event: 'partition_coverage_probe_failed',
      table,
      error: err instanceof Error ? err.message : String(err),
    });
    return inconclusive;
  }

  const existsByName = new Map<string, boolean>();
  for (const row of rows) {
    if (row?.managed === true && typeof row.partition === 'string') {
      existsByName.set(row.partition, row.partition_exists === true);
    }
  }

  // No row conclusively reported a range-partitioned parent: either this table
  // is not partitioned (audit_logs today, or a pre-partitioning deployment) or
  // the response was not shaped as expected. Either way, do nothing.
  if (existsByName.size === 0) return inconclusive;

  const present = required.filter((name) => existsByName.get(name) === true);
  const missing = required.filter((name) => existsByName.get(name) === false);

  if (missing.length === 0) {
    return { table, managed: true, required, present, healed: [], missing, failed: [] };
  }

  raiseAlert({
    name: 'partition_shortfall_detected',
    severity: 'critical',
    message: `Partition coverage shortfall for '${table}': ${missing.join(', ')} missing before write`,
    correlationId: options.correlationId,
    context: { table, partitions: missing },
  });

  if (options.heal === false) {
    return { table, managed: true, required, present, healed: [], missing, failed: [...missing] };
  }

  const healed: string[] = [];
  const failed: string[] = [];
  for (const partitionName of missing) {
    const rangeStart = monthStartByName.get(partitionName) as Date;
    try {
      await createPartition(client, table, partitionName, rangeStart, monthStartUtc(rangeStart, 1));
      healed.push(partitionName);
      partitionsCreatedTotal.inc({ table: table as CandidateTable });
      logger.warn('Partition maintenance: created missing partition before write', options.correlationId, {
        event: 'partition_created_before_write',
        table,
        partition: partitionName,
      });
    } catch (err) {
      failed.push(partitionName);
      alertPartitionCreationFailure(table, partitionName, options.correlationId, err);
    }
  }

  return { table, managed: true, required, present, healed, missing, failed };
}

/**
 * Distinct UTC month starts covering `timestamps`, ascending. Unparseable
 * timestamps and duplicates within a month are dropped.
 */
function monthsCoveringTimestamps(timestamps: readonly (string | Date)[]): Date[] {
  const byMonth = new Map<number, Date>();
  for (const value of timestamps) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    const monthStart = monthStartUtc(date, 0);
    byMonth.set(monthStart.getTime(), monthStart);
  }
  return [...byMonth.values()].sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Returns `true` when `table` currently resolves to a RANGE-partitioned
 * table (`relkind = 'p'`, `partstrat = 'r'`). Returns `false` (never throws)
 * when the table does not exist, is a plain table, or uses LIST/HASH
 * partitioning.
 */
async function isRangePartitioned(client: PoolClient, table: string): Promise<boolean> {
  const res = await clientQuery<{ relkind: string; partstrat: string | null }>(
    client,
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
async function partitionExists(client: PoolClient, partitionName: string): Promise<boolean> {
  const res = await clientQuery<{ exists: boolean }>(
    client,
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
  client: PartitionQueryable,
  table: string,
  partitionName: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<void> {
  const tableId = quoteIdentifier(table);
  const partitionId = quoteIdentifier(partitionName);
  const startLiteral = isoRangeBound(rangeStart);
  const endLiteral = isoRangeBound(rangeEnd);

  await clientQuery(
    client,
    `CREATE TABLE IF NOT EXISTS ${partitionId} PARTITION OF ${tableId}
       FOR VALUES FROM ('${startLiteral}') TO ('${endLiteral}')`,
  );
}

/** Returns the first instant (UTC) of the month `offsetMonths` after `base`'s month. */
function monthStartUtc(base: Date, offsetMonths: number): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offsetMonths, 1, 0, 0, 0, 0));
}

/** Builds the deterministic partition name `<table>_y<YYYY>m<MM>` for a given month start. */
function partitionNameFor(table: string, monthStart: Date): string {
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
