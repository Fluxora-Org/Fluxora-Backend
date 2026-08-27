/**
 * RED (Rate / Errors / Duration) metrics for the indexer batch processing loop.
 *
 * ## Why a dedicated module
 *
 * `src/metrics/indexerMetrics.ts` tracks *replay-run* level counters
 * (`indexer_replay_*`) — one observation per replay job. Those are useful for
 * backfill progress but cannot answer the three questions an on-call operator
 * asks about the per-batch processing step itself:
 *
 *   Rate      — how many ledger batches are we processing per second?
 *   Errors    — what fraction of them fail, and why?
 *   Duration  — how long does one batch take (p50/p95/p99)?
 *
 * This module provides exactly that triad, mirroring the HTTP RED metrics in
 * `src/metrics.ts` (`http_requests_total` / `http_request_duration_seconds`)
 * so an indexer dashboard can be built from the same PromQL shapes as the
 * HTTP dashboard.
 *
 * ## Naming / label parity with the HTTP RED metrics
 *
 * | Concern  | HTTP                             | Indexer batch                          |
 * |----------|----------------------------------|----------------------------------------|
 * | Rate     | `http_requests_total`            | `indexer_batches_processed_total`       |
 * | Errors   | (5xx slice of the above)         | `indexer_batch_errors_total`            |
 * | Duration | `http_request_duration_seconds`  | `indexer_batch_duration_seconds`        |
 * | "what"   | `route`                          | `contract_id`                           |
 * | "result" | `status_code`                    | `outcome` (`success` \| `error`)        |
 *
 * Both the rate counter and the duration histogram carry the same label set
 * (`contract_id`, `outcome`) — exactly as the HTTP pair does — so a single
 * PromQL template works for either subsystem.
 *
 * ## Cardinality and safety
 *
 * - `contract_id` is truncated to 64 characters (same convention as
 *   `indexerMetrics.ts`) and falls back to `unknown` when absent, so a
 *   malformed request can never create an unbounded label value.
 * - `error_source` and `error_type` are drawn from closed unions declared in
 *   this file. Raw error messages are **never** used as label values, so an
 *   error carrying user input (or PII) cannot inflate cardinality or leak into
 *   the `/metrics` payload.
 *
 * @module metrics/indexerRed
 */

import { Counter, Histogram } from 'prom-client';
import { registry } from '../metrics.js';
// Type-only import: keeps this module free of any runtime dependency on the
// Stellar RPC service (and its Redis/tracing import chain) while still binding
// the RPC error taxonomy to its single source of truth.
import type { RpcFailureKind } from '../services/stellar-rpc.js';

// ── Label unions ──────────────────────────────────────────────────────────────

/** Terminal result of one batch processing step. Mirrors HTTP `status_code`. */
export type IndexerBatchOutcome = 'success' | 'error';

/**
 * Where a batch failure originated.
 *
 * `stellar_rpc` — the error was raised by a call into
 *                 `src/services/stellar-rpc.ts` (provider outage, timeout,
 *                 open circuit breaker, …). These are *upstream* failures:
 *                 retrying the indexer will not help until the provider
 *                 recovers.
 * `local`       — the error was raised by this process while processing the
 *                 batch (database failure, unexpected exception). These are
 *                 *our* failures and are actionable by the indexer owner.
 */
export type IndexerBatchErrorSource = 'stellar_rpc' | 'local';

/** Error taxonomy for failures originating in `src/services/stellar-rpc.ts`. */
export type IndexerRpcErrorType =
  | 'timeout'
  | 'network'
  | 'provider'
  | 'circuit_open'
  | 'cancelled';

/** Error taxonomy for failures originating inside the indexer process. */
export type IndexerLocalErrorType =
  | 'db_pool_exhausted'
  | 'db_query_timeout'
  | 'db_duplicate_entry'
  | 'db_error'
  | 'unknown';

export type IndexerBatchErrorType = IndexerRpcErrorType | IndexerLocalErrorType;

