/**
 * Retention purge job — enforces the data-retention policy defined in
 * `src/pii/policy.ts` against live PostgreSQL tables.
 *
 * @module jobs/retentionPurge
 *
 * ## What it does
 *
 * For every rule in `PURGEABLE_RETENTION_SCHEDULE` the job:
 *
 *  1. Calculates a cut-off timestamp:
 *       `NOW() - INTERVAL '<retentionDays> days'`
 *
 *  2. Queries the target table for candidate rows in bounded batches
 *     (default 500 rows per batch, configurable via `batchSize`).
 *
 *  3. For each candidate row:
 *     a. If the row has `legal_hold = TRUE` → emits a
 *        `PURGE_SKIPPED_LEGAL_HOLD` audit event and moves on.
 *     b. Otherwise → deletes (or redacts) the row inside a transaction
 *        and emits a `PURGE_INITIATED` audit event.
 *
 *  4. Repeats until no more candidates are found for the rule.
 *
 * ## Idempotency / crash-safety
 *
 * Each batch is committed in its own short transaction, so a crash
 * mid-run simply restarts from wherever the last successful commit left
 * off.  Re-running the job after a crash is safe — already-purged rows
 * are gone and will not be selected again.
 *
 * ## Legal-hold exemption
 *
 * Any row with `legal_hold = TRUE` is unconditionally skipped and an
 * audit trail is written.  The hold must be lifted by an operator
 * before the next job run for the row to become purgeable.
 *
 * ## Audit trail
 *
 * Every batch that purges ≥ 1 row emits `PURGE_INITIATED` with:
 *   - `rowsPurged`  — count of rows deleted/redacted in this batch
 *   - `cutoffDate`  — ISO-8601 cut-off used
 *   - `table`       — target table name
 *   - `batchIndex`  — 0-based batch counter for this rule
 *
 * Every row skipped due to legal hold emits `PURGE_SKIPPED_LEGAL_HOLD`
 * with the row's primary-key value in `resourceId` for traceability.
 *
 * ## Security assumptions
 *
 * - Table and column names in `PURGEABLE_RETENTION_SCHEDULE` are
 *   developer-controlled constants (not user input) and are safely
 *   interpolated into SQL with identifier quoting.
 * - The job runs with the application's DB principal, which must have
 *   `DELETE` on target tables.  It does NOT require super-user access.
 * - The `legal_hold` check is performed inside the same transaction as
 *   the delete, preventing a TOCTOU race where a hold is set between
 *   the check and the delete.
 */

import { logger } from '../lib/logger.js';
import { getPool } from '../db/pool.js';
import type { Pool, PoolClient } from 'pg';
import { recordAuditEventToDb } from '../lib/auditLog.js';
import { PURGEABLE_RETENTION_SCHEDULE, PurgeableRetentionRule } from '../pii/policy.js';

const STREAM_REDACTION_TOMBSTONE = '[REDACTED:DATA_RETENTION]';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum rows processed per transaction.
 * Kept small to bound lock duration and WAL volume per commit.
 * Configurable for testing via the options object.
 */
const DEFAULT_BATCH_SIZE = 500;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Configuration for a single purge run.
 */
export interface PurgeJobOptions {
  /**
   * Maximum rows to delete/redact per batch transaction.
   * Defaults to `DEFAULT_BATCH_SIZE` (500).
   */
  batchSize?: number;

  /**
   * Override the current time used for cut-off calculations.
   * Useful for deterministic testing.
   * Defaults to `new Date()`.
   */
  now?: Date;

  /**
   * Optional Postgres pool to use instead of the shared application pool.
   * Pass a mock/test pool in unit tests.
   */
  pool?: Pool;

  /**
   * Correlation ID to propagate into every audit log entry written during
   * this purge run.  Useful for tying job audit events to a scheduled-job
   * trace.
   */
  correlationId?: string;

  /**
   * If `true`, only count candidates and log what *would* be purged without
   * writing any deletes.  Useful for dry-run audits.
   * Defaults to `false`.
   */
  dryRun?: boolean;
}

/**
 * Per-rule summary returned by `runRetentionPurge`.
 */
