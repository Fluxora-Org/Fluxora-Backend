import { describe, it, expect, afterEach, vi } from 'vitest';
import { StellarRpcService } from './stellar-rpc.js';
import { rpcProviderHealthyGauge, rpcProviderHealthCheckFailuresTotal } from '../metrics/rpcMetrics.js';

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
  it('marks the provider healthy after a successful probe', async () => {
    const svc = new StellarRpcService(makeClient(async () => ({ sequence: 1 })), {
      healthCheckIntervalMs: 0,
    });
    svc.startHealthCheck(20);

    // Wait for the immediate probe + one interval tick.
    await new Promise((r) => setTimeout(r, 60));
    expect(svc.isProviderHealthy()).toBe(true);
    expect(svc.getProviderHealth().lastHealthyAt).not.toBeNull();
    svc.stopHealthCheck();
  });

  it('marks the provider unhealthy after consecutive failures', async () => {
    let attempts = 0;
    const svc = new StellarRpcService(
      makeClient(async () => {
        attempts += 1;
        throw new Error('ECONNREFUSED');
      }),
      { healthCheckIntervalMs: 0, healthCheckFailureThreshold: 2 },
    );
    svc.startHealthCheck(20);

    // Immediate probe (fail #1) + one interval (fail #2) → unhealthy.
    await new Promise((r) => setTimeout(r, 60));
    expect(svc.isProviderHealthy()).toBe(false);
    expect(svc.getProviderHealth().consecutiveFailures).toBeGreaterThanOrEqual(2);
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
