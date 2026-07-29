/**
 * DLQ retention purge job — enforces the dead-letter queue retention policy
 * against the `dead_letter_queue` table.
 *
 * @module jobs/dlqPurge
 *
 * ## What it does
 *
 * Deletes DLQ entries in terminal states older than a configurable retention
 * window (default 30 days).  Terminal states are:
 *
 *  1. `status = 'replayed'`   — explicitly resolved by an operator replay.
 *  2. `status = 'dead'` with `last_failed_at` older than the window —
 *     entries considered abandoned / permanently failed.
 *
 * Entries that are still pending (`status = 'dead'` with a recent
 * `last_failed_at`) are **never** touched.
 *
 * ## Batching & lock safety
 *
 * Each invocation processes at most `batchSize` rows (default 500) in a
 * single DELETE, keeping lock duration short on `dead_letter_queue`.  The
 * job is designed to be scheduled periodically (e.g. via pg-boss cron)
 * so that it churns through the backlog gradually without blocking writes.
 *
 * ## Idempotency / crash-safety
 *
 * Each invocation is a standalone DELETE.  A crash mid-run simply means
 * fewer rows were deleted; the next scheduled run picks up from wherever
 * the last successful DELETE left off.
 *
 * ## Audit trail
 *
 * Every purge invocation emits a `DLQ_RETENTION_PURGED` audit event with
 * the count of deleted rows, the cutoff date, and batch size.  If no rows
 * were deleted, no audit event is written to keep the log concise.
 *
 * ## Configuration
 *
 * - `DLQ_RETENTION_DAYS`   — retention window in days (default 30).
 *   Set to 0 to disable the purge job entirely.
 * - `DLQ_PURGE_BATCH_SIZE` — max rows per invocation (default 500).
 *
 * ## Security assumptions
 *
 * - The job runs with the application's DB principal, which must have
 *   `DELETE` on `dead_letter_queue`.
 * - Only terminal-state entries are targeted; the WHERE clause enforces
 *   this at the database level with no TOCTOU window.
 * - The cutoff date is computed from the configurable retention window
 *   and interpolated as a parameterized value — no SQL injection vector.
 */

import { logger } from '../lib/logger.js';
import { dlqRepository } from '../db/repositories/dlqRepository.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import { config } from '../config.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Fallback batch size when the env var is absent (belt-and-suspenders). */
const DEFAULT_BATCH_SIZE = 500;

/** Fallback retention days when the env var is absent (belt-and-suspenders). */
const DEFAULT_RETENTION_DAYS = 30;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Configuration for a single DLQ purge invocation.
 */
export interface DlqPurgeOptions {
  /**
   * Maximum rows to delete in this invocation.
   * Defaults to `DLQ_PURGE_BATCH_SIZE` env var (or 500).
   */
  batchSize?: number;

  /**
   * Retention window in days.  Entries in terminal state older than this
   * are eligible for deletion.
   * Defaults to `DLQ_RETENTION_DAYS` env var (or 30).
   */
  retentionDays?: number;

  /**
   * Override the current time used for cut-off calculation.
   * Useful for deterministic testing.
   * Defaults to `new Date()`.
   */
  now?: Date;

  /**
   * Correlation ID to propagate into the audit log entry.
   * Useful for tying job audit events to a scheduled-job trace.
   */
  correlationId?: string;
}

/**
 * Result returned by a single invocation of `runDlqPurge`.
 */
export interface DlqPurgeResult {
  /** ISO-8601 timestamp when the invocation started. */
  startedAt: string;
  /** ISO-8601 timestamp when the invocation finished. */
  finishedAt: string;
  /** Number of terminal-state entries deleted. */
  rowsPurged: number;
  /** ISO-8601 cut-off timestamp used for this invocation. */
  cutoffDate: string;
  /** Retention window in days that was applied. */
  retentionDays: number;
  /** Batch size that was used. */
  batchSize: number;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Execute a single DLQ retention purge invocation.
 *
 * Deletes terminal-state DLQ entries older than `retentionDays` in a single
 * bounded batch.  Designed to be called periodically by a scheduler.
 *
 * @param options - Optional tuning / injection parameters.
 * @returns A summary of what was purged.
 *
 * @example
 * ```ts
 * // Invoked by a cron scheduler through pg-boss
 * const result = await runDlqPurge({ correlationId: ctx.id });
 * logger.info('DLQ purge complete', result.correlationId, result);
 * ```
 */
export async function runDlqPurge(
  options: DlqPurgeOptions = {},
): Promise<DlqPurgeResult> {
  const {
    batchSize = config.dlq.purgeBatchSize || DEFAULT_BATCH_SIZE,
    retentionDays = config.dlq.retentionDays || DEFAULT_RETENTION_DAYS,
    now = new Date(),
    correlationId,
  } = options;

  const startedAt = new Date().toISOString();

  // ── Guard: retentionDays = 0 means purge is disabled ────────────────────
  if (retentionDays <= 0) {
    logger.info('DLQ retention purge skipped: retention disabled (retentionDays=0)', correlationId);
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      rowsPurged: 0,
      cutoffDate: now.toISOString(),
      retentionDays,
      batchSize,
    };
  }

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffDate = cutoff.toISOString();

  logger.info('DLQ retention purge starting', correlationId, {
    cutoffDate,
    retentionDays,
    batchSize,
  });

  // ── Execute purge ───────────────────────────────────────────────────────
  let rowsPurged: number;
  try {
    rowsPurged = await dlqRepository.purgeTerminalEntries(batchSize, cutoffDate);
  } catch (err) {
    logger.error('DLQ retention purge: repository call failed', correlationId, {
      cutoffDate,
      batchSize,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const finishedAt = new Date().toISOString();

  // ── Audit (only when rows were actually deleted) ────────────────────────
  if (rowsPurged > 0) {
    recordAuditEvent(
      'DLQ_RETENTION_PURGED',
      'dead_letter_queue',
      `batch-${cutoffDate}`,
      correlationId,
      {
        rowsPurged,
        cutoffDate,
        retentionDays,
        batchSize,
      },
    );
  }

  const summary: DlqPurgeResult = {
    startedAt,
    finishedAt,
    rowsPurged,
    cutoffDate,
    retentionDays,
    batchSize,
  };

  logger.info('DLQ retention purge complete', correlationId, summary);
  return summary;
}
