import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { StellarRpcService } from './stellar-rpc.js';
import {
  getRpcProviderLabelFromEndpoint,
  rpcProviderHealthyGauge,
  rpcProviderHealthCheckFailuresTotal,
} from '../metrics/rpcMetrics.js';

function makeClient(ledgerFn: () => Promise<{ sequence: number }>) {
  return () => ({
    getLatestLedger: ledgerFn,
    horizonUrl: 'https://horizon.example.com',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StellarRpcService health check', () => {
  beforeEach(() => {
    rpcProviderHealthyGauge.reset();
    rpcProviderHealthCheckFailuresTotal.reset();
  });

  it('marks the provider healthy using only the endpoint hostname as its label', async () => {
    const providerLabel = getRpcProviderLabelFromEndpoint(
      'https://api-key:secret@rpc.example.com:8443/path?token=query-secret',
    );
    const svc = new StellarRpcService(makeClient(async () => ({ sequence: 1 })), {
      healthCheckIntervalMs: 0,
      providerLabel,
    });

    svc.startHealthCheck(20);

    // Wait for the immediate probe + one interval tick.
    await new Promise((r) => setTimeout(r, 60));
    expect(svc.isProviderHealthy()).toBe(true);
    expect(svc.getProviderHealth().lastHealthyAt).not.toBeNull();
    const healthyMetric = await rpcProviderHealthyGauge.get();
    expect(healthyMetric.values).toContainEqual({
      labels: { provider: 'rpc.example.com' },
      value: 1,
    });
    svc.stopHealthCheck();
  });

  it('marks the provider unhealthy after consecutive failures', async () => {
    let attempts = 0;
    const svc = new StellarRpcService(
      makeClient(async () => {
        attempts += 1;
        throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      }),
      {
        healthCheckIntervalMs: 0,
        healthCheckFailureThreshold: 2,
        providerLabel: 'rpc.example.com',
      },
    );
    svc.startHealthCheck(20);

    // Immediate probe (fail #1) + one interval (fail #2) → unhealthy.
    await new Promise((r) => setTimeout(r, 60));
    expect(svc.isProviderHealthy()).toBe(false);
    expect(svc.getProviderHealth().consecutiveFailures).toBeGreaterThanOrEqual(2);
    const failuresMetric = await rpcProviderHealthCheckFailuresTotal.get();
    expect(
      failuresMetric.values.some(
        ({ labels }) => labels.provider === 'rpc.example.com' && labels.reason === 'NETWORK',
      ),
    ).toBe(true);
    svc.stopHealthCheck();
  });

  it('recovers to healthy after a successful probe following failures', async () => {
    let fail = true;
    const svc = new StellarRpcService(
      makeClient(async () => {
        if (fail) throw new Error('timeout');
        return { sequence: 9 };
      }),
      { healthCheckIntervalMs: 0, healthCheckFailureThreshold: 1 },
    );
    svc.startHealthCheck(20);
    await new Promise((r) => setTimeout(r, 40));
    expect(svc.isProviderHealthy()).toBe(false);

    // Flip the client to succeed; next probe must recover.
    fail = false;
    await new Promise((r) => setTimeout(r, 40));
    expect(svc.isProviderHealthy()).toBe(true);
    svc.stopHealthCheck();
  });

  it('does not start a loop when interval is 0', () => {
    const svc = new StellarRpcService(makeClient(async () => ({ sequence: 1 })), {
      healthCheckIntervalMs: 0,
    });
    svc.startHealthCheck(0);
    // No timer should be registered; health stays at its initial healthy state.
    expect(svc.isProviderHealthy()).toBe(true);
  });
});
