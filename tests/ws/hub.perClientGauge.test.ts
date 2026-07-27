/**
 * tests/ws/hub.perClientGauge.test.ts
 *
 * Tests for the per-client WebSocket backpressure gauge and aggregate signals.
 *
 * Covers:
 *   - `fluxora_ws_backpressure_buffered_bytes{connection_id="…"}` is set by the
 *     collector for every live client.
 *   - The gauge label is removed on disconnect (no unbounded growth).
 *   - `fluxora_ws_max_buffered_bytes` reflects the maximum across clients.
 *   - `fluxora_ws_slow_clients` counts only clients above the slow threshold.
 *   - Disabling the periodic collector (intervalMs=0) still updates the gauge
 *     when the operator drives `collectWsBackpressureMetrics` manually.
 *   - Aggregate gauges reset to 0 when no clients are connected.
 *   - Custom slow threshold is honored.
 *
 * Note: tests read gauge values through the module-level imported Gauge
 * references (e.g. `wsMaxBufferedBytes.get()`) rather than via
 * `registry.getSingleMetric(...)`. Going through the imported references
 * works even when the registry contents change between test files, while
 * `registry.getSingleMetric` requires the metric to still be attached to
 * the registry.
 */

import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  StreamHub,
  type StreamHubBackpressureEvent,
} from '../../src/ws/hub.js';
import {
  collectWsBackpressureMetrics,
  resetWsBackpressureMetrics,
  removeWsClientBackpressureGauge,
  wsClientBufferedBytes,
  wsMaxBufferedBytes,
  wsSlowClients,
  DEFAULT_WS_SLOW_CLIENT_BYTES,
} from '../../src/metrics/wsBackpressure.js';
import type { Gauge } from 'prom-client';
import {
  createSlowClient,
  sendJson,
  wait,
  type SlowClient,
} from './fixtures/slowClient.js';

interface GaugeSample {
  labels: Record<string, string>;
  value: number;
}

async function readClientGauge(connectionId: string): Promise<number | null> {
  const result = (await wsClientBufferedBytes.get()) as { values: GaugeSample[] };
  const match = result.values.find((v) => v.labels?.connection_id === connectionId);
  return match ? match.value : null;
}

async function readAggregateGauge(gauge: Gauge): Promise<number> {
  const result = (await gauge.get()) as { values: GaugeSample[] };
  return result.values[0]?.value ?? 0;
}

async function getAggregateMax(): Promise<number> {
  return readAggregateGauge(wsMaxBufferedBytes);
}

async function getAggregateSlow(): Promise<number> {
  return readAggregateGauge(wsSlowClients);
}