/** Result of {@link classifyIndexerBatchError}. */
export interface IndexerBatchErrorClassification {
  source: IndexerBatchErrorSource;
  type: IndexerBatchErrorType;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

/**
 * **Rate.** Total batch processing steps executed, including the ones that
 * failed — the `outcome` label separates them, exactly as `status_code` does
 * for `http_requests_total`.
 *
 * This differs from `indexer_replay_batches_committed_total`, which counts
 * only batches that reached COMMIT. A batch that fetched zero rows (source
 * exhausted) still counts here as one `success`, because one unit of work was
 * performed.
 *
 * ```promql
 * sum(rate(indexer_batches_processed_total[5m])) by (contract_id)
 * ```
 */
export const indexerBatchesProcessedTotal =
  (registry.getSingleMetric('indexer_batches_processed_total') as Counter<
    'contract_id' | 'outcome'
  >) ||
  new Counter({
    name: 'indexer_batches_processed_total',
    help: 'Total number of indexer ledger-batch processing steps executed, by outcome',
    labelNames: ['contract_id', 'outcome'] as const,
    registers: [registry],
  });

/**
 * **Errors.** Failed batch processing steps, broken down by where the failure
 * came from and what kind it was.
 *
 * Every increment here is accompanied by an `outcome="error"` increment on
 * {@link indexerBatchesProcessedTotal}, so the error *ratio* is computable
 * from either metric:
 *
 * ```promql
 * # Error ratio, all causes
 * sum(rate(indexer_batch_errors_total[5m]))
 *   / sum(rate(indexer_batches_processed_total[5m]))
 *
 * # Is it us, or is it the RPC provider?
 * sum(rate(indexer_batch_errors_total[5m])) by (error_source, error_type)
 * ```
 */
export const indexerBatchErrorsTotal =
  (registry.getSingleMetric('indexer_batch_errors_total') as Counter<
    'contract_id' | 'error_source' | 'error_type'
  >) ||
  new Counter({
    name: 'indexer_batch_errors_total',
    help: 'Total number of failed indexer ledger-batch processing steps, by error source and type',
    labelNames: ['contract_id', 'error_source', 'error_type'] as const,
    registers: [registry],
  });

/**
 * **Duration.** Wall-clock time of one batch processing step, in seconds.
 *
 * Buckets start finer than the HTTP histogram's (a batch is a multi-statement
 * transaction, not a single request) and extend to 60 s so a pathologically
 * slow batch still lands in a real bucket instead of `+Inf`.
 *
 * ```promql
 * histogram_quantile(0.99, sum(rate(indexer_batch_duration_seconds_bucket[5m])) by (le))
 * ```
 */
export const indexerBatchDurationSeconds =
  (registry.getSingleMetric('indexer_batch_duration_seconds') as Histogram<
    'contract_id' | 'outcome'
  >) ||
  new Histogram({
    name: 'indexer_batch_duration_seconds',
    help: 'Duration of indexer ledger-batch processing steps in seconds',
    labelNames: ['contract_id', 'outcome'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });

// ── Label helpers ─────────────────────────────────────────────────────────────

/** Maximum length of the `contract_id` label value. Matches indexerMetrics.ts. */
const MAX_CONTRACT_ID_LABEL_LENGTH = 64;

/**
 * Normalise a contract id into a bounded label value.
 *
 * Truncates to {@link MAX_CONTRACT_ID_LABEL_LENGTH} characters and maps
 * missing/blank ids to `unknown`, so a metric series can never be created from
 * an arbitrarily long caller-supplied string.
 */
export function normalizeContractIdLabel(contractId: string | undefined | null): string {
  if (typeof contractId !== 'string') return 'unknown';
  const trimmed = contractId.trim();
  if (trimmed.length === 0) return 'unknown';
  return trimmed.slice(0, MAX_CONTRACT_ID_LABEL_LENGTH);
}

// ── Error classification ──────────────────────────────────────────────────────

/**
 * Error `name` values exported by `src/services/stellar-rpc.ts`.
 *
 * Matched structurally rather than with `instanceof` so classification keeps
 * working when an error crosses a module-instance boundary (dual ESM/CJS
 * resolution, vitest module mocking) — and so this module needs no runtime
 * import of the RPC service.
 */
const RPC_ERROR_NAMES = new Set(['RpcProviderError', 'CircuitOpenError']);

/** `RpcFailureKind` → the lower-snake-case label value we expose. */
const RPC_KIND_TO_ERROR_TYPE: Record<RpcFailureKind, IndexerRpcErrorType> = {
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  PROVIDER: 'provider',
  CIRCUIT_OPEN: 'circuit_open',
  CANCELLED: 'cancelled',
};

/** Error `name` values exported by `src/db/pool.ts` → local label value. */
const LOCAL_ERROR_NAME_TO_TYPE: Record<string, IndexerLocalErrorType> = {
  PoolExhaustedError: 'db_pool_exhausted',
  QueryTimeoutError: 'db_query_timeout',
  DuplicateEntryError: 'db_duplicate_entry',
};

/** Postgres SQLSTATE codes are exactly five uppercase alphanumerics. */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * Classify a batch failure into a bounded `(source, type)` label pair.
 *
 * The classifier is deliberately total: any value — including a thrown string,
 * `null`, or an error with no recognisable shape — yields
 * `{ source: 'local', type: 'unknown' }` rather than throwing. Metric recording
 * must never be able to mask the original failure.
 *
 * @param error The value thrown by the batch processing step.
 * @returns The `error_source` / `error_type` labels to record.
 */
export function classifyIndexerBatchError(
  error: unknown,
): IndexerBatchErrorClassification {
  if (typeof error !== 'object' || error === null) {
    return { source: 'local', type: 'unknown' };
  }

  const candidate = error as { name?: unknown; kind?: unknown; code?: unknown };
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const kind = typeof candidate.kind === 'string' ? candidate.kind : '';

  // 1. Stellar RPC failures — recognised by error name, or by a `kind` field
  //    holding a known RpcFailureKind (covers subclasses and re-wrapped errors).
  const rpcType = RPC_KIND_TO_ERROR_TYPE[kind as RpcFailureKind];
  if (RPC_ERROR_NAMES.has(name)) {
    return { source: 'stellar_rpc', type: rpcType ?? 'provider' };
  }
  if (rpcType !== undefined) {
    return { source: 'stellar_rpc', type: rpcType };
  }

  // 2. Known local database errors raised by src/db/pool.ts.
  const localType = LOCAL_ERROR_NAME_TO_TYPE[name];
  if (localType !== undefined) {
    return { source: 'local', type: localType };
  }

  // 3. Raw driver errors from `pg` carry a SQLSTATE in `code`.
  if (typeof candidate.code === 'string' && SQLSTATE_PATTERN.test(candidate.code)) {
    return { source: 'local', type: 'db_error' };
  }

  return { source: 'local', type: 'unknown' };
}

// ── Recording helpers ─────────────────────────────────────────────────────────

/**
 * Record a batch processing step that completed without throwing.
 *
 * @param contractId       Contract whose ledger batch was processed.
 * @param durationSeconds  Wall-clock duration of the step, in seconds.
 */
export function recordIndexerBatchSuccess(
  contractId: string,
  durationSeconds: number,
): void {
  const labels = { contract_id: normalizeContractIdLabel(contractId), outcome: 'success' as const };
  indexerBatchesProcessedTotal.inc(labels);
  indexerBatchDurationSeconds.observe(labels, durationSeconds);
}

/**
 * Record a batch processing step that threw.
 *
 * Increments the rate counter with `outcome="error"` (so the denominator stays
 * correct), observes the duration up to the point of failure, and increments
 * the error counter with the classified `(error_source, error_type)` pair.
 *
 * @param contractId       Contract whose ledger batch was being processed.
 * @param durationSeconds  Wall-clock duration until the failure, in seconds.
 * @param error            The thrown value; classified via
 *                         {@link classifyIndexerBatchError}.
 * @returns The classification that was recorded, so callers can reuse it in
 *          structured logs without re-classifying.
 */
export function recordIndexerBatchFailure(
  contractId: string,
  durationSeconds: number,
  error: unknown,
): IndexerBatchErrorClassification {
  const contract = normalizeContractIdLabel(contractId);
  const classification = classifyIndexerBatchError(error);

  indexerBatchesProcessedTotal.inc({ contract_id: contract, outcome: 'error' });
  indexerBatchDurationSeconds.observe({ contract_id: contract, outcome: 'error' }, durationSeconds);
  indexerBatchErrorsTotal.inc({
    contract_id: contract,
    error_source: classification.source,
    error_type: classification.type,
  });

  return classification;
}

// ── Test isolation ────────────────────────────────────────────────────────────

/**
 * Zero every indexer RED series. Test use only.
 *
 * Deliberately `reset()` rather than `registry.removeSingleMetric()`: removal
 * would leave the module-level singletons above pointing at collectors that are
 * no longer in the registry, so subsequent recordings would silently vanish
 * from `/metrics`. Resetting keeps the registration intact.
 */
export function resetIndexerRedMetrics(): void {
  indexerBatchesProcessedTotal.reset();
  indexerBatchErrorsTotal.reset();
  indexerBatchDurationSeconds.reset();
}
