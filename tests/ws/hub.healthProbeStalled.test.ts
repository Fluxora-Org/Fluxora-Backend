/**
 * tests/ws/hub.healthProbeStalled.test.ts
 *
 * Regression tests for the actionable WebSocket health signal
 * (`fluxora_ws_connection_health_total`).
 *
 * The failure being driven: a connection whose socket is OPEN but whose
 * outbound queue is saturated (frames buffering faster than the peer drains
 * them, e.g. a network partition) must NOT be reported as healthy. It must be
 * reported as `status="stalled"` so operators can alert on it.
 *
 * The interval timer is disabled (`healthProbeIntervalMs: 0`) and the probe is
 * driven synchronously via `hub._runHealthProbes()` so assertions are
 * deterministic.
 */

import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StreamHub } from '../../src/ws/hub.js';
import {
  wsConnectionHealthTotal,
  resetWsHealthMetrics,
} from '../../src/metrics/wsHealth.js';
import { createSlowClient, type SlowClient } from './fixtures/slowClient.js';

const STALL_BYTES = 1_024;

interface GaugeSample {
  labels: Record<string, string>;
  value: number;
}

async function readStatus(status: string): Promise<number> {
  const result = (await wsConnectionHealthTotal.get()) as unknown as { values: GaugeSample[] };
  const match = result.values.find((v) => v.labels?.status === status);
  return match ? match.value : 0;
}

async function readStatuses(): Promise<string[]> {
  const result = (await wsConnectionHealthTotal.get()) as unknown as { values: GaugeSample[] };
  return result.values.map((v) => v.labels?.status).filter(Boolean) as string[];
}

describe('StreamHub health probe — stalled connections', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;
  let slowClients: SlowClient[];

  beforeEach(async () => {
    server = http.createServer();
    hub = new StreamHub(server, {
      // Disable the interval timer; drive the probe manually below.
      healthProbeIntervalMs: 0,
      healthProbeMaxMissed: 100,
      healthProbeStallBytes: STALL_BYTES,
      backpressureCollector: { intervalMs: 0 },
    });
    slowClients = [];

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    resetWsHealthMetrics();
  });

  afterEach(async () => {
    // Close the clients first so `wss.close()` can complete; otherwise the
    // callback never fires while a socket is still connected.
    for (const slow of slowClients) slow.close();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports an open connection with a saturated outbound queue as stalled, not healthy', async () => {
    const slow = await createSlowClient(port, hub);
    slowClients.push(slow);

    // Outbound queue above the stall threshold — the socket is OPEN but the
    // peer is not draining it (simulated network partition).
    slow.setBufferedAmount(STALL_BYTES * 4);

    hub._runHealthProbes();

    expect(await readStatus('stalled')).toBe(1);
    expect(await readStatus('healthy')).toBe(0);
    expect(await readStatus('unhealthy')).toBe(0);
  });

  it('keeps a draining connection healthy', async () => {
    const slow = await createSlowClient(port, hub);
    slowClients.push(slow);

    slow.setBufferedAmount(STALL_BYTES - 1);

    hub._runHealthProbes();

    expect(await readStatus('healthy')).toBe(1);
    expect(await readStatus('stalled')).toBe(0);
  });

  it('changes the published metric on the failure path and recovers when the queue drains', async () => {
    const slow = await createSlowClient(port, hub);
    slowClients.push(slow);

    slow.setBufferedAmount(STALL_BYTES + 1);
    hub._runHealthProbes();
    expect(await readStatus('stalled')).toBe(1);
    expect(await readStatus('healthy')).toBe(0);

    // Queue drains: the same still-open connection must flip back to healthy.
    slow.setBufferedAmount(0);
    hub._runHealthProbes();
    expect(await readStatus('stalled')).toBe(0);
    expect(await readStatus('healthy')).toBe(1);
  });

  it('keeps the status label cardinality bounded to the closed set', async () => {
    const slow = await createSlowClient(port, hub);
    slowClients.push(slow);

    slow.setBufferedAmount(STALL_BYTES * 2);
    hub._runHealthProbes();

    const statuses = await readStatuses();
    for (const status of statuses) {
      expect(['healthy', 'stalled', 'unhealthy']).toContain(status);
    }
    expect(statuses.length).toBeLessThanOrEqual(3);
  });
});
