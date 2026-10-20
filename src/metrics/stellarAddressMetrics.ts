/**
 * Metrics for the Stellar address validator (issue #1442).
 *
 * Address-validation rejections are a security-relevant signal: a malformed or
 * wrong-network address at a stream boundary indicates either a client bug or
 * probing. Exposes a single Counter so repeated failures of the same kind are
 * observable and alertable.
 *
 * Label:
 *   `reason` — closed enum of rejection causes, never the offending address:
 *     - `malformed`     — failed synchronous format/type/checksum validation.
 *     - `wrong-network` — structurally valid account absent on the configured
 *                         network's ledger.
 *     - `rpc-unavailable` — Horizon/RPC call failed and the validator failed
 *                         open; counted so an RPC outage is visible even though
 *                         the request was allowed through.
 *
 * @module metrics/stellarAddressMetrics
 *
 * @security
 * - The offending Stellar address is never a label. Addresses are per-entity
 *   identifiers and would explode series cardinality (see
 *   docs/observability/metric-cardinality.md); the address is also PII-adjacent
 *   and is deliberately omitted from metric and log output.
 *
 * Usage — alert example (PromQL):
 *   increase(fluxora_stellar_address_validation_failures_total{reason="malformed"}[5m]) > 20
 */

import { Counter } from 'prom-client';
import { registry } from '../metrics.js';
import { assertCollectorLabels } from './cardinality.js';

/**
 * Bounded set of rejection causes used as the `reason` label value. Kept as a
 * const tuple so callers receive a compile-time error for unknown reasons.
 */
export const STELLAR_ADDRESS_FAILURE_REASONS = [
  'malformed',
  'wrong-network',
  'rpc-unavailable',
] as const;

export type StellarAddressFailureReason =
  (typeof STELLAR_ADDRESS_FAILURE_REASONS)[number];

assertCollectorLabels(['reason']);

/**
 * Counter incremented once per rejected address-validation event, labelled by
 * the bounded `reason`. A single validation call that rejects two addresses
 * still records one event per reason (the addresses themselves are not labels).
 *
 * @example
 * // Fire when probing or a broken client produces a burst of malformed input.
 * increase(fluxora_stellar_address_validation_failures_total{reason="malformed"}[5m]) > 20
 */
export const stellarAddressValidationFailuresTotal =
  (registry.getSingleMetric(
    'fluxora_stellar_address_validation_failures_total',
  ) as Counter<'reason'>) ||
  new Counter({
    name: 'fluxora_stellar_address_validation_failures_total',
    help: 'Total number of Stellar address validation failures, labeled by bounded rejection reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

/**
 * Maximum byte length accepted for a `reason` string.
 *
 * The longest valid reason is `rpc-unavailable` (15 chars). We allow a small
 * headroom but reject anything that could not be a legitimate enum member,
 * preventing log/label inflation from oversized input.
 */
const MAX_REASON_LENGTH = 64;

/**
 * Typed error thrown by {@link recordStellarAddressValidationFailure} when the
 * supplied `reason` is rejected by the runtime guard.
 *
 * The caller can inspect `validationError` to understand why the input was
 * rejected without parsing the message string.
 */
export class StellarAddressMetricsValidationError extends Error {
  /**
   * Machine-readable rejection cause.
   *
   * - `'empty'`    — the value was an empty string (or whitespace-only).
   * - `'not-string'` — the value was not a string at all.
   * - `'oversized'` — the value exceeded {@link MAX_REASON_LENGTH} bytes.
   * - `'unknown-reason'` — the value is not a member of
   *                        {@link STELLAR_ADDRESS_FAILURE_REASONS}.
   */
  readonly validationError: 'empty' | 'not-string' | 'oversized' | 'unknown-reason';

  constructor(
    validationError: StellarAddressMetricsValidationError['validationError'],
    message: string,
  ) {
    super(message);
    this.name = 'StellarAddressMetricsValidationError';
    this.validationError = validationError;
  }
}

/**
 * Record a single address-validation failure.
 *
 * Performs runtime guards **before** touching any metric state so that a
 * malformed caller cannot pollute the counter with unknown label values.
 *
 * @param reason - Bounded rejection cause; unknown values are rejected at both
 *                 compile time (TypeScript) and at runtime.
 * @throws {StellarAddressMetricsValidationError} when `reason` is empty,
 *   not a string, oversized, or not a member of
 *   {@link STELLAR_ADDRESS_FAILURE_REASONS}.
 */
export function recordStellarAddressValidationFailure(
  reason: StellarAddressFailureReason,
): void {
  // --- runtime guards (run before any state mutation) ---

  if (typeof reason !== 'string') {
    throw new StellarAddressMetricsValidationError(
      'not-string',
      `recordStellarAddressValidationFailure: expected a string reason, got ${typeof reason}`,
    );
  }

  if (reason.trim().length === 0) {
    throw new StellarAddressMetricsValidationError(
      'empty',
      'recordStellarAddressValidationFailure: reason must not be empty',
    );
  }

  if (reason.length > MAX_REASON_LENGTH) {
    throw new StellarAddressMetricsValidationError(
      'oversized',
      `recordStellarAddressValidationFailure: reason exceeds maximum length of ${MAX_REASON_LENGTH} characters (got ${reason.length})`,
    );
  }

  if (!(STELLAR_ADDRESS_FAILURE_REASONS as readonly string[]).includes(reason)) {
    throw new StellarAddressMetricsValidationError(
      'unknown-reason',
      `recordStellarAddressValidationFailure: unknown reason "${reason}". ` +
        `Allowed values: ${STELLAR_ADDRESS_FAILURE_REASONS.join(', ')}`,
    );
  }

  // --- state mutation only after all guards pass ---
  stellarAddressValidationFailuresTotal.inc({ reason });
}

/**
 * De-register the counter. Intended only for test teardown — do not call in
 * production code as it cannot be safely re-registered without restarting the
 * process.
 */
export function deRegisterStellarAddressMetrics(): void {
  registry.removeSingleMetric('fluxora_stellar_address_validation_failures_total');
}
