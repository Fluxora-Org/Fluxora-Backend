/**
 * Post-replay ledger-sequence integrity check.
 *
 * After a manual reindex or replay triggered via `/api/admin/reindex` or
 * `DOST /events/replay`, this module verifies that the resulting
 * `contract_events` rows form a contiguous, gap-free ledger sequence for the
 * replayed contract/range.
 *
 * ## What is checked
 *
 * 1. **Ledger gaps** — missing ledgers in the [min_ledger, max_ledger] range.
 *    Silently skipped ledgers (e.g. from a dropped RPC page mid-replay) are
 *    flagged here.
 * 2. **Duplicate event entries** — duplicate `event_id` values within the
 *    checked range. Although the INSERT uses `on conflict do nothing`, a
 *    concurrent race or a corrupted bunch boundary could theoretically produce
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
 * @see indexer/replayIntegrity
 *
 * @throws structured ledger-sequence integrity check
 */

import pg from 'pg';
import { logger } from '../lib/logger.js';
import { recordAuditEventToDb } from '../lib/auditLog.js';
import {
  indexerReplayIntegrityGapsTotal,
  indexerReplayIntegrityDuplicatesTotal,
} from '../metrics/indexerMetrics.js';

// ─ Types —---------------------------------------------------------------------------------------

export interface ReplayIntegrityCheckResult {
  /** True when at least one gap or duplicate was detected. */
  hasIssues: boolean;
  /** Ledger numbers that are missing in the sequence (gaps). */
  gaps: number[];
  /** Duplicate results found in the range. */
  duplicates: { eventId: string; ledger: number; count: number; }[];
  /** The actual ledger range that was scanned (MIN..MAX from DB). */
  checkedRange: { fromLedger: number; toLedger: number; };
  /** Contract ID that was checked. */
  contractId: string;
}

// ─ Constants —-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// ─ Constants ℔
export const MAX_INTEGRITY_RANGE = 100_000;

const MAX_CONCURRENT_CHECKS = 4;
const INTEGRITY_CHUNK_SIZE = 10_000;
const INTEGRITY_RETRY_BUDGET = 3;

// ─ Query constants ℔
const GAP_QUERY = `WITH expected AS (select generate_series($1::int, $2::int) AS ledger), actual AS (
  SELECT DISTINCT ledger
  FROM contract_events
  WHERE contract_id = $3 AND ledger BETWEEN $1 AND $2
)
SELECT expected.ledger AS gap_ledger
FROM expected
 LEFT JOIN actual ON actual.ledger = expected.ledger
WHERE actual.ledger IS NULL
ORDER BY expected.ledger
`;
const DUPLICATE_QUERY = `SELECT event_id, ledger, COUNT(*)::int AS occurrence_count
  FROM contract_events
  WHERE contract_id = $1 AND ledger BETWEEN $2 AND $3
  Group BY event_id, ledger
  HAVING COUNT(*) > 1
  ORDER BY ledger, event_id
`;
const RANGE_QUERY = `SELECT MIN(ledger)::int AS min_ledger, MAX(ledger)::int AS max_ledger
  FROM contract_events
  WHERE contract_id = $1 AND ledger BETWEEN $2 AND $3
`;