export interface PurgeRuleResult {
  /** Human-readable category name from the retention schedule. */
  category: string;
  /** Table that was (or would have been) purged. */
  table: string;
  /** Number of rows deleted or redacted. Zero in dry-run mode. */
  rowsPurged: number;
  /** Number of rows skipped due to legal hold. */
  rowsSkipped: number;
  /** ISO-8601 cut-off timestamp used for this rule. */
  cutoffDate: string;
  /** Whether the run was a dry run. */
  dryRun: boolean;
}

/**
 * Aggregate result of a full purge run across all purgeable rules.
 */
export interface PurgeJobResult {
  /** ISO-8601 timestamp when the run started. */
  startedAt: string;
  /** ISO-8601 timestamp when the run finished. */
  finishedAt: string;
  /** Total rows purged across all rules. */
  totalRowsPurged: number;
  /** Total rows skipped (legal hold) across all rules. */
  totalRowsSkipped: number;
  /** Per-rule breakdown. */
  results: PurgeRuleResult[];
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Execute the retention purge job.
 *
 * Iterates every rule in `PURGEABLE_RETENTION_SCHEDULE` and removes rows
 * whose `ageColumn` pre-dates the rule's retention window, unless the row
 * carries a `legal_hold = TRUE` flag.
 *
 * @param options - Optional tuning / injection parameters.
 * @returns A summary of what was (or would have been) purged.
 *
 * @example
 * ```ts
 * // Invoked by a cron scheduler (e.g. node-cron, pg_cron trigger, etc.)
 * const result = await runRetentionPurge();
 * logger.info('Retention purge complete', undefined, result);
 * ```
 */
export async function runRetentionPurge(options: PurgeJobOptions = {}): Promise<PurgeJobResult> {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    now = new Date(),
    pool = getPool(),
    correlationId,
    dryRun = false,
  } = options;

  const startedAt = new Date().toISOString();
  const results: PurgeRuleResult[] = [];
  let totalRowsPurged = 0;
  let totalRowsSkipped = 0;

  logger.info('Retention purge job starting', correlationId, {
    rules: PURGEABLE_RETENTION_SCHEDULE.map((r) => r.category),
    dryRun,
    batchSize,
  });

  for (const rule of PURGEABLE_RETENTION_SCHEDULE) {
    const ruleResult = await purgeRule(rule, { batchSize, now, pool, correlationId, dryRun });
    results.push(ruleResult);
    totalRowsPurged += ruleResult.rowsPurged;
    totalRowsSkipped += ruleResult.rowsSkipped;
  }

  const finishedAt = new Date().toISOString();

  const summary: PurgeJobResult = {
    startedAt,
    finishedAt,
    totalRowsPurged,
    totalRowsSkipped,
    results,
  };

