/**
 * tests/ws/hub.metricsIntegration.test.ts
 *
 * Integration tests asserting that the WebSocket metric modules
 * (`wsBackpressure.ts`, `wsConnections.ts`, `wsHealth.ts`) faithfully reflect
 * the hub's actual runtime state.
 *
 * ## Acceptance criteria (issue #1430)
 *
 *   1. Queue depth reported by `fluxora_ws_backpressure_buffered_bytes` /
 *      `fluxora_ws_max_buffered_bytes` matches the hub's actual per-client
 *      outbound queue.
 *   2. Connection counts (`websocket_connections_active`) match the hub's
 *      client registry (`hub.clientCount`).
 *   3. Metrics update when a connection is dropped for backpressure.
 *   4. A test drives the hub end-to-end and asserts the published values.
 *
 * ## Why the streamRepository mock is here
 *
 * `authorizeSubscriptionFilter` calls `streamRepository.getById`, which
 * requires a live PostgreSQL connection.  We stub it to return a fixed stream
 * whose `sender_address` matches the JWT subject so auth passes without a DB.
 */

import http from 'node:http';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { StreamHub } from '../../src/ws/hub.js';
import {
  collectWsBackpressureMetrics,
  resetWsBackpressureMetrics,
  wsClientBufferedBytes,
  wsMaxBufferedBytes,
  wsSlowClients,
} from '../../src/metrics/wsBackpressure.js';
import {
  resetWsHealthMetrics,
  wsConnectionHealthTotal,
} from '../../src/metrics/wsHealth.js';
import {
  getActiveConnectionCount,
  _resetLimiter,
} from '../../src/ws/connectionLimiter.js';
import { createSlowClient, sendJson, wait, type SlowClient } from './fixtures/slowClient.js';

// ── JWT credentials ────────────────────────────────────────────────────────

const JWT_SECRET = 'metrics-integration-test-secret!!';
const JWT_SUBJECT = 'metrics-integration-sender-subject';

function makeToken(): string {
  return jwt.sign({ sub: JWT_SUBJECT }, JWT_SECRET);
}

// ── Mock streamRepository ──────────────────────────────────────────────────
// vi.mock factories are hoisted before variable declarations, so the literal
// string 'metrics-integration-sender-subject' must match JWT_SUBJECT above.

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById: vi.fn().mockResolvedValue({
      id: 'stream-metrics-mock',
      sender_address: 'metrics-integration-sender-subject',
      recipient_address: 'other-recipient',
    }),
    upsertStream: vi.fn(),
    updateStream: vi.fn(),
  },
}));

// ── Gauge helpers ──────────────────────────────────────────────────────────

interface GaugeSample {
  labels: Record<string, string>;
  value: number;
}

async function readPerClientBuffer(connectionId: string): Promise<number | undefined> {
  const result = (await wsClientBufferedBytes.get()) as unknown as { values: GaugeSample[] };
  const match = result.values.find((v) => v.labels?.connection_id === connectionId);
  return match?.value;
}

async function readMaxBuffered(): Promise<number> {
  const result = (await wsMaxBufferedBytes.get()) as unknown as { values: GaugeSample[] };
  return result.values[0]?.value ?? 0;
}

async function readSlowClients(): Promise<number> {
  const result = (await wsSlowClients.get()) as unknown as { values: GaugeSample[] };
  return result.values[0]?.value ?? 0;
}

async function readHealthStatus(status: string): Promise<number> {
  const result = (await wsConnectionHealthTotal.get()) as unknown as { values: GaugeSample[] };
  const match = result.values.find((v) => v.labels?.status === status);
  return match?.value ?? 0;
}

/** Resolve the hub-side connection_id for a connected slow client. */
function getConnectionId(hub: StreamHub, slow: SlowClient): string {
  const clients = (hub as unknown as { clients: Map<unknown, { id: string }> }).clients;
  for (const [ws, state] of clients) {
    if (ws === slow.serverSocket) return state.id;
  }
  throw new Error('Could not find connection_id for slow client');
}

/**
 * Create a slow client that connects with a valid JWT so the hub accepts it,
 * and wires a controlled `bufferedAmount` on the server-side socket so we can
 * trigger the backpressure drop/terminate paths deterministically.
 *
 * Mirrors the pattern in tests/ws/hub.backpressure.test.ts — must be called
 * AFTER the hub is listening.
 */
