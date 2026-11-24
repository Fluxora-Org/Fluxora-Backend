import { describe, it, expect, beforeEach } from 'vitest';
import { registry } from '../metrics.js';
import {
  MAX_LABELS,
  MAX_LABEL_VALUE_LENGTH,
  RPC_CALL_OUTCOMES,
  RPC_FAILURE_KINDS,
  RPC_METRICS_REJECTION_REASONS,
  RpcMetricsValidationError,
  deRegisterRpcMetrics,
  rpcDegradedModeGauge,
  rpcDegradationTransitionsTotal,
  rpcUpstreamCallDurationSeconds,
  rpcUpstreamCallsFailedTotal,
  validateLabelValue,
  validateLabels,
  validateObservation,
} from './rpcMetrics.js';

/** Capture the typed error thrown by `fn`, failing if it does not throw. */
function captureError(fn: () => unknown): RpcMetricsValidationError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RpcMetricsValidationError);
    return err as RpcMetricsValidationError;
  }
  throw new Error('Expected a RpcMetricsValidationError, but nothing was thrown');
}

/** Sum of every series of a registry metric, read through the async API. */
async function metricValue(name: string): Promise<number> {
  const metric = registry.getSingleMetric(name);
  if (!metric) {
    return 0;
  }
  const snapshot = await metric.get();
  return snapshot.values.reduce((sum, v) => sum + v.value, 0);
}

describe('rpcMetrics input validation', () => {
  beforeEach(() => {
    // Reset counters so tests are independent.
    rpcUpstreamCallsFailedTotal.reset();
    rpcUpstreamCallDurationSeconds.reset();
    rpcDegradationTransitionsTotal.reset();
    // Gauge has no reset; set to a known value.
    rpcDegradedModeGauge.set(0);
  });

  it('rejects an empty label value with a typed error', () => {
    const err = captureError(() => validateLabelValue('operation', ''));
    expect(err.reason).toBe('EMPTY');
    expect(err.field).toBe('operation');
    expect(err.code).toBe('RPC_METRICS_INVALID_INPUT');
  });

  it('rejects a non-string label value', () => {
    const err = captureError(() => validateLabelValue('outcome', 42));
    expect(err.reason).toBe('MALFORMED');
    expect(err.field).toBe('outcome');
  });

  it('rejects an oversized operation label', () => {
    const huge = 'x'.repeat(MAX_LABEL_VALUE_LENGTH + 1);
    const err = captureError(() => validateLabelValue('operation', huge));
    expect(err.reason).toBe('OVERSIZED');
    expect(err.field).toBe('operation');
  });

  it('rejects a label value containing control characters', () => {
    const err = captureError(() => validateLabelValue('operation', 'getLatest\nLedger'));
    expect(err.reason).toBe('MALFORMED');
  });

  it('rejects an unknown label key', () => {
    const err = captureError(() =>
      validateLabels(['operation', 'outcome'], { operation: 'getLatestLedger', bogus: 'x' }),
    );
    expect(err.reason).toBe('UNKNOWN_LABEL');
    expect(err.field).toBe('bogus');
  });

  it('rejects a missing required label', () => {
    const err = captureError(() =>
      validateLabels(['operation', 'outcome'], { operation: 'getLatestLedger' }),
    );
    expect(err.reason).toBe('MALFORMED');
    expect(err.field).toBe('outcome');
  });

  it('rejects a non-object label set', () => {
    const err = captureError(() => validateLabels(['operation'], ['operation']));
    expect(err.reason).toBe('MALFORMED');
  });

  it('rejects an empty label set', () => {
    const err = captureError(() => validateLabels(['operation'], {}));
    expect(err.reason).toBe('EMPTY');
  });

  it('rejects too many labels', () => {
    const allowed = Array.from({ length: MAX_LABELS + 1 }, (_, i) => `label${i}`);
    const labels = Object.fromEntries(allowed.map((key) => [key, 'value']));
    const err = captureError(() => validateLabels(allowed, labels));
    expect(err.reason).toBe('OVERSIZED');
  });

  it('rejects a negative duration', () => {
    const err = captureError(() => validateObservation('duration', -1));
    expect(err.reason).toBe('MALFORMED');
    expect(err.field).toBe('duration');
  });

  it('rejects a non-finite duration', () => {
    expect(() => validateObservation('duration', Number.NaN)).toThrow(RpcMetricsValidationError);
    expect(() => validateObservation('duration', Number.POSITIVE_INFINITY)).toThrow(
      RpcMetricsValidationError,
    );
  });

  it('rejects a non-numeric observation', () => {
    expect(() => validateObservation('duration', '1.5')).toThrow(RpcMetricsValidationError);
  });

  it('accepts valid input without throwing', () => {
    expect(validateLabelValue('operation', 'getLatestLedger')).toBe('getLatestLedger');
    expect(
      validateLabels(['operation', 'outcome'], {
        operation: 'getLatestLedger',
        outcome: 'success',
      }),
    ).toEqual({ operation: 'getLatestLedger', outcome: 'success' });
    expect(validateObservation('duration', 0.123)).toBe(0.123);
    expect(validateObservation('duration', 0)).toBe(0);

    expect(() =>
      rpcUpstreamCallsFailedTotal.inc({ operation: 'getLatestLedger', kind: 'TIMEOUT' }),
    ).not.toThrow();
    expect(() =>
      rpcUpstreamCallDurationSeconds.observe(
        { operation: 'getLatestLedger', outcome: 'success' },
        0.123,
      ),
    ).not.toThrow();
  });

  it('rejection happens before any state is written', async () => {
    const before = await metricValue('rpc_upstream_calls_failed_total');
    captureError(() => validateLabels(['operation', 'kind'], { operation: '', kind: 'TIMEOUT' }));
    const after = await metricValue('rpc_upstream_calls_failed_total');
    expect(after).toBe(before);
  });

  it('exposes the bounded label sets and rejection reasons', () => {
    expect(RPC_CALL_OUTCOMES).toEqual(['success', 'failure']);
    expect(RPC_FAILURE_KINDS).toEqual([
      'TIMEOUT',
      'NETWORK',
      'PROVIDER',
      'CIRCUIT_OPEN',
      'CANCELLED',
    ]);
    expect(RPC_METRICS_REJECTION_REASONS).toEqual([
      'MALFORMED',
      'EMPTY',
      'OVERSIZED',
      'UNKNOWN_LABEL',
    ]);
  });

  it('deregisters all rpc metrics', () => {
    deRegisterRpcMetrics();
    expect(registry.getSingleMetric('rpc_upstream_calls_total')).toBeUndefined();
    expect(registry.getSingleMetric('rpc_upstream_calls_failed_total')).toBeUndefined();
    expect(registry.getSingleMetric('rpc_upstream_call_duration_seconds')).toBeUndefined();
    expect(registry.getSingleMetric('rpc_degradation_transitions_total')).toBeUndefined();
    expect(registry.getSingleMetric('rpc_degraded_mode')).toBeUndefined();
  });
});
