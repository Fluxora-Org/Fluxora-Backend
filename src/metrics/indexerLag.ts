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
 *     Alert thresholds: ≥100 for 5m (warning), ≥300 for 10m (critical).
 *     See src/config/indexer-thresholds.ts for threshold rationale.
 *
 *   indexer_catchup_eta_seconds
 *     Gauge: estimated seconds until catch-up completion. Null/0 when not lagging.
 *     Computed from a rolling average of recently indexed ledgers/second.
 *
 * Alerting
 * --------
 * Two Prometheus alerts monitor indexer_ledger_lag:
 *
 *   IndexerLagWarning
 *     Fires when lag ≥ 100 ledgers for 5 minutes. Indicates the indexer is not
 *     catching up on its own; operator should investigate RPC health, batch
 *     error rate, and database write pressure.
 *
 *   IndexerLagCritical
 *     Fires when lag ≥ 300 ledgers for 10 minutes. Data freshness SLA is
 *     violated and lag is user-visible. Requires immediate action (page).
 *
 * See docs/observability/indexer-lag-alerts.yml for Prometheus rules and
 * docs/observability/alerting-runbook.md for the operator response runbook.
 *
 * Security:
 * - Label cardinality is bounded (no user-provided labels)
 * - Values are sanitized to prevent metric corruption
 *
 * Issue #1788 — Harden the input validation in indexerLag
 * --------------------------------------------------------
 * All public setter functions validate their arguments before touching any
 * metric state. Rejection happens before any write, and the caller receives
 * a typed `IndexerLagValidationError` that describes which constraint was
 * violated and why, so it can be surfaced in logs without ambiguity.
 */

import { Counter, Gauge } from 'prom-client';
import { registry } from '../metrics.js';

// ── Validation constants ──────────────────────────────────────────────────────

/** Ledger numbers are unsigned 32-bit integers on Stellar. */
export const MAX_LEDGER_SEQUENCE = 4_294_967_295; // 2^32 - 1

/**
 * Upper bound for catchup ETA. Anything above ~2 years of seconds in a single
 * metric sample is almost certainly a programming error (e.g. milliseconds
 * passed instead of seconds).
 */
export const MAX_ETA_SECONDS = 63_072_000; // 2 years in seconds

// ── Typed validation error ────────────────────────────────────────────────────

/** Reason codes for IndexerLagValidationError */
export type IndexerLagValidationErrorReason =
  | 'NOT_A_NUMBER'
  | 'NOT_FINITE'
  | 'NEGATIVE'
  | 'NOT_AN_INTEGER'
  | 'EXCEEDS_MAX'
  | 'INVALID_DIRECTION';

/**
 * Thrown by validated setters when an argument does not satisfy the documented
 * constraints. The caller can inspect `reason` to distinguish error classes
 * without string-matching.
 */
export class IndexerLagValidationError extends Error {
  readonly reason: IndexerLagValidationErrorReason;
  readonly field: string;
  readonly value: unknown;

  constructor(opts: {
    field: string;
    reason: IndexerLagValidationErrorReason;
    value: unknown;
    message: string;
  }) {
    super(opts.message);
    this.name = 'IndexerLagValidationError';
    this.reason = opts.reason;
    this.field = opts.field;
    this.value = opts.value;
  }
}

// ── Internal validator helpers ────────────────────────────────────────────────

function assertNonNegativeInteger(field: string, value: unknown, max?: number): void {
  if (typeof value !== 'number') {
    throw new IndexerLagValidationError({
      field,
      reason: 'NOT_A_NUMBER',
      value,
      message: `${field} must be a number, got ${typeof value}`,
    });
  }
  if (!Number.isFinite(value)) {
    throw new IndexerLagValidationError({
      field,
      reason: 'NOT_FINITE',
      value,
      message: `${field} must be finite, got ${value}`,
    });
  }
  if (value < 0) {
    throw new IndexerLagValidationError({
      field,
      reason: 'NEGATIVE',
      value,
      message: `${field} must be non-negative, got ${value}`,
    });
  }
  if (!Number.isInteger(value)) {
    throw new IndexerLagValidationError({
      field,
      reason: 'NOT_AN_INTEGER',
      value,
      message: `${field} must be an integer, got ${value}`,
    });
  }
  if (max !== undefined && value > max) {
    throw new IndexerLagValidationError({
      field,
      reason: 'EXCEEDS_MAX',
      value,
      message: `${field} must be ≤ ${max}, got ${value}`,
    });
  }
}

