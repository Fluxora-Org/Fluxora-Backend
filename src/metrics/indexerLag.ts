/**
 * Prometheus metrics for indexer catch-up telemetry.
 *
 * These metrics track the indexer's ledger lag (tip minus last-indexed ledger)
 * and estimated time to catch up when the indexer falls behind the Stellar RPC
 * ledger tip after a restart or extended stall.
 *
 * Metric descriptions
 * --------------------
 *   indexer_ledger_lag
 *     Gauge: current ledger lag (tip - last_indexed_ledger). 0 when caught up.
 *     Helps operators understand how far behind the indexer is.
 *
 *   indexer_catchup_eta_seconds
 *     Gauge: estimated seconds until catch-up completion. Null/0 when not lagging.
 *     Computed from a rolling average of recently indexed ledgers/second.
 *
 * Security:
 * - Label cardinality is bounded (no user-provided labels)
 * - Values are sanitized to prevent metric corruption
 */

import { Counter, Gauge } from 'prom-client';
import { registry } from '../metrics.js';

// ── Gauges ─────────────────────────────────────────────────────────────────────

/**
 * Current ledger lag in ledgers (tip - last_indexed_ledger).
 * Updated when the indexer falls behind and during catch-up.
 */
export const indexerLedgerLag =
  (registry.getSingleMetric('indexer_ledger_lag') as Gauge) ||
  new Gauge({
    name: 'indexer_ledger_lag',
    help: 'Current indexer ledger lag (tip - last_indexed_ledger) in ledgers',
    registers: [registry],
  });

/**
 * Estimated time to catch up in seconds.
 * Computed from rolling average of indexed ledgers/second.
 * Set to 0 when not lagging or when insufficient data for estimation.
 */
export const indexerCatchupEtaSeconds =
  (registry.getSingleMetric('indexer_catchup_eta_seconds') as Gauge) ||
  new Gauge({
    name: 'indexer_catchup_eta_seconds',
    help: 'Estimated seconds until indexer catch-up completion (0 when not lagging)',
    registers: [registry],
  });

// ── Backfill yield-to-live-indexing observability ─────────────────────────────
//
// `src/indexer/backfillScheduler.ts` consults `indexer_ledger_lag` before
// starting each batch and pauses when live indexing is behind. These two
// series make that decision observable:
//
//   - the gauge answers "is the backfill currently paused?"
//   - the counter answers "how often, and in which direction, did it flip?"
//
// An operator alert can then be written as: the backfill has been paused for
// more than N minutes, which is a direct signal that live indexing is behind.

/**
 * Whether the backfill scheduler is currently yielding to live indexing.
 * `1` while paused, `0` while running. Kept as a gauge (not a counter) so the
 * current state is queryable without knowing the transition count.
 */
export const indexerBackfillPaused =
  (registry.getSingleMetric('indexer_backfill_paused') as Gauge) ||
  new Gauge({
    name: 'indexer_backfill_paused',
    help: 'Whether the backfill scheduler is paused to yield to live indexing (1 = paused, 0 = running)',
    registers: [registry],
  });

/**
 * Count of backfill yield transitions, labelled by direction.
 *
 * `event="paused"` when the scheduler stops starting batches because live
 * indexing is behind; `event="resumed"` when it automatically continues after
 * the lag drops back below the threshold.
 */
export const indexerBackfillYieldEventsTotal =
  (registry.getSingleMetric('indexer_backfill_yield_events_total') as Counter<'event'>) ||
  new Counter({
    name: 'indexer_backfill_yield_events_total',
    help: 'Total backfill yield-to-live-indexing transitions, by direction (paused/resumed)',
    labelNames: ['event'] as const,
    registers: [registry],
  });

// ── Deregister (for test isolation) ──────────────────────────────────────────

export function deRegisterIndexerLagMetrics(): void {
  registry.removeSingleMetric('indexer_ledger_lag');
  registry.removeSingleMetric('indexer_catchup_eta_seconds');
  registry.removeSingleMetric('indexer_backfill_paused');
  registry.removeSingleMetric('indexer_backfill_yield_events_total');
}

/**
 * Reset the backfill yield series without deregistering them, so repeated test
 * runs start from a clean slate while the registered collectors stay valid.
 */
export function resetBackfillYieldMetrics(): void {
  indexerBackfillPaused.set(0);
  indexerBackfillYieldEventsTotal.reset();
}
