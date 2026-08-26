/**
 * Post-replay ledger-sequence integrity check.
 *
 * After a manual reindex or replay triggered via `/api/admin/reindex` or
 * `POST /events/replay`, this module verifies that the resulting
 * `contract_events` rows form a contiguous, gap-free ledger sequence for the
 * replayed contract/range.
 *
 * ## What is checked
 *
 * 1. **Ledger gaps** — missing ledgers in the [min_ledger, max_ledger] range.
 *    Silently skipped ledgers (e.g. from a dropped RPC page mid-replay) are
 *    flagged here.
 * 2. **Duplicate event entries** — duplicate `event_id` values within the
 *    checked range. Although the INSERT uses `ON CONFLICT DO NOTHING`, a
 *    concurrent race or a corrupted batch boundary could theoretically produce
 *    duplicates; this check verifies the invariant holds.
 *
 * ## Efficiency
 *
 * Both checks are scoped to a single (contract_id, ledger-range) pair and use
 * indexed lookups — never a full-table scan.  The gap check uses
 * `generate_series` to materialise the expected ledger list without pulling
 * all rows.
 *
 * ## Failure mode
 *
 * The check NEVER throws.  On detection of gaps/duplicates it writes a
 * structured `audit_logs` entry and increments a Prometheus counter, then
 * returns.  If the underlying DB query fails (e.g. transient network error),
 * the error is logged and swallowed — the normal ingest path is never blocked.
 *
 * @module indexer/replayIntegrity
 */

import pg from 'pg';
import { logger } from '../lib/logger.js';
import { recordAuditEventToDb } from '../lib/auditLog.js';
import {
  indexerReplayIntegrityGapsTotal,
  indexerReplayIntegrityDuplicatesTotal,
} from '../metrics/indexerMetrics.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReplayIntegrityCheckResult {
  /** True when at least one gap or duplicate was detected. */
  hasIssues: boolean;
  /** Ledger numbers that are missing in the sequence (gaps). */
  gaps: number[];
  /** Duplicate event_id entries found within the range. */
  duplicates: { eventId: string; ledger: number; count: number }[];
  /** The actual ledger range that was scanned (MIN..MAX from DB). */
  checkedRange: { fromLedger: number; toLedger: number };
  /** Contract ID that was checked. */
  contractId: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/**
 * Hard cap on the number of ledgers checked by the integrity check.
 * Prevents OOM from `generate_series` on pathological ranges.
 */
export const MAX_INTEGRITY_RANGE = 100_000;

// ── Query constants ───────────────────────────────────────────────────────────

/**
 * Find missing ledgers in the [fromLedger, toLedger] range for a contract.
 *
 * Uses `generate_series` to build the expected ledger list without
 * materialising all rows, then LEFT JOINs with the distinct ledgers actually
 * present.  Rows where the actual ledger is NULL are gaps.
 */
const GAP_QUERY = `
  WITH expected AS (
    SELECT generate_series($1::int, $2::int) AS ledger
  ),
  actual AS (
    SELECT DISTINCT ledger
    FROM contract_events
    WHERE contract_id = $3
      AND ledger BETWEEN $1 AND $2
  )
  SELECT expected.ledger AS gap_ledger
  FROM expected
  LEFT JOIN actual ON actual.ledger = expected.ledger
  WHERE actual.ledger IS NULL
  ORDER BY expected.ledger
`;

/**
 * Find duplicate event_id values for a contract within a ledger range.
 *
 * Groups by (event_id, ledger) and returns any group whose count > 1.
 */
const DUPLICATE_QUERY = `
  SELECT event_id, ledger, COUNT(*)::int AS occurrence_count
  FROM contract_events
  WHERE contract_id = $1
    AND ledger BETWEEN $2 AND $3
  GROUP BY event_id, ledger
  HAVING COUNT(*) > 1
  ORDER BY ledger, event_id
`;

/**
 * Find the actual min/max ledger for a contract within a range.
 */
const RANGE_QUERY = `
  SELECT MIN(ledger)::int AS min_ledger, MAX(ledger)::int AS max_ledger
  FROM contract_events
  WHERE contract_id = $1
    AND ledger BETWEEN $2 AND $3
`;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a post-replay ledger-sequence integrity check.
 *
 * Spans are scoped to a single (contract_id, ledger-range) so the query uses
 * indexes on `contract_id` and `ledger` — never a full-table scan.
 *
 * When issues are found (gaps or duplicates):
 *   - A structured entry is written to the `audit_logs` table via
 *     `recordAuditEventToDb`.
 *   - Prometheus counters (`indexer_replay_integrity_gaps_total` and
 *     `indexer_replay_integrity_duplicates_total`) are incremented.
 *   - A structured warning is logged.
 *
 * The function NEVER throws. DB errors are caught, logged at warn level,
 * and a result with `hasIssues: false` and an `error` field is returned.
 *
 * @param pool       - pg.Pool for database access.
 * @param contractId - The contract that was replayed.
 * @param fromLedger - Lower bound of the replayed ledger range (inclusive).
 * @param toLedger   - Upper bound of the replayed ledger range (inclusive).
 * @returns Check result.  `result.error` is set when the query itself failed.
 */
