/**
 * Prometheus metrics for IndexerService replay operations.
 *
 * Metrics are registered in the shared application registry so they appear on
 * the /metrics endpoint alongside pool and HTTP metrics.
 *
 * Labels
 * -------
 *   contract_id — the contract being replayed (truncated to 64 chars for safety)
 *
 * Metric descriptions
 * --------------------
 *   indexer_replay_batches_committed_total
 *     Counter: total batch transactions committed across all replay runs.
 *     Useful for alerting on stalled replays (rate drops to 0).
 *
 *   indexer_replay_rows_committed_total
 *     Counter: total rows successfully inserted (or skipped via ON CONFLICT DO
 *     NOTHING) across all replay runs.
 *
 *   indexer_replay_rows_per_second
 *     Gauge: rolling rows/sec for the currently active replay. Reset to 0 when
 *     no replay is in progress.
 *
 *   indexer_replay_duration_seconds
 *     Histogram: wall-clock duration of each completed replay job (seconds).
 *     Buckets are biased toward longer backfills (minutes to hours).
 *
 *   indexer_mtls_validation_failures_total
 *     Counter: total number of mTLS client-certificate validation failures.
 *     Labels: reason (e.g. 'expired', 'unknown_ca', 'missing_cert').
 *
 *   indexer_replay_integrity_gaps_total
 *     Counter: total ledger gaps detected across all replay integrity checks.
 *     Labels: contract_id.
 *
 *   indexer_replay_integrity_duplicates_total
 *     Counter: total duplicate event entries detected across all replay
 *     integrity checks.  Labels: contract_id.
 */

import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from '../metrics.js';

// ── Counters ──────────────────────────────────────────────────────────────────

export const indexerReplayBatchesCommittedTotal =
  (registry.getSingleMetric('indexer_replay_batches_committed_total') as Counter<'contract_id'>) ||
  new Counter({
    name: 'indexer_replay_batches_committed_total',
    help: 'Total number of batch transactions committed during indexer replay operations',
    labelNames: ['contract_id'] as const,
    registers: [registry],
  });

export const indexerReplayRowsCommittedTotal =
  (registry.getSingleMetric('indexer_replay_rows_committed_total') as Counter<'contract_id'>) ||
  new Counter({
    name: 'indexer_replay_rows_committed_total',
    help: 'Total number of rows inserted or skipped (ON CONFLICT DO NOTHING) during indexer replays',
    labelNames: ['contract_id'] as const,
    registers: [registry],
  });

export const indexerMtlsValidationFailuresTotal =
  (registry.getSingleMetric('indexer_mtls_validation_failures_total') as Counter<'reason'>) ||
  new Counter({
    name: 'indexer_mtls_validation_failures_total',
    help: 'Total number of mTLS client-certificate validation failures on the indexer worker connection',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

// ── Gauge ─────────────────────────────────────────────────────────────────────

export const indexerReplayRowsPerSecond =
  (registry.getSingleMetric('indexer_replay_rows_per_second') as Gauge<'contract_id'>) ||
  new Gauge({
    name: 'indexer_replay_rows_per_second',
    help: 'Rolling rows-per-second throughput for the currently active replay (0 when idle)',
    labelNames: ['contract_id'] as const,
    registers: [registry],
  });

// ── Histogram ─────────────────────────────────────────────────────────────────

export const indexerReplayDurationSeconds =
  (registry.getSingleMetric('indexer_replay_duration_seconds') as Histogram<'contract_id'>) ||
  new Histogram({
    name: 'indexer_replay_duration_seconds',
    help: 'Wall-clock duration of completed indexer replay jobs in seconds',
    labelNames: ['contract_id'] as const,
    // Buckets cover a wide range: from a few seconds to hours-long backfills
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
    registers: [registry],
  });

// ── Integrity-check counters ──────────────────────────────────────────────────

export const indexerReplayIntegrityGapsTotal =
  (registry.getSingleMetric('indexer_replay_integrity_gaps_total') as Counter<'contract_id'>) ||
  new Counter({
    name: 'indexer_replay_integrity_gaps_total',
    help: 'Total number of ledger gaps detected across all post-replay integrity checks',
    labelNames: ['contract_id'] as const,
    registers: [registry],
  });

export const indexerReplayIntegrityDuplicatesTotal =
  (registry.getSingleMetric('indexer_replay_integrity_duplicates_total') as Counter<'contract_id'>) ||
  new Counter({
    name: 'indexer_replay_integrity_duplicates_total',
    help: 'Total number of duplicate event entries detected across all post-replay integrity checks',
    labelNames: ['contract_id'] as const,
    registers: [registry],
  });

// ── Deregister (for test isolation) ──────────────────────────────────────────

export function deRegisterIndexerMetrics(): void {
  registry.removeSingleMetric('indexer_replay_batches_committed_total');
  registry.removeSingleMetric('indexer_replay_rows_committed_total');
  registry.removeSingleMetric('indexer_replay_rows_per_second');
  registry.removeSingleMetric('indexer_replay_duration_seconds');
  registry.removeSingleMetric('indexer_mtls_validation_failures_total');
  registry.removeSingleMetric('indexer_replay_integrity_gaps_total');
  registry.removeSingleMetric('indexer_replay_integrity_duplicates_total');
}
