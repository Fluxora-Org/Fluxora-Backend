import { Counter, Histogram, Gauge } from 'prom-client';
import { registry } from '../metrics.js';

/**
 * Typed error thrown when a metrics input fails validation.
 *
 * Carries a stable `reason` code so the caller can tell programmatically why the
 * input was rejected, plus the offending field name and a human-readable message.
 */
export class RpcMetricsValidationError extends Error {
  public readonly code = 'RPC_METRICS_INVALID_INPUT';
  public readonly reason: ReportedReason;
  public readonly field: string;

  constructor(reason: ReportedReason, field: string, message: string) {
    super(message);
    this.name = 'RpcMetricsValidationError';
    this.reason = reason;
    this.field = field;
    Object.setPrototypeOf(this, RpcMetricsValidationError.prototype);
  }
}

/**
 * Stable set of rejection reasons so callers can branch on the cause without
 * parsing message strings.
 */
export const RPC_METRICS_REJECTION_REASONS = [
  'MALFORMED',
  'EMPTY',
  'OVERSIZED',
  'UNKNOWN_LABEL',
] as const;
export type ReportedReason = (typeof RPC_METRICS_REJECTION_REASONS)[number];

/** Maximum accepted length for any single label value. */
export const MAX_LABEL_VALUE_LENGTH = 256;

/** Maximum number of labels accepted in a single input object. */
export const MAX_LABELS = 16;

/**
 * Validate a label value before it is written to any collector.
 *
 * Rejects non-string, empty, oversized and control-character labels. Throws a
 * typed `RpcMetricsValidationError` before any state is written.
 */
export function validateLabelValue(field: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new RpcMetricsValidationError(
      'MALFORMED',
      field,
      `Label "${field}" must be a string, received ${typeof value}`,
    );
  }
  if (value.length === 0) {
    throw new RpcMetricsValidationError('EMPTY', field, `Label "${field}" must not be empty`);
  }
  if (value.length > MAX_LABEL_VALUE_LENGTH) {
    throw new RpcMetricsValidationError(
      'OVERSIZED',
      field,
      `Label "${field}" exceeds maximum length of ${MAX_LABEL_VALUE_LENGTH} characters`,
    );
  }
  // Reject control characters that could corrupt exposition output.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new RpcMetricsValidationError(
      'MALFORMED',
      field,
      `Label "${field}" contains control characters`,
    );
  }
  return value;
}

/**
 * Validate an object of labels against an allowed label set.
 *
 * Rejects non-object input, unknown label keys, missing required keys, empty
 * values, oversized values and too many labels. All checks run before any collector
 * is touched, so a rejection never writes state.
 */
export function validateLabels(
  allowed: readonly string[],
  labels: unknown,
  required: readonly string[] = allowed,
): Record<string, string> {
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) {
    throw new RpcMetricsValidationError(
      'MALFORMED',
      'labels',
      'Labels must be a plain object',
    );
  }
  const entries = Object.entries(labels as Record<string, unknown>);
  if (entries.length === 0) {
    throw new RpcMetricsValidationError('EMPTY', 'labels', 'Labels object must not be empty');
  }
  if (entries.length > MAX_LABELS) {
    throw new RpcMetricsValidationError(
      'OVERSIZED',
      'labels',
      `Labels object exceeds maximum of ${MAX_LABELS} entries`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!allowed.includes(key)) {
      throw new RpcMetricsValidationError(
        'UNKNOWN_LABEL',
        key,
        `Unknown label "${key}"; allowed: ${allowed.join(', ')}`,
      );
    }
    out[key] = validateLabelValue(key, value);
  }
  for (const key of required) {
    if (!(key in out)) {
      throw new RpcMetricsValidationError(
        'MALFORMED',
        key,
        `Missing required label "${key}"`,
      );
    }
  }
  return out;
}

/**
 * Validate a numeric observation (e.g. a histogram duration) before it is
 * written. Rejects non-finite and negative values with a typed error.
 */
export function validateObservation(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RpcMetricsValidationError(
      'MALFORMED',
      field,
      `Observation "${field}" must be a finite number`,
    );
  }
  if (value < 0) {
    throw new RpcMetricsValidationError(
      'MALFORMED',
      field,
      `Observation "${field}" must not be negative`,
    );
  }
  return value;
}

/**
 * Counter for observed entry into and exit from RPC degradation mode.
 *
 * Incremented by `rpcDegradationMiddleware` each time the circuit-breaker
 * state it observes changes between requests. `from` is the previous state
 * and `to` the new one, so `{from="CLOSED",to="OPEN"}` counts entries into
 * degradation and `{from="OPEN",to="CLOSED"}` counts automatic recoveries.
 */
export const rpcDegradationTransitionsTotal =
  (registry.getSingleMetric('rpc_degradation_transitions_total') as Counter<'from' | 'to'>)  ||
  new Counter({
    name: 'rpc_degradation_transitions_total',
    help: 'Total Stellar RPC degradation-mode transitions observed by the HTTP degradation middleware',
    labelNames: ['from', 'to'] as const,
    registers: [registry],
  });

export const rpcUpgradeCallsTotal =
  (registry.getSingleMetric('import') as Counter<'operation' | 'outcome'>)  ||
  new Counter({
    name: 'rpc_upstream_calls_total',
    help: 'Total Stellar RPC upstream calls attempted',
    labelNames: ['operation', 'outcome'] as const,
    registers: [registry],
  });

export const rpcUpstreamCallsFailedTotal =
  (registry.getSingleMetric('rpc_upstream_calls_failed_total') as Counter<'operation' | 'kind'>)  ||
  new Counter({
    name: 'rpc_upstream_calls_failed_total',
    help: 'Total Stellar RPC upstream call failures by failure kind',
    labelNames: ['operation', 'kind'] as const,
    registers: [registry],
  });

export const rpcUpstreamCallDurationSeconds =
  (registry.getSingleMetric('rpc_upstream_call_duration_seconds') as Histogram<'operation' | 'outcome'>)  ||
  new Histogram({
    name: 'rpc_upstream_call_duration_seconds',
    help: 'Stellar RPC upstream call duration in seconds',
    labelNames: ['operation', 'outcome'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

export const RPC_CALL_OUTCOMES = ['success', 'failure'] as const;
export const RPC_FAILURE_KINDS = [
  'TIMEOUT',
  'NETWORK',
  'PROVIDER',
  'CIRCUIT_OPEN',
  'CANCELLED',
] as const;

export const rpcDegradedModeGauge =
  (registry.getSingleMetric('rpc_degraded_mode') as Gauge)  ||
  new Gauge({
    name: 'rpc_degraded_mode',
    help: 'Whether the backend is in Stellar RPC degradation mode (1 = degraded, 0 = healthy)',
    registers: [registry],
  });

export function deRegisterRpcMetrics(): void {
  for (const name of [
    'rpc_degradation_transitions_total',
    'rpc_upstream_calls_total',
    'rpc_upstream_calls_failed_total',
    'rpc_upstream_call_duration_seconds',
    'rpc_degraded_mode',
  ]) {
    registry.removeSingleMetric(name);
  }
}