export async function checkReplayIntegrity(
  pool: pg.Pool,
  contractId: string,
  fromLedger: number,
  toLedger: number,
): Promise<ReplayIntegrityCheckResult & { error?: string }> {
  // ── Sanity bounds ────────────────────────────────────────────────────────
  let effectiveFrom = Math.min(fromLedger, toLedger);
  let effectiveTo = Math.max(fromLedger, toLedger);

  // Guard against absurdly large ranges that would cause OOM or slow queries.
  // The generate_series range is capped to 100 000 ledgers.
  if (effectiveTo - effectiveFrom > MAX_INTEGRITY_RANGE) {
    // Clamp to a reasonable tail of the range so we still catch issues for
    // the most recent ledgers.
    effectiveFrom = effectiveTo - MAX_INTEGRITY_RANGE;
    logger.warn('replay_integrity_range_clamped', undefined, {
      event: 'replay_integrity_range_clamped',
      contractId,
      originalRange: { from: Math.min(fromLedger, toLedger), to: Math.max(fromLedger, toLedger) },
      clampedRange: { from: effectiveFrom, to: effectiveTo },
      reason: `Range exceeds ${MAX_INTEGRITY_RANGE} ledgers`,
    });
  }

  const client = await pool.connect();
  try {
    // ── Resolve actual ledger range ────────────────────────────────────────
    const rangeRes = await client.query<{
      min_ledger: number | null;
      max_ledger: number | null;
    }>(RANGE_QUERY, [contractId, effectiveFrom, effectiveTo]);

    const minLedger = rangeRes.rows[0]?.min_ledger ?? null;
    const maxLedger = rangeRes.rows[0]?.max_ledger ?? null;

    if (minLedger === null || maxLedger === null) {
      // No events in the range — nothing to check.
      return {
        hasIssues: false,
        gaps: [],
        duplicates: [],
        checkedRange: { fromLedger: effectiveFrom, toLedger: effectiveTo },
        contractId,
      };
    }

    // ── Gap detection ──────────────────────────────────────────────────────
    const gapRes = await client.query<{ gap_ledger: number }>(GAP_QUERY, [
      minLedger,
      maxLedger,
      contractId,
    ]);
    const gaps = gapRes.rows.map((r) => r.gap_ledger);

    // ── Duplicate event detection ─────────────────────────────────────────
    const dupRes = await client.query<{
      event_id: string;
      ledger: number;
      occurrence_count: number;
    }>(DUPLICATE_QUERY, [contractId, effectiveFrom, effectiveTo]);
    const duplicates = dupRes.rows.map((r) => ({
      eventId: r.event_id,
      ledger: r.ledger,
      count: r.occurrence_count,
    }));

    const hasIssues = gaps.length > 0 || duplicates.length > 0;

    if (hasIssues) {
      // ── Structured audit entry ──────────────────────────────────────────
      await recordAuditEventToDb(
        'REPLAY_INTEGRITY_ISSUE',
        'contract_events',
        contractId,
        undefined,
        {
          gapCount: gaps.length,
          duplicateCount: duplicates.length,
          ledgerRange: { from: minLedger, to: maxLedger },
          gaps: gaps.length > 0 ? gaps.slice(0, 100) : undefined, // limit to 100 entries
          duplicates:
            duplicates.length > 0
              ? duplicates.slice(0, 50).map((d) => ({
                  eventId: d.eventId,
                  ledger: d.ledger,
                }))
              : undefined,
        },
      ).catch((err) => {
        // Audit must never crash the check.
        logger.warn('replay_integrity_audit_failed', undefined, {
          event: 'replay_integrity_audit_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // ── Prometheus counters ─────────────────────────────────────────────
      if (gaps.length > 0) {
        indexerReplayIntegrityGapsTotal.inc({ contract_id: contractId.slice(0, 64) }, gaps.length);
      }
      if (duplicates.length > 0) {
        indexerReplayIntegrityDuplicatesTotal.inc(
          { contract_id: contractId.slice(0, 64) },
          duplicates.length,
        );
      }

      // ── Structured log ──────────────────────────────────────────────────
      logger.warn('replay_integrity_issues_detected', undefined, {
        event: 'replay_integrity_issues_detected',
        contractId,
        gapCount: gaps.length,
        duplicateCount: duplicates.length,
        ledgerRange: { from: minLedger, to: maxLedger },
        gaps: gaps.length <= 20 ? gaps : `${gaps.length} gaps (first 20: ${gaps.slice(0, 20).join(', ')})`,
        duplicates: duplicates.length <= 10 ? duplicates : `${duplicates.length} duplicates`,
      });
    }

    return {
      hasIssues,
      gaps,
      duplicates,
      checkedRange: { fromLedger: minLedger, toLedger: maxLedger },
      contractId,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('replay_integrity_query_failed', undefined, {
      event: 'replay_integrity_query_failed',
      contractId,
      ledgerRange: { from: effectiveFrom, to: effectiveTo },
      error: msg,
    });
    return {
      hasIssues: false,
      gaps: [],
      duplicates: [],
      checkedRange: { fromLedger: effectiveFrom, toLedger: effectiveTo },
      contractId,
      error: msg,
    };
  } finally {
    client.release();
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Internal query constants — exposed for test assertions. */
export const __QUERIES = {
  GAP_QUERY,
  DUPLICATE_QUERY,
  RANGE_QUERY,
  MAX_INTEGRITY_RANGE,
} as const;