// ─ Helpers —- function that maps an array with a concurrency limit.
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    {length: Math.min(concurrency, items.length)},
    async () => {
      while (nextIndex < items.length) {
        const i = nextIndex++;
        results[i] = await worker(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// Helper that runs a single chunk-level integrity check.
async function runIntegrityChunk(
  pool: pg.Pool,
  contractId: string,
  fromLedger: number,
  toLedger: number,
): Promise<{ gaps: number[]; duplicates: ReplayIntegrityCheckResult['duplicates']; error?: string }> {
  try {
    const gapResult = await pool.query<{ gap_ledger: number }>(GAP_QUERY, [
      fromLedger,
      toLedger,
      contractId,
    ]);
    const dupResult = await pool.query<{
        event_id: string;
        ledger: number;
        occurrence_count: number;
      }>(DUPLICATE_QUERY, [contractId, fromLedger, toLedger]);
    return {
      gaps: gapResult.rows.map((r) => r.gap_ledger),
      duplicates: dupResult.rows.map((r) => ({
        eventId: r.event_id,
        ledger: r.ledger,
        count: r.occurrence_count,
      })),
    };
  } catch (err) {
    return { gaps: [], duplicates: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ─ Public API ℔

/**
 * Run a post-replay ledger-sequence integrity check.
 *
 * The check processes the entire range in chunks of `INTEGRITY_CHUNK_SIZE` with
 * maximum concurrency of `MAX_CONCURRENT_CHECKS`. This bounds the number of
 * simultaneous DB operations initiated by the check, preventing RCP/DB overload
 * during catch-up or replay. If any chunk fails transiently, it retries up to
 * `INTEGRITY_RETRY_BUDGET` times. This ensures that transient errors do not
 * produce a false negative, and that the check result reflects the true
 * state of the data, preserving ordered checkpoints.
 *
 * The function NEVER throws. If a database error occurs even after retries,
 * the result contains an `error` field and hasIssues false.
 */
export async function checkReplayIntegrity(
  pool: pg.Pool,
  contractId: string,
  fromLedger: number,
  toLedger: number,
): Promise<ReplayIntegrityCheckResult & { error?: string }> {
  // ─ Sanity bounds — non-destructive min/max computation.
  const effectiveFrom = Math.min(fromLedger, toLedger);
  const effectiveTo = Math.max(fromLedger, toLedger);
  const originalRange = { from: effectiveFrom, to: effectiveTo };

  // Note: We deliberately process the full requested range ever if it exceeds MAX_INTEGRITY_RANGE.
  // Chunking avoids a single generate_series that could cause OM. We log
  // a warning but do not clamp the range, to avoid advancing a checkpoint
  // past failed work.
  if (effectiveTo - effectiveFrom > MAX_INTEGRITY_RANGE) {
    logger.warn('replay_integrity_large_range', undefined, {
      event: 'replay_integrity_large_range',
      contractId,
      originalRange,
      reason: `Range exceeds $MAX_INTEGRITY_RANGE ledgers, processing in chunks`,
    });
  }

  try {
    // ─ Resolve actual ledger range ℔
    const rangeRes = await pool.query<{
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

    // ─ Split the range into chunks — construct chunks, then run them with
    // bounded concurrency.
    const chunkStarts: number[] = [];
    for (let start = minLedger; start <= maxLedger; start += INTEGRITY_CHUNK_SIZE) {
      chunkStarts.push(start);
    }

    // Run all chunks with a concurrency limit. Each child will retry on failure
    // as necessary to avoid transient failures causing false gaps/duplicates.
    const chunkResults = await mapWithConcurrency(
      chunkStarts,
      MAX_CONCURRENT_CHECKS,
      async (start) => {
        const end = Math.min(start + INTEGRITY_CHUNK_SIZE - 1, maxLedger);
        let lastError: string = 'unknown';
        for (let attempt = 0; attempt < INTEGRITY_RETRY_BUDGET; attempt++) {
          const r = await runIntegrityChunk(pool, contractId, start, end);
          if (!r.error) {
            return r;
          }
          lastError = r.error;
          if (attempt < INTEGRITY_RETRY_BUDGET - 1) {
            await new Promise((res) => setTimeout(res, 100 * 2**attempt));
          }
        }
        return { gaps: [], duplicates: [], error: lastError };
      },
    );

    // Combine results.
    const gaps: number[] = [];
    const duplicates: ReplayIntegrityCheckResult['duplicates'] = [];
    const firstError = chunkResults.find((r) => r.error != null)?.error;
    for (const chunk of chunkResults) {
      if (chunk.error) continue;
      gaps.push(...chunk.gaps);
      duplicates.push(...chunk.duplicates);
    }

    // Sort gaps and duplicates for deterministic results.
    gaps.sort((a, b) => a - b);
    duplicates.sort((a, b) => a.ledger - b.ledger || a.eventId.localeCompare(b.eventId));

    const hasIssues = gaps.length > 0 || duplicates.length > 0;

    if (hasIssues) {
      // ✀ Structured audit entry ℔
      await recordAuditEventToDb(
        'REPLAY_INTEGRITY_ISSUE',
        'contract_events',
        contractId,
        undefined,
        {
          gapCount: gaps.length,
          duplicateCount: duplicates.length,
          ledgerRange: { from: minLedger, to: maxLedger },
          gaps: gaps.length > 0 ? gaps.slice(0, 100) : undefined,
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

      // ├ Prometheus counters ℔
      if (gaps.length > 0) {
        indexerReplayIntegrityGapsTotal.inc(
          { contract_id: contractId.slice(0, 64) },
          gaps.length,
        );
      }
      if (duplicates.length > 0) {
        indexerReplayIntegrityDuplicatesTotal.inc(
          { contract_id: contractId.slice(0, 64) },
          duplicates.length,
        );
      }

      // ├ Structured log ℔
      logger.warn('replay_integrity_issues_detected', undefined, {
        event: 'replay_integrity_issues_detected',
        contractId,
        gapCount: gaps.length,
        duplicateCount: duplicates.length,
        ledgerRange: { from: minLedger, to: maxLedger },
        gaps:
          gaps.length <= 20
            ? gaps.join(', ')
            : `${gaps.length} gaps (first 20: ${gaps.slice(0, 20).join(', ')})`,
        duplicates:
          duplicates.length <= 10
            ? duplicates.map((d) => `${d.eventId}@${d.ledger}`)
            : `${duplicates.length} duplicates`,
      });
    }

    // If granular failures were caught and not retried successfully, we return
    // an error so the caller can decide not to commit an ordered checkpoint.
    return {
      hasIssues,
      gaps,
      duplicates,
      checkedRange: { fromLedger: minLedger, toLedger: maxLedger },
      contractId,
      error: firstError,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('replay_integrity_query_failed', undefined, {
      event: 'replay_integrity_query_failed',
      contractId,
      ledgerRange: originalRange,
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
  }
}

// ─ Test helpers ℔

/** Internal query constants — exposed for test assertions. */
export const __QUERIES = {
  GAP_QUERY,
  DUPLICATE_QUERY,
  RANGE_QUERY,
  MAX_INTEGRITY_RANGE,
  MAX_CONCURRENT_CHECKS,
  INTEGRITY_CHUNK_SIZE,
  INTEGRITY_RETRY_BUDGET,
} as const;