  logger.info('Retention purge job complete', correlationId, summary);
  return summary;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Run purge for a single retention rule.
 *
 * Processes rows in batches, committing each batch atomically.
 * Returns a per-rule summary.
 *
 * The column-existence check (does this table have a `legal_hold` column?)
 * is performed **once before the batch loop** via a standalone
 * `information_schema.columns` query.  The result is used to statically
 * branch the row-fetch SQL, avoiding a correlated subquery that would
 * otherwise re-check the catalog for every candidate row.
 */
async function purgeRule(
  rule: PurgeableRetentionRule,
  options: Required<Omit<PurgeJobOptions, 'now'>> & { now: Date }
): Promise<PurgeRuleResult> {
  const { batchSize, now, pool, correlationId, dryRun } = options;

  // retentionDays is always a number for purgeable rules (validated by type)
  const retentionDays = rule.retentionDays as number;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffDate = cutoff.toISOString();

  // ── Hoisted column-existence check ───────────────────────────────────────
  // Run ONCE per rule (not once per row or once per batch).
  const schemaClient = await pool.connect();
  let hasLegalHold: boolean;
  try {
    hasLegalHold = await tableHasColumn(schemaClient, rule.table, 'legal_hold');
  } finally {
    schemaClient.release();
  }

  let rowsPurged = 0;
  let rowsSkipped = 0;
  let batchIndex = 0;
  let hasMore = true;

  logger.info(`Retention purge: processing rule '${rule.category}'`, correlationId, {
    table: rule.table,
    ageColumn: rule.ageColumn,
    cutoffDate,
    dryRun,
    hasLegalHold,
  });

  while (hasMore) {
    const { purged, skipped } = await processBatch(rule, {
      cutoff,
      batchSize,
      batchIndex,
      pool,
      correlationId,
      dryRun,
      hasLegalHold,
    });

    rowsPurged += purged;
    rowsSkipped += skipped;
    batchIndex += 1;

    // If the batch was smaller than batchSize, we've exhausted candidates.
    hasMore = purged + skipped >= batchSize;
  }

  logger.info(`Retention purge: rule '${rule.category}' complete`, correlationId, {
    rowsPurged,
    rowsSkipped,
    batches: batchIndex,
    cutoffDate,
  });

  return {
    category: rule.category,
    table: rule.table,
    rowsPurged,
    rowsSkipped,
    cutoffDate,
    dryRun,
  };
}

/**
 * Process a single batch for a rule.
 *
 * The query is scoped by:
 *   `<ageColumn> < $1   -- older than the cut-off`
 *
 * The legal-hold check and the delete happen inside the SAME transaction so
 * there is no TOCTOU window where a hold is set between the check and the
 * delete.
 *
 * @returns `{ purged, skipped }` counts for the batch.
 */
async function processBatch(
  rule: PurgeableRetentionRule,
  options: {
    cutoff: Date;
    batchSize: number;
    batchIndex: number;
    pool: Pool;
    correlationId: string | undefined;
    dryRun: boolean;
    hasLegalHold: boolean;
  }
): Promise<{ purged: number; skipped: number }> {
  const { cutoff, batchSize, batchIndex, pool, correlationId, dryRun, hasLegalHold } = options;

  const client = await pool.connect();
  let purged = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');

    // Fetch candidates, locking the rows to prevent concurrent purge workers
    // from processing the same rows simultaneously.
    const candidates = await fetchCandidateRows(client, rule, cutoff, batchSize, hasLegalHold);

    if (candidates.length === 0) {
      await client.query('COMMIT');
      return { purged: 0, skipped: 0 };
    }

    for (const row of candidates) {
      const primaryKey = getPrimaryKey(row);

      if (row.legal_hold === true) {
        // Row is under legal hold — skip it and write an audit event.
        skipped += 1;
        await writeSkippedAuditEvent(client, rule, primaryKey, correlationId);
        logger.info('Retention purge: row skipped (legal hold)', correlationId, {
          table: rule.table,
          id: primaryKey,
        });
        continue;
      }

      if (!dryRun) {
        await purgeRow(client, rule, primaryKey);
      }

      purged += 1;
    }

    if (!dryRun && purged > 0) {
      // One PURGE_INITIATED event per batch (not per row) to keep the audit
      // log concise.  The meta includes the count for downstream analysis.
      await writePurgeAuditEvent(
        client,
        rule,
        purged,
        cutoff.toISOString(),
        batchIndex,
        correlationId
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Retention purge: batch failed, rolling back', correlationId, {
      table: rule.table,
      batchIndex,
      err: String(err),
    });
    throw err;
  } finally {
    client.release();
  }

  return { purged, skipped };
}

/**
 * Check whether a table has a specific column in `information_schema.columns`.
 *
 * This is hoisted out of the per-row query so the schema-catalog lookup
 * runs **at most once per rule** per purge run instead of once per
 * candidate row.
 */
async function tableHasColumn(
  client: PoolClient,
  table: string,
  column: string
): Promise<boolean> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [table, column]
  );
  return result.rows.length > 0;
}

/**
 * Fetch candidate rows from the target table.
 *
 * Uses `SELECT … FOR UPDATE SKIP LOCKED` so concurrent purge workers or
 * operators modifying legal_hold do not block each other.
 *
 * The SQL is **statically branched** based on `hasLegalHold` (determined
 * once per rule by {@link tableHasColumn}).  Tables that lack the column
 * use `FALSE AS legal_hold`; tables that have it reference the column
 * directly.  This avoids a per-row correlated subquery to
 * `information_schema.columns`.
 */
async function fetchCandidateRows(
  client: PoolClient,
  rule: PurgeableRetentionRule,
  cutoff: Date,
  batchSize: number,
  hasLegalHold: boolean
): Promise<Array<Record<string, unknown>>> {
  // Use a safe identifier quoting helper to prevent SQL-injection via
  // developer-controlled table/column names (defence-in-depth).
  const tableId = quoteIdentifier(rule.table);
  const ageColId = quoteIdentifier(rule.ageColumn);

  // Static branch: tables with the column reference it directly; tables
  // without it get a constant FALSE so the rest of the pipeline
  // (legal_hold check in processBatch) works uniformly.
  const legalHoldExpr = hasLegalHold ? 'legal_hold' : 'FALSE AS legal_hold';

  const result = await client.query<Record<string, unknown>>(
    `SELECT *, ${legalHoldExpr}
       FROM ${tableId}
      WHERE ${ageColId} < $1
      LIMIT $2
      FOR UPDATE SKIP LOCKED`,
    [cutoff.toISOString(), batchSize]
  );

  return result.rows;
}

