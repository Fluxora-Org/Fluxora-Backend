/**
 * tests/ws/hub.backpressure.test.ts
 *
 * Integration tests for StreamHub backpressure: drop, terminate, and
 * multi-client isolation.
 *
 * ## Why the streamRepository mock is here
 *
 * When a client sends `{ type: "subscribe", streamId: "…" }`, the hub calls
 * `authorizeSubscriptionFilter` which invokes `streamRepository.getById`.
 * In the test environment the PostgreSQL configuration is not initialised,
 * so the real repository throws a `ConfigError`.  We mock the module here to
 * return a stub stream whose `sender` matches the JWT subject so that the
 * authorization check passes without a real database connection.
 */

import http from 'http';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  BACKPRESSURE_DROP_BYTES,
  BACKPRESSURE_TERMINATE_BYTES,
  StreamHub,
  type StreamHubBackpressureEvent,
} from '../../src/ws/hub.js';
import {
  sendJson,
  wait,
  type SlowClient,
} from './fixtures/slowClient.js';

// ── Stub JWT credentials ───────────────────────────────────────────────────
const TEST_JWT_SECRET = 'backpressure-test-secret-32-chars!!';
const TEST_SUBJECT = 'sender-subject-backpressure-tests';

function makeToken(): string {
  return jwt.sign({ sub: TEST_SUBJECT }, TEST_JWT_SECRET);
}

// ── Mock streamRepository so getById never hits the database ───────────────
// NOTE: vi.mock factories are hoisted to the top of the file before any
// variable declarations, so TEST_SUBJECT cannot be referenced here.
// The literal 'sender-subject-backpressure-tests' must match TEST_SUBJECT.
vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById: vi.fn().mockResolvedValue({
      id: 'stream-mock',
      sender: 'sender-subject-backpressure-tests',
      recipient: 'other-recipient',
    }),
    upsertStream: vi.fn(),
    updateStream: vi.fn(),
  },
}));

// ── Slow-client factory that injects a Bearer token ───────────────────────

