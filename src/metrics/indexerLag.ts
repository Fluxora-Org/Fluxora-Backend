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

import { Gauge } from 'prom-client';
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

// ── Deregister (for test isolation) ──────────────────────────────────────────

export function deRegisterIndexerLagMetrics(): void {
  registry.removeSingleMetric('indexer_ledger_lag');
  registry.removeSingleMetric('indexer_catchup_eta_seconds');
}
