import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from '../metrics.js';
const counter = (name: string, labels: string[] = ['contract_id']) =>
  (registry.getSingleMetric(name) as any) ||
  new Counter({ name, help: name, labelNames: labels, registers: [registry] });

const gauge = (name: string, labels: string[] = ['contract_id']) =>
  (registry.getSingleMetric(name) as any) ||
  new Gauge({ name, help: name, labelNames: labels, registers: [registry] });

const histogram = (name: string, buckets: number[]) =>
  (registry.getSingleMetric(name) as any) ||
  new Histogram({ name, help: name, labelNames: ['contract_id'], buckets, registers: [registry] });

export const indexerReplayBatchesCommittedTotal = counter('indexer_replay_batches_committed_total');
export const indexerReplayRowsCommittedTotal = counter('indexer_replay_rows_committed_total');
export const indexerMtlsValidationFailuresTotal = counter('indexer_mtls_validation_failures_total', ['reason']);
export const indexerReplayRetriesTotal = counter('indexer_replay_retries_total', ['contract_id', 'reason']);
export const indexerReplayRowsPerSecond = gauge('indexer_replay_rows_per_second');
export const indexerReplayActiveWorkers = gauge('indexer_replay_active_workers');
export const indexerReplayCheckpointSequence = gauge('indexer_replay_checkpoint_sequence');
export const indexerReplayDurationSeconds = histogram('indexer_replay_duration_seconds', [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600]);
export const indexerReplayIntegrityGapsTotal = counter('indexer_replay_integrity_gaps_total');
export const indexerReplayIntegrityDuplicatesTotal = counter('indexer_replay_integrity_duplicates_total');

export function deRegisterIndexerMetrics(): void {
  for (const name of [
    'indexer_replay_batches_committed_total',
    'indexer_replay_rows_committed_total',
    'indexer_replay_rows_per_second',
    'indexer_replay_duration_seconds',
    'indexer_mtls_validation_failures_total',
    'indexer_replay_integrity_gaps_total',
    'indexer_replay_integrity_duplicates_total',
    'indexer_replay_active_workers',
    'indexer_replay_retries_total',
    'indexer_replay_checkpoint_sequence',
  ]) {
    registry.removeSingleMetric(name);
  }
}