async function createAuthenticatedSlowClient(port: number, hub: StreamHub): Promise<SlowClient> {
  const token = makeToken();
  const clientWs = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/streams`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

  const localPort = (clientWs as unknown as { _socket?: { localPort?: number } })._socket?.localPort;
  if (typeof localPort !== 'number') throw new Error('Unable to read client socket localPort');

  const hubClients = (hub as unknown as { clients: Map<WebSocket, unknown> }).clients;
  const serverSocket = Array.from(hubClients.keys()).find((ws) => {
    return (ws as unknown as { _socket?: { remotePort?: number } })._socket?.remotePort === localPort;
  });
  if (!serverSocket) throw new Error(`Unable to find server WebSocket for client port ${localPort}`);

  const messages: unknown[] = [];
  let bufferedAmount = 0;

  clientWs.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
  });

  const origDescriptor = Object.getOwnPropertyDescriptor(serverSocket, 'bufferedAmount');
  Object.defineProperty(serverSocket, 'bufferedAmount', {
    configurable: true,
    get: () => bufferedAmount,
  });

  type RawSocket = { write?: (...a: unknown[]) => boolean; emit?: (e: string) => boolean };
  const rawSocket = (serverSocket as unknown as { _socket?: RawSocket })._socket;
  const originalWrite = rawSocket?.write?.bind(rawSocket);
  const queuedCallbacks: Array<() => void> = [];

  const restore = (): void => {
    if (rawSocket && originalWrite) rawSocket.write = originalWrite as typeof rawSocket.write;
    if (origDescriptor) Object.defineProperty(serverSocket, 'bufferedAmount', origDescriptor);
    else delete (serverSocket as { bufferedAmount?: number }).bufferedAmount;
  };

  if (rawSocket?.write) {
    rawSocket.write = ((...args: unknown[]): boolean => {
      const cb = args.find((a): a is () => void => typeof a === 'function');
      if (cb) queuedCallbacks.push(cb);
      return false;
    }) as typeof rawSocket.write;
  }

  return {
    client: clientWs,
    serverSocket,
    messages,
    subscribe(streamId: string) {
      sendJson(clientWs, { type: 'subscribe', streamId });
    },
    setBufferedAmount(bytes: number) { bufferedAmount = bytes; },
    getBufferedAmount() { return bufferedAmount; },
    releaseDrain() {
      bufferedAmount = 0;
      if (rawSocket && originalWrite) rawSocket.write = originalWrite as typeof rawSocket.write;
      for (const cb of queuedCallbacks.splice(0)) cb();
      rawSocket?.emit?.('drain');
    },
    simulatePartition() { /* not needed for these tests */ },
    restore,
    close() { restore(); clientWs.close(); },
  };
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('WebSocket metrics integration — hub state vs published gauges', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;
  const tracked: SlowClient[] = [];

  /** Small drop/terminate thresholds so tests never need to fill a real 1 MiB buffer. */
  const DROP_BYTES = 512;
  const TERMINATE_BYTES = 1_024;
  const SLOW_THRESHOLD = 256;

  beforeEach(async () => {
    server = http.createServer();
    hub = new StreamHub(server, {
      jwtSecret: JWT_SECRET,
      dropBytes: DROP_BYTES,
      terminateBytes: TERMINATE_BYTES,
      // Disable the periodic collector and the health-probe timer so every
      // assertion is driven deterministically by the test itself.
      backpressureCollector: { intervalMs: 0, slowThresholdBytes: SLOW_THRESHOLD },
      healthProbeIntervalMs: 0,
      healthProbeMaxMissed: 100,
      healthProbeStallBytes: SLOW_THRESHOLD,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    _resetLimiter();
    resetWsBackpressureMetrics();
    resetWsHealthMetrics();
  });

  afterEach(async () => {
    for (const slow of tracked.splice(0)) slow.close();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _resetLimiter();
    resetWsBackpressureMetrics();
    resetWsHealthMetrics();
  });

  // ── AC1: queue depth matches hub's actual queue ──────────────────────────

  describe('AC1 — queue depth reported matches the hub\'s actual per-client queue', () => {
    it('reports zero buffered bytes for a freshly connected client', async () => {
      const slow = await createSlowClient(port, hub);
      tracked.push(slow);

      const id = getConnectionId(hub, slow);

      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);

      expect(await readPerClientBuffer(id)).toBe(0);
      expect(await readMaxBuffered()).toBe(0);
      expect(await readSlowClients()).toBe(0);
    });

    it('mirrors a non-zero bufferedAmount set on the server socket', async () => {
      const slow = await createSlowClient(port, hub);
      tracked.push(slow);

      const id = getConnectionId(hub, slow);
      const fillBytes = 128;

      slow.setBufferedAmount(fillBytes);
      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);

      expect(await readPerClientBuffer(id)).toBe(fillBytes);
      expect(await readMaxBuffered()).toBe(fillBytes);
    });

    it('classifies a client above the slow threshold', async () => {
      const slow = await createSlowClient(port, hub);
      tracked.push(slow);

      slow.setBufferedAmount(SLOW_THRESHOLD + 1);
      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);

      expect(await readSlowClients()).toBe(1);
    });

    it('does not classify a client at exactly the slow threshold', async () => {
      const slow = await createSlowClient(port, hub);
      tracked.push(slow);

      slow.setBufferedAmount(SLOW_THRESHOLD);
      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);

      // Threshold is exclusive (> not >=), so exactly at threshold → not slow.
      expect(await readSlowClients()).toBe(0);
    });

    it('tracks max across multiple clients independently', async () => {
      const [slowA, slowB] = await Promise.all([
        createSlowClient(port, hub),
        createSlowClient(port, hub),
      ]);
      tracked.push(slowA, slowB);

      slowA.setBufferedAmount(100);
      slowB.setBufferedAmount(300);

      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);

      expect(await readMaxBuffered()).toBe(300);
      expect(await readSlowClients()).toBe(1); // only slowB exceeds threshold
    });

    it('resets to zero after all clients disconnect', async () => {
      const slow = await createSlowClient(port, hub);
      tracked.push(slow);

      slow.setBufferedAmount(200);
      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);
      expect(await readMaxBuffered()).toBeGreaterThan(0);

      slow.close();
      tracked.splice(tracked.indexOf(slow), 1);
      await wait(50);

      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);

      expect(await readMaxBuffered()).toBe(0);
      expect(await readSlowClients()).toBe(0);
    });
  });

  // ── AC2: connection counts match the hub's registry ──────────────────────

  describe('AC2 — connection counts match the hub\'s client registry', () => {
    it('active connection counter increments when a client connects', async () => {
      expect(hub.clientCount).toBe(0);
      expect(getActiveConnectionCount()).toBe(0);

      const slow = await createSlowClient(port, hub);
      tracked.push(slow);

      expect(hub.clientCount).toBe(1);
      expect(getActiveConnectionCount()).toBe(1);
    });

    it('active connection counter decrements when a client disconnects', async () => {
      const slow = await createSlowClient(port, hub);
      tracked.push(slow);

      expect(hub.clientCount).toBe(1);
      expect(getActiveConnectionCount()).toBe(1);

      slow.close();
      tracked.splice(tracked.indexOf(slow), 1);
      await wait(50);

      expect(hub.clientCount).toBe(0);
      expect(getActiveConnectionCount()).toBe(0);
    });

    it('tracks multiple concurrent connections', async () => {
      const [slowA, slowB, slowC] = await Promise.all([
        createSlowClient(port, hub),
        createSlowClient(port, hub),
        createSlowClient(port, hub),
      ]);
      tracked.push(slowA, slowB, slowC);

      expect(hub.clientCount).toBe(3);
      expect(getActiveConnectionCount()).toBe(3);
    });

    it('hub clientCount and connectionLimiter counter stay in sync across connect/disconnect cycles', async () => {
      const slowA = await createSlowClient(port, hub);
      tracked.push(slowA);
      expect(hub.clientCount).toBe(getActiveConnectionCount());

      const slowB = await createSlowClient(port, hub);
      tracked.push(slowB);
      expect(hub.clientCount).toBe(getActiveConnectionCount());

      slowA.close();
      tracked.splice(tracked.indexOf(slowA), 1);
      await wait(50);
      expect(hub.clientCount).toBe(getActiveConnectionCount());

      slowB.close();
      tracked.splice(tracked.indexOf(slowB), 1);
      await wait(50);
      expect(hub.clientCount).toBe(getActiveConnectionCount());
      expect(hub.clientCount).toBe(0);
    });
  });

  // ── AC3: metrics update when a connection is dropped for backpressure ────

  describe('AC3 — metrics update when a connection is dropped for backpressure', () => {
    it('hub drops frames and increments droppedMessages when client exceeds drop threshold', async () => {
      // Use an authenticated client so authorizeSubscriptionFilter passes and
      // the hub's subscribe path adds the socket to the stream index — only
      // subscribed sockets receive broadcasts, which is what triggers backpressure.
      const slow = await createAuthenticatedSlowClient(port, hub);
      tracked.push(slow);

      slow.subscribe('stream-drop');
      await wait(30); // let the subscribe message be processed

      // Fill above the drop threshold; the next broadcast should drop the frame.
      slow.setBufferedAmount(DROP_BYTES + 1);

      await hub.broadcast({ streamId: 'stream-drop', eventId: 'evt-1', payload: {} });
      await wait(20);

      const { droppedMessages } = hub.getMetrics();
      expect(droppedMessages).toBeGreaterThanOrEqual(1);
    });

    it('per-client gauge is removed after the connection is terminated for backpressure', async () => {
      const slow = await createAuthenticatedSlowClient(port, hub);
      tracked.push(slow);

      slow.subscribe('stream-terminate-gauge');
      await wait(30);

      const id = getConnectionId(hub, slow);

      // Confirm gauge is present before termination.
      slow.setBufferedAmount(100);
      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);
      expect(await readPerClientBuffer(id)).toBe(100);

      // Fill above the terminate threshold — the next broadcast calls
      // ws.terminate() then onDisconnect, which removes the gauge series.
      slow.setBufferedAmount(TERMINATE_BYTES + 1);

      await hub.broadcast({ streamId: 'stream-terminate-gauge', eventId: 'evt-2', payload: {} });
      await wait(20);

      // After termination the gauge label for this connection must be gone.
      expect(await readPerClientBuffer(id)).toBeUndefined();
      // And the hub's client registry should no longer contain the socket.
      expect(hub.clientCount).toBe(0);
      tracked.splice(tracked.indexOf(slow), 1);
    });

    it('terminatedConnections counter reflects the hub\'s actual termination count', async () => {
      const slow = await createAuthenticatedSlowClient(port, hub);
      tracked.push(slow);

      slow.subscribe('stream-term-metric');
      await wait(30);

      slow.setBufferedAmount(TERMINATE_BYTES + 1);

      await hub.broadcast({ streamId: 'stream-term-metric', eventId: 'evt-3', payload: {} });
      await wait(20);

      const { terminatedConnections } = hub.getMetrics();
      expect(terminatedConnections).toBe(1);

      tracked.splice(tracked.indexOf(slow), 1);
    });

    it('max buffered bytes gauge drops to zero after all connections are terminated', async () => {
      const slow = await createAuthenticatedSlowClient(port, hub);
      tracked.push(slow);

      slow.subscribe('stream-term-gauge');
      await wait(30);

      slow.setBufferedAmount(TERMINATE_BYTES + 1);
      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);
      expect(await readMaxBuffered()).toBeGreaterThan(0);

      // Broadcast triggers terminate → onDisconnect → gauge removal.
      await hub.broadcast({ streamId: 'stream-term-gauge', eventId: 'evt-4', payload: {} });
      await wait(20);

      // Collector now sees an empty client map → max resets to 0.
      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);
      expect(await readMaxBuffered()).toBe(0);

      tracked.splice(tracked.indexOf(slow), 1);
    });
  });

  // ── AC4: end-to-end hub drive with published-value assertions ───────────

  describe('AC4 — end-to-end: drive the hub and assert all published metric values', () => {
    it('full lifecycle: connect → fill queue → collect → disconnect → recollect', async () => {
      // ── Step 1: no connections ─────────────────────────────────────────
      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);
      hub._runHealthProbes();

      expect(hub.clientCount).toBe(0);
      expect(getActiveConnectionCount()).toBe(0);
      expect(await readMaxBuffered()).toBe(0);
      expect(await readSlowClients()).toBe(0);
      expect(await readHealthStatus('healthy')).toBe(0);

      // ── Step 2: connect a client ───────────────────────────────────────
      const slow = await createSlowClient(port, hub);
      tracked.push(slow);

      expect(hub.clientCount).toBe(1);
      expect(getActiveConnectionCount()).toBe(1);

      // ── Step 3: fill the queue above the slow threshold ───────────────
      slow.setBufferedAmount(SLOW_THRESHOLD + 50);
      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);

      expect(await readSlowClients()).toBe(1);
      expect(await readMaxBuffered()).toBe(SLOW_THRESHOLD + 50);

      // ── Step 4: health probe sees the connection as stalled ───────────
      hub._runHealthProbes();

      expect(await readHealthStatus('stalled')).toBe(1);
      expect(await readHealthStatus('healthy')).toBe(0);

      // ── Step 5: queue drains → connection becomes healthy again ───────
      slow.setBufferedAmount(0);
      hub._runHealthProbes();

      expect(await readHealthStatus('healthy')).toBe(1);
      expect(await readHealthStatus('stalled')).toBe(0);

      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);
      expect(await readMaxBuffered()).toBe(0);
      expect(await readSlowClients()).toBe(0);

      // ── Step 6: disconnect → all counters back to zero ────────────────
      slow.close();
      tracked.splice(tracked.indexOf(slow), 1);
      await wait(50);

      expect(hub.clientCount).toBe(0);
      expect(getActiveConnectionCount()).toBe(0);

      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);
      hub._runHealthProbes();

      expect(await readMaxBuffered()).toBe(0);
      expect(await readSlowClients()).toBe(0);
      expect(await readHealthStatus('healthy')).toBe(0);
      expect(await readHealthStatus('stalled')).toBe(0);
    });

    it('broadcast to a subscribed client increments sentMessages in hub metrics', async () => {
      const token = makeToken();
      const { WebSocket: WS } = await import('ws');
      const ws = await new Promise<import('ws').WebSocket>((resolve, reject) => {
        const w = new WS(`ws://127.0.0.1:${port}/ws/streams`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        w.once('open', () => resolve(w));
        w.once('error', reject);
      });
      // Wait for the hub to register the connection.
      await wait(20);

      const localPort = (ws as unknown as { _socket?: { localPort?: number } })._socket?.localPort;
      if (typeof localPort !== 'number') throw new Error('localPort not available');

      const hubClients = (hub as unknown as { clients: Map<import('ws').WebSocket, unknown> }).clients;
      const serverWs = Array.from(hubClients.keys()).find(
        (s) =>
          (s as unknown as { _socket?: { remotePort?: number } })._socket?.remotePort === localPort,
      );
      if (!serverWs) throw new Error('Server socket not found');

      // Subscribe to a stream (requires auth — JWT subject must match sender_address in mock).
      ws.send(JSON.stringify({ type: 'subscribe', streamId: 'stream-send-test' }));
      await wait(30);

      const beforeMetrics = hub.getMetrics();

      await hub.broadcast({ streamId: 'stream-send-test', eventId: 'evt-sent-1', payload: { x: 1 } });
      await wait(30);

      const afterMetrics = hub.getMetrics();
      expect(afterMetrics.sentMessages).toBeGreaterThan(beforeMetrics.sentMessages);

      // Connection count must still be 1.
      expect(hub.clientCount).toBe(1);
      expect(getActiveConnectionCount()).toBe(1);

      ws.close();
      await wait(50);
    });

    it('per-client gauge series is removed on normal disconnect (no label accumulation)', async () => {
      const slow = await createSlowClient(port, hub);
      tracked.push(slow);

      const id = getConnectionId(hub, slow);
      slow.setBufferedAmount(50);
      collectWsBackpressureMetrics(hub, SLOW_THRESHOLD);

      // Gauge series present while connected.
      expect(await readPerClientBuffer(id)).toBe(50);

      slow.close();
      tracked.splice(tracked.indexOf(slow), 1);
      await wait(50);

      // Series must be removed after normal disconnect.
      expect(await readPerClientBuffer(id)).toBeUndefined();
    });
  });
});