// ── Gauges ─────────────────────────────────────────────────────────────────────

/**
 * Current ledger lag in ledgers (tip - last_indexed_ledger).
 * Updated when the indexer falls behind and during catch-up.
 *
 * Alert thresholds:
 * - Warning: ≥100 ledgers for 5 minutes
 * - Critical: ≥300 ledgers for 10 minutes
 *
 * See src/config/indexer-thresholds.ts for threshold definitions and rationale.
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

// ── Validated setters (issue #1788) ──────────────────────────────────────────

/**
 * Set the current ledger lag.
 *
 * Validates before any metric write:
 * - `lag` must be a finite, non-negative integer
 * - `lag` must not exceed `MAX_LEDGER_SEQUENCE`
 *
 * @throws {IndexerLagValidationError} when validation fails; no metric is written.
 */
export function setLedgerLag(lag: unknown): void {
  assertNonNegativeInteger('lag', lag, MAX_LEDGER_SEQUENCE);
  indexerLedgerLag.set(lag as number);
}

/**
 * Set the estimated catch-up ETA in seconds.
 *
 * Validates before any metric write:
 * - `seconds` must be a finite, non-negative integer
 * - `seconds` must not exceed `MAX_ETA_SECONDS`
 *
 * Pass `0` to indicate the indexer is caught up or the ETA is unknown.
 *
 * @throws {IndexerLagValidationError} when validation fails; no metric is written.
 */
export function setCatchupEtaSeconds(seconds: unknown): void {
  assertNonNegativeInteger('seconds', seconds, MAX_ETA_SECONDS);
  indexerCatchupEtaSeconds.set(seconds as number);
}

// ── Backfill yield-to-live-indexing observability ─────────────────────────────

/**
 * Whether the backfill scheduler is currently yielding to live indexing.
 * `1` while paused, `0` while running.
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
 */
export const indexerBackfillYieldEventsTotal =
  (registry.getSingleMetric('indexer_backfill_yield_events_total') as Counter<'event'>) ||
  new Counter({
    name: 'indexer_backfill_yield_events_total',
    help: 'Total backfill yield-to-live-indexing transitions, by direction (paused/resumed)',
    labelNames: ['event'] as const,
    registers: [registry],
  });

/**
 * Record a backfill scheduler yield-direction transition.
 *
 * Validates that `direction` is exactly `'paused'` or `'resumed'` before
 * writing to the metric, preventing label-cardinality explosion from
 * accidental free-form strings reaching the metric store.
 *
 * @throws {IndexerLagValidationError} when `direction` is neither value.
 */
export function recordBackfillYieldEvent(direction: unknown): void {
  if (direction !== 'paused' && direction !== 'resumed') {
    throw new IndexerLagValidationError({
      field: 'direction',
      reason: 'INVALID_DIRECTION',
      value: direction,
      message: `direction must be "paused" or "resumed", got ${JSON.stringify(direction)}`,
    });
  }
  indexerBackfillPaused.set(direction === 'paused' ? 1 : 0);
  indexerBackfillYieldEventsTotal.inc({ event: direction });
}

// ── Deregister (for test isolation) ──────────────────────────────────────────

export function deRegisterIndexerLagMetrics(): void {
  registry.removeSingleMetric('indexer_ledger_lag');
  registry.removeSingleMetric('indexer_catchup_eta_seconds');
  registry.removeSingleMetric('indexer_backfill_paused');
  registry.removeSingleMetric('indexer_backfill_yield_events_total');
}

/**
 * Reset the backfill yield series without deregistering them.
 */
export function resetBackfillYieldMetrics(): void {
  indexerBackfillPaused.set(0);
  indexerBackfillYieldEventsTotal.reset();
}