/**
 * Delete or redact a single row identified by `id` (or `rowid` fallback).
 */
async function purgeRow(
  client: PoolClient,
  rule: PurgeableRetentionRule,
  primaryKey: string
): Promise<void> {
  const tableId = quoteIdentifier(rule.table);

  if (rule.purgeAction === 'delete') {
    await client.query(`DELETE FROM ${tableId} WHERE id = $1`, [primaryKey]);
  } else if (rule.table === 'streams') {
    // Redact stream PII columns while preserving the stream row for audit
    // and chain-derived consistency.
    await client.query(
      `UPDATE ${tableId}
          SET sender_address        = $1,
              recipient_address     = $1,
              sender_address_hash   = NULL,
              recipient_address_hash = NULL,
              updated_at            = NOW()
        WHERE id = $2`,
      [STREAM_REDACTION_TOMBSTONE, primaryKey]
    );
  } else {
    // Generic redact path for tables that retain the row shell for auditability.
    await client.query(
      `UPDATE ${tableId}
          SET meta = jsonb_build_object('purged', true),
              correlation_id = NULL
        WHERE id = $1`,
      [primaryKey]
    );
  }
}

/**
 * Writes a `PURGE_INITIATED` audit entry inside the active transaction.
 * Using the raw SQL path (same client) ensures the audit row is committed
 * or rolled back atomically with the deletes.
 */
async function writePurgeAuditEvent(
  client: PoolClient,
  rule: PurgeableRetentionRule,
  rowsPurged: number,
  cutoffDate: string,
  batchIndex: number,
  correlationId: string | undefined
): Promise<void> {
  const meta = {
    rowsPurged,
    cutoffDate,
    table: rule.table,
    batchIndex,
    purgeAction: rule.purgeAction,
  };

  await client.query(
    `INSERT INTO audit_logs
       (timestamp, action, resource_type, resource_id, correlation_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      new Date().toISOString(),
      'PURGE_INITIATED',
      rule.table,
      `batch-${batchIndex}`,
      correlationId ?? null,
      JSON.stringify(meta),
    ]
  );
}

/**
 * Writes a `PURGE_SKIPPED_LEGAL_HOLD` audit entry.
 * Intentionally NOT inside the main transaction — the skip audit event
 * should persist even if the batch transaction rolls back, so we use the
 * non-transactional `recordAuditEventToDb` path after the fact.
 *
 * We still accept the PoolClient to satisfy the function signature but
 * we log via the shared pool to ensure the entry is durable.
 */
async function writeSkippedAuditEvent(
  _client: PoolClient,
  rule: PurgeableRetentionRule,
  primaryKey: string,
  correlationId: string | undefined
): Promise<void> {
  // Fire-and-forget: legal-hold skips are best-effort audit records.
  // A failed write here must not abort the purge batch.
  try {
    await recordAuditEventToDb('PURGE_SKIPPED_LEGAL_HOLD', rule.table, primaryKey, correlationId, {
      table: rule.table,
      reason: 'legal_hold = TRUE',
    });
  } catch (err) {
    logger.error('Retention purge: failed to write legal-hold skip audit event', correlationId, {
      table: rule.table,
      id: primaryKey,
      err: String(err),
    });
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Extract the primary-key value from a candidate row.
 *
 * Tries `id` first (the overwhelming majority of tables), then `rowid`,
 * then falls back to a string representation for traceability.
 */
function getPrimaryKey(row: Record<string, unknown>): string {
  if (typeof row.id === 'string' || typeof row.id === 'number') {
    return String(row.id);
  }
  if (typeof row.rowid === 'string' || typeof row.rowid === 'number') {
    return String(row.rowid);
  }
  return JSON.stringify(row);
}

/**
 * Safely quote a PostgreSQL identifier (table name or column name).
 *
 * Escapes double-quotes by doubling them per the SQL standard.
 * This is a defence-in-depth measure — table/column names come from
 * developer-controlled constants, not user input.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
