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
 * Record a single address-validation failure.
 *
 * @param reason - Bounded rejection cause; unknown values are rejected at the
 *                 type level.
 */
export function recordStellarAddressValidationFailure(
  reason: StellarAddressFailureReason,
): void {
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
