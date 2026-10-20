import { describe, it, expect, beforeEach } from 'vitest';
import { registry } from '../metrics.js';
import {
  RPC_CALL_OUTCOMES,
  RPC_FAILURE_KINDS,
  deRegisterRpcMetrics,
  rpcDegradedModeGauge,
  rpcUpstreamCallDurationSeconds,
  rpcUpstreamCallsTotal,
  rpcUpstreamCallsFailedTotal,
  rpcDegradationTransitionsTotal,
} from './rpcMetrics.js';
import { MetricError } from './rpcMetricsInternal.js';

describe('rpcMetrics input validation', () => {
  beforeEach(() => {
    // Reset counters so tests are independent.
    rpcUpstreamCallsTotal.reset();
    rpcUpstreamCallsFailedTotal.reset();
    rpcUpstreamCallDurationSeconds.reset();
    // Gauge has no reset; set to a known value.
    rpcDegradedModeGauge.set(0);
  });

  it('rejects an empty operation with a typed error', () => {
    expect(() =>
      rpcUpstreamCallsTotal.inc({ operation: '', outcome: 'success' }),
    ).toThrow(MetricError);
  });

  it('rejects an unknown outcome', () => {
    expect(() =>
      rpcUpstreamCallsTotal.inc({
        operation: 'getLatestLedger',
        outcome: 'bogus' as unknown as 'success',
      }),
    ).toThrow(MetricError);
  });

  it('rejects an unknown failure kind', () => {
    expect(() =>
      rpcUpstreamCallsFailedTotal.inc({
        operation: 'getLatestLedger',
        kind: 'NOT-A_KIND' as unknown as 'TIMEOUT',
      }),
    ).toThrow(MetricError);
  });

  it('rejects an oversized operation label', () => {
    const huge = 'x'.repeat(1024);
    expect(() =>
      rpcUpstreamCallsTotal.inc({ operation: huge, outcome: 'success' }),
    ).toThrow(MetricError);
  });

  it('rejects a negative duration', () => {
    expect(() =>
      rpcUpstreamCallDurationSeconds.observe(
        { operation: 'getLatestLedger', outcome: 'success' },
        -1,
      ),
    ).toThrow(MetricError);
  });

  it('rejects a non-finite duration', () => {
    expect(() =>
      rpcUpstreamCallDurationSeconds.observe(
        { operation: 'getLatestLedger', outcome: 'success' },
        Number.NaN,
      ),
    ).toThrow(MetricError);
  });

  it('rejects an invalid degradation transition', () => {
    expect(() =>
      rpcDegradationTransitionsTotal.inc({ from: 'CLOSED', to: 'BOGUS' as unknown as 'OPEN' }),
    ).toThrow(MetricError);
  });

  it('accepts valid input without throwing', () => {
    expect(() =>
      rpcUpstreamCallsTotal.inc({ operation: 'getLatestLedger', outcome: 'success' }),
    ).not.toThrow();
    expect(() =>
      rpcUpstreamCallsFailedTotal.inc({
        operation: 'getLatestLedger',
        kind: 'TIMEOUT',
      }),
    ).not.toThrow();
    expect(() =>
      rpcUpstreamCallDurationSeconds.observe(
        { operation: 'getLatestLedger', outcome: 'success' },
        0.123,
      ),
    ).not.toThrow();
  });

  it('rejection happens before any state is written', () => {
    const before = metricValue('rpc_upstream_calls_total');
    expect(() =>
      rpcUpstreamCallsTotal.inc({ operation: '', outcome: 'success' }),
    ).toThrow(MetricError);
    const after = metricValue('rpc_upstream_calls_total');
    expect(after).toBe(before);
  });

  it('exposes the bounded label sets', () => {
    expect(RPC_CALL_OUTCOMES).toEqual(['success', 'failure']);
    expect(RPC_FAILURE_KINDS).toEqual([
      'TIMEOUT',
      'NETWORK',
      'PROVIDER',
      'CIRCUIT_OPEN',
      'CANCELLED',
    ]);
  });

  it('deregisters all rpc metrics', () => {
    deregisterRpcMetrics();
    expect(registry.getSingleMetric('rpc_upstream_calls_total')).toBeUndefined();
    expect(
      registry.getSingleMetric('hrpc_upstream_call_duration_seconds'),
    ).toBeUndefined();
  });
});

function metricValue(name: string): number {
  const metric = registry.getSingleMetric(name);
  if (!metric) {
    return 0;
  }
  const values = metric.values;
  return values.reduce((sum, v) => sum + v.value, 0);
}