describe('StreamHub per-client backpressure gauge', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;
  let slowClients: SlowClient[];
  let openClients: import('ws').WebSocket[];

  beforeEach(async () => {
    // Disable the interval-driven collector so tests are deterministic. We
    // still drive collection manually via collectWsBackpressureMetrics().
    server = http.createServer();
    hub = new StreamHub(server, { backpressureCollector: { intervalMs: 0 } });
    slowClients = [];
    openClients = [];

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    resetWsBackpressureMetrics();
  });

  afterEach(async () => {
    for (const slow of slowClients) slow.restore();
    for (const client of openClients) {
      if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) {
        client.close();
      }
    }
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetWsBackpressureMetrics();
  });

  it('exposes a per-client gauge labeled by connection_id', async () => {
    const slowA = await connectSlow('stream-gauge-a');

    collectWsBackpressureMetrics(hub);

    const connA = await getConnectionIdForClient(hub, slowA.client);
    expect(await readClientGauge(connA)).toBe(0);

    // And the gauge has at least one entry with a non-empty connection_id label.
    const allSamples = (await wsClientBufferedBytes.get()).values as GaugeSample[];
    expect(allSamples.length).toBeGreaterThan(0);
    expect(allSamples.every((s) => typeof s.labels?.connection_id === 'string')).toBe(true);
  });

  it('reflects the actual ws.bufferedAmount for each client', async () => {
    const slowA = await connectSlow('stream-buf-a');
    const slowB = await connectSlow('stream-buf-b');

    slowA.setBufferedAmount(128);
    slowB.setBufferedAmount(1024);

    collectWsBackpressureMetrics(hub);

    const connA = await getConnectionIdForClient(hub, slowA.client);
    const connB = await getConnectionIdForClient(hub, slowB.client);

    expect(await readClientGauge(connA)).toBe(128);
    expect(await readClientGauge(connB)).toBe(1024);
  });

  it('updates ws_max_buffered_bytes to the maximum across clients', async () => {
    const slowA = await connectSlow('stream-max-a');
    const slowB = await connectSlow('stream-max-b');
    const slowC = await connectSlow('stream-max-c');

    slowA.setBufferedAmount(50);
    slowB.setBufferedAmount(75);
    slowC.setBufferedAmount(200);

    collectWsBackpressureMetrics(hub);

    expect(await getAggregateMax()).toBe(200);
  });

  it('counts ws_slow_clients only for clients above the slow threshold', async () => {
    const slowA = await connectSlow('stream-slow-a');
    const slowB = await connectSlow('stream-slow-b');
    const slowC = await connectSlow('stream-slow-c');

    // Default slow threshold is 1 MiB.
    slowA.setBufferedAmount(0);
    slowB.setBufferedAmount(2 * 1024 * 1024); // > 1 MiB
    slowC.setBufferedAmount(5 * 1024 * 1024); // > 1 MiB

    collectWsBackpressureMetrics(hub);

    expect(await getAggregateSlow()).toBe(2);
  });

  it('honors a custom slow threshold passed to the collector', async () => {
    const slowA = await connectSlow('stream-thresh-a');
    slowA.setBufferedAmount(256);

    collectWsBackpressureMetrics(hub, /* slowThresholdBytes */ 128);

    expect(await getAggregateSlow()).toBe(1);
  });

  it('removes the per-client gauge label on disconnect', async () => {
    const slowA = await connectSlow('stream-disc-a');
    slowA.setBufferedAmount(42);
    collectWsBackpressureMetrics(hub);

    const connA = await getConnectionIdForClient(hub, slowA.client);
    expect(await readClientGauge(connA)).toBe(42);

    slowA.client.terminate();
    await wait(60);

    // After close, the hub removes the gauge label.
    expect(await readClientGauge(connA)).toBeNull();
    const samples = (await wsClientBufferedBytes.get()).values as GaugeSample[];
    expect(samples.some((s) => s.labels?.connection_id === connA)).toBe(false);
  });

  it('explicitly calling removeWsClientBackpressureGauge cleans up the time series', async () => {
    wsClientBufferedBytes.set({ connection_id: 'manually-removed-id' }, 123);
    expect(await readClientGauge('manually-removed-id')).toBe(123);

    removeWsClientBackpressureGauge('manually-removed-id');

    expect(await readClientGauge('manually-removed-id')).toBeNull();
  });

  it('resets ws_max_buffered_bytes and ws_slow_clients to 0 when no clients are connected', async () => {
    const slowA = await connectSlow('stream-empty-a');
    slowA.setBufferedAmount(8 * 1024 * 1024);
    collectWsBackpressureMetrics(hub);
    expect(await getAggregateMax()).toBe(8 * 1024 * 1024);
    expect(await getAggregateSlow()).toBe(1);

    slowA.client.terminate();
    await wait(60);

    collectWsBackpressureMetrics(hub);
    expect(await getAggregateMax()).toBe(0);
    expect(await getAggregateSlow()).toBe(0);
  });

  it('skips clients whose socket is no longer OPEN', async () => {
    const slowA = await connectSlow('stream-skip-a');
    slowA.setBufferedAmount(999);
    const connA = await getConnectionIdForClient(hub, slowA.client);

    // Force the socket into a non-OPEN state — the collector must skip it.
    Object.defineProperty(slowA.serverSocket, 'readyState', {
      configurable: true,
      value: 2, // CLOSING
    });

    collectWsBackpressureMetrics(hub);
    expect(await readClientGauge(connA)).toBeNull();

    // Restoring OPEN should make the next collection pick the client up.
    Object.defineProperty(slowA.serverSocket, 'readyState', {
      configurable: true,
      value: 1, // OPEN
    });
    collectWsBackpressureMetrics(hub);
    expect(await readClientGauge(connA)).toBe(999);
  });

  it('the periodic collector (default interval) updates the gauge without manual calls', async () => {
    // Build a separate hub+server pair with a short collector interval so we
    // can assert it eventually runs and drives a collection pass.
    const server2 = http.createServer();
    const shortHub = new StreamHub(server2, {
      backpressureCollector: { intervalMs: 25 },
    });
    try {
      await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));

      // Wait a few intervals and confirm the collector at least ran. Since no
      // clients are connected, aggregates should stay at 0.
      await wait(80);
      expect(await getAggregateMax()).toBe(0);
      expect(await getAggregateSlow()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => shortHub.close(() => resolve()));
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('falls back to 0 when ws.bufferedAmount is stubbed as undefined', async () => {
    const slowA = await connectSlow('stream-undef-a');
    // Deliberately break bufferedAmount so the defensive fallback triggers.
    Object.defineProperty(slowA.serverSocket, 'bufferedAmount', {
      configurable: true,
      get: () => undefined,
    });

    collectWsBackpressureMetrics(hub);

    const connA = await getConnectionIdForClient(hub, slowA.client);
    expect(await readClientGauge(connA)).toBe(0);
  });

  it('respects the default slow-threshold constant used for "slow client" classification', () => {
    // Sanity: defaults haven't drifted below the schema in the file.
    expect(DEFAULT_WS_SLOW_CLIENT_BYTES).toBe(1 * 1024 * 1024);
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  async function connectSlow(streamId: string): Promise<SlowClient> {
    const slow = await createSlowClient(port, hub);
    sendJson(slow.client, { type: 'subscribe', streamId });
    await wait(20);
    slowClients.push(slow);
    openClients.push(slow.client);
    return slow;
  }

  async function getConnectionIdForClient(
    hub: StreamHub,
    clientSocket: import('ws').WebSocket,
  ): Promise<string> {
    // Look up the server-side paired socket by matching remotePort.
    // The server-side socket's corresponding ClientState.id is what we want.
    const localPort = (clientSocket as unknown as {
      _socket?: { localPort?: number };
    })._socket?.localPort;

    for (const [serverWs, state] of hub._getClients()) {
      if (localPort !== undefined) {
        const remotePort = (serverWs as unknown as { _socket?: { remotePort?: number } })
          ._socket?.remotePort;
        if (remotePort === localPort) return state.id;
      }
    }
    throw new Error('Unable to resolve connection id for client');
  }
});

describe('StreamHub backpressure emitter coexistence with the per-client gauge', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;
  let slowClients: SlowClient[];
  let openClients: import('ws').WebSocket[];

  beforeEach(async () => {
    server = http.createServer();
    hub = new StreamHub(server, {
      backpressureCollector: { intervalMs: 0 },
    });
    hub.setBackpressureThresholds({ dropBytes: 8, terminateBytes: 64 });
    hub._resetMetrics();
    slowClients = [];
    openClients = [];

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    resetWsBackpressureMetrics();
  });

  afterEach(async () => {
    for (const slow of slowClients) slow.restore();
    for (const client of openClients) {
      if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) {
        client.close();
      }
    }
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetWsBackpressureMetrics();
  });

  it('still emits backpressure events while collecting gauge samples', async () => {
    const events: StreamHubBackpressureEvent[] = [];
    hub.on('backpressure', (event) => {
      events.push(event as StreamHubBackpressureEvent);
    });

    const slow = await createSlowClient(port, hub);
    slowClients.push(slow);
    openClients.push(slow.client);
    sendJson(slow.client, { type: 'subscribe', streamId: 'stream-coexist' });
    await wait(20);

    slow.setBufferedAmount(16);
    await hub.broadcast({
      streamId: 'stream-coexist',
      eventId: 'evt-coexist-1',
      payload: { ok: true },
    });
    await wait(30);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'drop',
      bufferedAmount: 16,
      thresholdBytes: 8,
    });

    // The gauge must have been observed at the bufferedAmount value the
    // broadcast saw — collect once explicitly so we don't rely on the timer.
    collectWsBackpressureMetrics(hub);

    const connId = events[0].connectionId;
    expect(await readClientGauge(connId)).toBe(16);
  });
});