async function createAuthenticatedSlowClient(port: number, hub: StreamHub): Promise<SlowClient> {
  const token = makeToken();
  const { WebSocket: WS } = await import('ws');
  const clientWs = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:${port}/ws/streams`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.once('open', () => resolve(ws as unknown as WebSocket));
    ws.once('error', reject);
  });
  // Re-use `createSlowClient` by passing the already-connected socket —
  // instead, inline the minimal slow-client fixture logic here.
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

  const rawSocket = (serverSocket as unknown as { _socket?: { write?: (...a: unknown[]) => boolean; emit?: (e: string) => boolean } })._socket;
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
    simulatePartition() { /* no-op for these tests */ },
    restore,
    close() { restore(); clientWs.close(); },
  };
}

describe('StreamHub backpressure', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;
  let openClients: WebSocket[];
  let slowClients: SlowClient[];

  beforeEach(async () => {
    server = http.createServer();
    hub = new StreamHub(server, {
      jwtSecret: TEST_JWT_SECRET,
      backpressureCollector: { intervalMs: 0 },
    });
    hub._resetDedup();
    hub._resetMetrics();
    openClients = [];
    slowClients = [];

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    hub.setBackpressureThresholds({ dropBytes: 8, terminateBytes: 64 });
  });

  afterEach(async () => {
    for (const slowClient of slowClients) slowClient.restore();
    for (const client of openClients) {
      if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) {
        client.close();
      }
    }

    await new Promise<void>((resolve) => hub.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('emits a backpressure event and drops a message for a single slow client', async () => {
    const events = collectBackpressureEvents(hub);
    const slow = await trackSlow(createAuthenticatedSlowClient(port, hub));
    slow.subscribe('stream-slow');
    await wait(30);

    slow.setBufferedAmount(16);
    await hub.broadcast({ streamId: 'stream-slow', eventId: 'evt-drop-1', payload: { ok: true } });
    await wait(30);

    expect(slow.messages).toHaveLength(0);
    expect(events).toMatchObject([
      {
        action: 'drop',
        streamId: 'stream-slow',
        eventId: 'evt-drop-1',
        bufferedAmount: 16,
        thresholdBytes: 8,
      },
    ]);
    expect(events[0]?.connectionId).toEqual(expect.any(String));
    expect(events[0]?.timestamp).toEqual(expect.any(String));
    expect(hub.getMetrics()).toMatchObject({
      droppedMessages: 1,
      sentMessages: 0,
      terminatedConnections: 0,
    });
  });

  it('does not let one slow peer block delivery to a fast peer on the same stream', async () => {
    const slow = await trackSlow(createAuthenticatedSlowClient(port, hub));
    const fast = await track(connectClientWithAuth(port));
    const fastMessages: unknown[] = [];
    fast.on('message', (data) => fastMessages.push(JSON.parse(data.toString())));

    slow.subscribe('stream-mixed');
    sendJson(fast, { type: 'subscribe', streamId: 'stream-mixed' });
    await wait(30);

    slow.setBufferedAmount(16);
    await hub.broadcast({ streamId: 'stream-mixed', eventId: 'evt-mixed-1', payload: { value: 1 } });
    await wait(30);

    expect(slow.messages).toHaveLength(0);
    expect(fastMessages).toHaveLength(1);
    expect(fastMessages[0]).toMatchObject({
      type: 'stream_update',
      streamId: 'stream-mixed',
      eventId: 'evt-mixed-1',
    });
    expect(hub.getMetrics()).toMatchObject({
      droppedMessages: 1,
      sentMessages: 1,
      terminatedConnections: 0,
    });
  });

  it('accounts for multiple slow clients independently', async () => {
    const events = collectBackpressureEvents(hub);
    const [slowA, slowB] = await Promise.all([
      trackSlow(createAuthenticatedSlowClient(port, hub)),
      trackSlow(createAuthenticatedSlowClient(port, hub)),
    ]);

    slowA.subscribe('stream-many-slow');
    slowB.subscribe('stream-many-slow');
    await wait(30);

    slowA.setBufferedAmount(16);
    slowB.setBufferedAmount(32);
    await hub.broadcast({ streamId: 'stream-many-slow', eventId: 'evt-many-1', payload: {} });
    await wait(30);

    expect(slowA.messages).toHaveLength(0);
    expect(slowB.messages).toHaveLength(0);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.bufferedAmount).sort((a, b) => a - b)).toEqual([16, 32]);
    expect(hub.getMetrics()).toMatchObject({
      droppedMessages: 2,
      sentMessages: 0,
      terminatedConnections: 0,
    });
  });

  it('resumes delivery after a slow client drains below the drop threshold', async () => {
    const slow = await trackSlow(createAuthenticatedSlowClient(port, hub));
    slow.subscribe('stream-recovers');
    await wait(30);

    slow.setBufferedAmount(16);
    await hub.broadcast({ streamId: 'stream-recovers', eventId: 'evt-recovers-drop', payload: {} });
    await wait(30);

    slow.releaseDrain();
    await hub.broadcast({
      streamId: 'stream-recovers',
      eventId: 'evt-recovers-deliver',
      payload: { delivered: true },
    });
    await wait(30);

    expect(slow.messages).toHaveLength(1);
    expect(slow.messages[0]).toMatchObject({
      type: 'stream_update',
      eventId: 'evt-recovers-deliver',
      payload: { delivered: true },
    });
    expect(hub.getMetrics()).toMatchObject({
      droppedMessages: 1,
      sentMessages: 1,
      terminatedConnections: 0,
    });
  });

  it('terminates clients above the hard threshold and cleans them up', async () => {
    const events = collectBackpressureEvents(hub);
    const slow = await trackSlow(createAuthenticatedSlowClient(port, hub));
    slow.subscribe('stream-terminate');
    await wait(30);

    const closed = new Promise<void>((resolve) => slow.client.once('close', () => resolve()));
    slow.setBufferedAmount(128);
    await hub.broadcast({ streamId: 'stream-terminate', eventId: 'evt-term-1', payload: {} });
    await Promise.race([closed, wait(500)]);

    expect(events).toMatchObject([
      {
        action: 'terminate',
        streamId: 'stream-terminate',
        eventId: 'evt-term-1',
        bufferedAmount: 128,
        thresholdBytes: 64,
      },
    ]);
    expect(hub.getMetrics()).toMatchObject({
      droppedMessages: 1,
      sentMessages: 0,
      terminatedConnections: 1,
    });
    expect(hub.clientCount).toBe(0);
  });

  it('does not retain a slow disconnected client in later broadcasts', async () => {
    const slow = await trackSlow(createAuthenticatedSlowClient(port, hub));
    slow.subscribe('stream-disconnect');
    await wait(30);

    slow.setBufferedAmount(16);
    await hub.broadcast({ streamId: 'stream-disconnect', eventId: 'evt-before-disconnect', payload: {} });
    slow.client.terminate();
    await wait(50);

    await expect(
      hub.broadcast({ streamId: 'stream-disconnect', eventId: 'evt-after-disconnect', payload: {} }),
    ).resolves.toBeUndefined();
    expect(hub.clientCount).toBe(0);
    expect(hub.getMetrics().droppedMessages).toBe(1);
  });

  it('keeps default production thresholds above the test thresholds', () => {
    expect(BACKPRESSURE_DROP_BYTES).toBeGreaterThan(8);
    expect(BACKPRESSURE_TERMINATE_BYTES).toBeGreaterThan(BACKPRESSURE_DROP_BYTES);
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function connectClientWithAuth(p: number): Promise<WebSocket> {
    const token = makeToken();
    const { WebSocket: WS } = await import('ws');
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WS(`ws://127.0.0.1:${p}/ws/streams`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      ws.once('open', () => resolve(ws as unknown as WebSocket));
      ws.once('error', reject);
    });
  }

  async function track(clientPromise: Promise<WebSocket>): Promise<WebSocket> {
    const client = await clientPromise;
    openClients.push(client);
    return client;
  }

  async function trackSlow(clientPromise: Promise<SlowClient>): Promise<SlowClient> {
    const slowClient = await clientPromise;
    slowClients.push(slowClient);
    openClients.push(slowClient.client);
    return slowClient;
  }
});

function collectBackpressureEvents(hub: StreamHub): StreamHubBackpressureEvent[] {
  const events: StreamHubBackpressureEvent[] = [];
  hub.on('backpressure', (event) => {
    events.push(event as StreamHubBackpressureEvent);
  });
  return events;
}
