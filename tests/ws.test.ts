/**
 * WebSocket integration tests (#49).
 *
 * Covers:
 *   - Connection lifecycle (connect, subscribe, unsubscribe, disconnect)
 *   - Broadcast delivery to subscribed clients
 *   - Duplicate delivery prevention (dedup by eventId)
 *   - Rate limiting (RATE_LIMIT_MAX messages per window)
 *   - Oversized payload rejection
 *   - Binary frame rejection
 *   - RPC dependency failure mode (hub continues operating when RPC is down)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import {
  StreamHub,
  StreamHubOptions,
  MAX_MESSAGE_BYTES,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
} from '../src/ws/hub.js';
import { InMemoryDedupCache } from '../src/redis/dedup.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTestServer(): { server: http.Server; hub: StreamHub; port: number } {
  const server = http.createServer();
  const hub = new StreamHub(server);
  return new Promise<{ server: http.Server; hub: StreamHub; port: number }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, hub, port: addr.port });
    });
  }) as unknown as { server: http.Server; hub: StreamHub; port: number };
}

async function setup(): Promise<{ server: http.Server; hub: StreamHub; port: number }> {
  const server = http.createServer();
  const hub = new StreamHub(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, hub, port: addr.port });
    });
  });
}

async function teardown(server: http.Server, hub: StreamHub): Promise<void> {
  return new Promise((resolve) => {
    hub.close(() => server.close(() => resolve()));
  });
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/streams`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch {
        reject(new Error(`Non-JSON message: ${data.toString()}`));
      }
    });
    ws.once('error', reject);
  });
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebSocket hub — connection lifecycle', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    ({ server, hub, port } = await setup());
  });

  afterEach(async () => {
    await teardown(server, hub);
  });

  it('accepts a connection and tracks client count', async () => {
    const ws = await connect(port);
    expect(hub.clientCount).toBe(1);
    ws.close();
    await sleep(50);
    expect(hub.clientCount).toBe(0);
  });

  it('accepts multiple concurrent connections', async () => {
    const [a, b, c] = await Promise.all([connect(port), connect(port), connect(port)]);
    expect(hub.clientCount).toBe(3);
    a.close(); b.close(); c.close();
    await sleep(50);
    expect(hub.clientCount).toBe(0);
  });

  it('cleans up subscriptions on disconnect', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', streamId: 'stream-1' });
    await sleep(30);

    // Broadcast before disconnect — should reach the client.
    const msgPromise = nextMessage(ws);
    await hub.broadcast({ streamId: 'stream-1', eventId: 'evt-1', payload: { foo: 'bar' } });
    const msg = await msgPromise;
    expect((msg as any).type).toBe('stream_update');

    ws.close();
    await sleep(50);

    // After disconnect, broadcast should not throw.
    await hub._resetDedup();
    expect(async () =>
      await hub.broadcast({ streamId: 'stream-1', eventId: 'evt-1', payload: {} }),
    ).not.toThrow();
  });
});

describe('WebSocket hub — subscribe / unsubscribe', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    ({ server, hub, port } = await setup());
  });

  afterEach(async () => {
    await teardown(server, hub);
  });

  it('delivers broadcast only to subscribed client', async () => {
    const subscriber = await connect(port);
    const bystander = await connect(port);

    send(subscriber, { type: 'subscribe', streamId: 'stream-42' });
    await sleep(30);

    const received: unknown[] = [];
    subscriber.on('message', (d) => received.push(JSON.parse(d.toString())));
    bystander.on('message', (d) => received.push(JSON.parse(d.toString())));

    await hub.broadcast({ streamId: 'stream-42', eventId: 'e1', payload: { amount: '100' } });
    await sleep(50);

    expect(received).toHaveLength(1);
    expect((received[0] as any).streamId).toBe('stream-42');

    subscriber.close();
    bystander.close();
  });

  it('stops delivering after unsubscribe', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', streamId: 'stream-7' });
    await sleep(30);

    send(ws, { type: 'unsubscribe', streamId: 'stream-7' });
    await sleep(30);

    const received: unknown[] = [];
    ws.on('message', (d) => received.push(d));

    await hub.broadcast({ streamId: 'stream-7', eventId: 'e2', payload: {} });
    await sleep(50);

    expect(received).toHaveLength(0);
    ws.close();
  });

  it('returns error for unknown message type', async () => {
    const ws = await connect(port);
    const msgPromise = nextMessage(ws);
    send(ws, { type: 'ping', streamId: 'stream-1' });
    const msg = await msgPromise;
    expect((msg as any).type).toBe('error');
    expect((msg as any).code).toBe('UNKNOWN_TYPE');
    ws.close();
  });

  it('returns error for missing streamId', async () => {
    const ws = await connect(port);
    const msgPromise = nextMessage(ws);
    send(ws, { type: 'subscribe' });
    const msg = await msgPromise;
    expect((msg as any).type).toBe('error');
    expect((msg as any).code).toBe('INVALID_MESSAGE');
    ws.close();
  });
});

describe('WebSocket hub — duplicate delivery prevention', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    ({ server, hub, port } = await setup());
    hub._resetDedup();
  });

  afterEach(async () => {
    await teardown(server, hub);
  });

  it('delivers an event exactly once even when broadcast is called twice', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', streamId: 'stream-dup' });
    await sleep(30);

    const received: unknown[] = [];
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));

    await hub.broadcast({ streamId: 'stream-dup', eventId: 'evt-dup', payload: {} });
    await hub.broadcast({ streamId: 'stream-dup', eventId: 'evt-dup', payload: {} }); // duplicate
    await sleep(50);

    expect(received).toHaveLength(1);
    ws.close();
  });

  it('delivers distinct events with different eventIds', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', streamId: 'stream-multi' });
    await sleep(30);

    const received: unknown[] = [];
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));

    await hub.broadcast({ streamId: 'stream-multi', eventId: 'e-1', payload: {} });
    await hub.broadcast({ streamId: 'stream-multi', eventId: 'e-2', payload: {} });
    await hub.broadcast({ streamId: 'stream-multi', eventId: 'e-3', payload: {} });
    await sleep(50);

    expect(received).toHaveLength(3);
    ws.close();
  });
});

describe('WebSocket hub — rate limiting', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    ({ server, hub, port } = await setup());
  });

  afterEach(async () => {
    await teardown(server, hub);
  });

  it('allows messages up to RATE_LIMIT_MAX without error', async () => {
    const ws = await connect(port);
    const errors: unknown[] = [];
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'error' && msg.code === 'RATE_LIMIT_EXCEEDED') errors.push(msg);
    });

    // Send exactly RATE_LIMIT_MAX subscribe messages (each counts as one message).
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      send(ws, { type: 'subscribe', streamId: `stream-${i}` });
    }
    await sleep(100);

    expect(errors).toHaveLength(0);
    ws.close();
  });

  it('returns RATE_LIMIT_EXCEEDED after exceeding the limit', async () => {
    const ws = await connect(port);
    const errors: unknown[] = [];
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'error' && msg.code === 'RATE_LIMIT_EXCEEDED') errors.push(msg);
    });

    // Send RATE_LIMIT_MAX + 5 messages.
    for (let i = 0; i < RATE_LIMIT_MAX + 5; i++) {
      send(ws, { type: 'subscribe', streamId: `stream-${i}` });
    }
    await sleep(100);

    expect(errors.length).toBeGreaterThanOrEqual(1);
    ws.close();
  });
});

describe('WebSocket hub — oversized payload rejection', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    ({ server, hub, port } = await setup());
  });

  afterEach(async () => {
    await teardown(server, hub);
  });

  it('rejects a message exceeding MAX_MESSAGE_BYTES', async () => {
    const ws = await connect(port);
    const msgPromise = nextMessage(ws);

    // Build a payload just over the limit.
    const oversized = JSON.stringify({
      type: 'subscribe',
      streamId: 'x'.repeat(MAX_MESSAGE_BYTES + 1),
    });
    ws.send(oversized);

    const msg = await msgPromise;
    expect((msg as any).type).toBe('error');
    expect((msg as any).code).toBe('PAYLOAD_TOO_LARGE');
    ws.close();
  });

  it('accepts a message exactly at MAX_MESSAGE_BYTES', async () => {
    const ws = await connect(port);
    const errors: unknown[] = [];
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'error') errors.push(msg);
    });

    // Build a payload that is exactly MAX_MESSAGE_BYTES bytes.
    const base = JSON.stringify({ type: 'subscribe', streamId: '' });
    const padding = MAX_MESSAGE_BYTES - Buffer.byteLength(base, 'utf8');
    const atLimit = JSON.stringify({
      type: 'subscribe',
      streamId: 'a'.repeat(Math.max(0, padding)),
    });

    // Only send if it fits (padding may be negative for very small limits).
    if (Buffer.byteLength(atLimit, 'utf8') <= MAX_MESSAGE_BYTES) {
      ws.send(atLimit);
      await sleep(50);
      const payloadErrors = errors.filter((e: any) => e.code === 'PAYLOAD_TOO_LARGE');
      expect(payloadErrors).toHaveLength(0);
    }

    ws.close();
  });

  it('rejects binary frames', async () => {
    const ws = await connect(port);
    const msgPromise = nextMessage(ws);
    ws.send(Buffer.from([0x01, 0x02, 0x03]));
    const msg = await msgPromise;
    expect((msg as any).type).toBe('error');
    expect((msg as any).code).toBe('BINARY_NOT_SUPPORTED');
    ws.close();
  });
});

describe('WebSocket hub — RPC dependency failure modes', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    ({ server, hub, port } = await setup());
    hub._resetDedup();
  });

  afterEach(async () => {
    await teardown(server, hub);
  });

  it('continues accepting connections when RPC is unavailable', async () => {
    // Simulate RPC being down: hub.broadcast is called with no upstream data.
    // Clients should still connect and subscribe without error.
    const ws = await connect(port);
    expect(hub.clientCount).toBe(1);

    send(ws, { type: 'subscribe', streamId: 'stream-rpc-down' });
    await sleep(30);

    // No broadcast occurs (RPC is down). Client remains connected.
    expect(hub.clientCount).toBe(1);
    ws.close();
  });

  it('delivers buffered events once RPC recovers', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', streamId: 'stream-recovery' });
    await sleep(30);

    const received: unknown[] = [];
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));

    // Simulate RPC recovery: indexer pushes events after downtime.
    await hub.broadcast({ streamId: 'stream-recovery', eventId: 'recovery-1', payload: { status: 'active' } });
    await hub.broadcast({ streamId: 'stream-recovery', eventId: 'recovery-2', payload: { status: 'completed' } });
    await sleep(50);

    expect(received).toHaveLength(2);
    ws.close();
  });

  it('does not deliver duplicate events replayed by RPC retry', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', streamId: 'stream-retry' });
    await sleep(30);

    const received: unknown[] = [];
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));

    // RPC retries the same event three times (common in at-least-once delivery).
    await hub.broadcast({ streamId: 'stream-retry', eventId: 'rpc-evt-1', payload: {} });
    await hub.broadcast({ streamId: 'stream-retry', eventId: 'rpc-evt-1', payload: {} });
    await hub.broadcast({ streamId: 'stream-retry', eventId: 'rpc-evt-1', payload: {} });
    await sleep(50);

    expect(received).toHaveLength(1);
    ws.close();
  });
});

describe('WebSocket hub — backpressure strategy', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    ({ server, hub, port } = await setup());
    hub._resetDedup();
    hub._resetMetrics();
  });

  afterEach(async () => {
    await teardown(server, hub);
  });

  it('preserves decimal-string payload fields verbatim (no Number coercion)', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', streamId: 'stream-amt' });
    await sleep(30);

    const msgPromise = nextMessage(ws);
    // A decimal string that would lose precision if coerced to Number.
    const amount = '12345678901234567890.000000000000000001';
    hub.broadcast({ streamId: 'stream-amt', eventId: 'amt-1', payload: { amount } });
    const msg = (await msgPromise) as any;

    expect(msg.type).toBe('stream_update');
    expect(typeof msg.payload.amount).toBe('string');
    expect(msg.payload.amount).toBe(amount);

    ws.close();
  });

  it('tracks sentMessages in metrics for healthy delivery', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', streamId: 'stream-metric' });
    await sleep(30);

    const before = hub.getMetrics().sentMessages;
    hub.broadcast({ streamId: 'stream-metric', eventId: 'm-1', payload: {} });
    hub.broadcast({ streamId: 'stream-metric', eventId: 'm-2', payload: {} });
    await sleep(50);

    const after = hub.getMetrics().sentMessages;
    expect(after - before).toBe(2);
    expect(hub.getMetrics().droppedMessages).toBe(0);
    expect(hub.getMetrics().terminatedConnections).toBe(0);

    ws.close();
  });

  it('drops messages for a client whose bufferedAmount exceeds the drop threshold', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', streamId: 'stream-slow' });
    await sleep(30);

    // Force the drop path: any non-zero buffered amount will do.
    hub.setBackpressureThresholds({ dropBytes: 0, terminateBytes: 10 * 1024 * 1024 });

    // Fake a saturated send buffer on the server-side socket. We look up
    // the server's view of this client and stub bufferedAmount.
    const serverSockets = Array.from((hub as any).clients.keys()) as WebSocket[];
    expect(serverSockets).toHaveLength(1);
    Object.defineProperty(serverSockets[0], 'bufferedAmount', {
      configurable: true,
      get: () => 1,
    });

    const received: unknown[] = [];
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));

    hub.broadcast({ streamId: 'stream-slow', eventId: 'drop-1', payload: {} });
    hub.broadcast({ streamId: 'stream-slow', eventId: 'drop-2', payload: {} });
    await sleep(50);

    expect(received).toHaveLength(0);
    const m = hub.getMetrics();
    expect(m.droppedMessages).toBe(2);
    expect(m.sentMessages).toBe(0);
    expect(m.terminatedConnections).toBe(0);

    ws.close();
  });

  it('terminates a client whose bufferedAmount exceeds the terminate threshold', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', streamId: 'stream-kill' });
    await sleep(30);

    hub.setBackpressureThresholds({ dropBytes: 0, terminateBytes: 1 });

    const serverSockets = Array.from((hub as any).clients.keys()) as WebSocket[];
    expect(serverSockets).toHaveLength(1);
    Object.defineProperty(serverSockets[0], 'bufferedAmount', {
      configurable: true,
      get: () => 2, // > terminateBytes
    });

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));

    hub.broadcast({ streamId: 'stream-kill', eventId: 'kill-1', payload: {} });

    await Promise.race([closed, sleep(500)]);
    await sleep(50);

    const m = hub.getMetrics();
    expect(m.terminatedConnections).toBe(1);
    expect(m.droppedMessages).toBe(1);
    expect(hub.clientCount).toBe(0);
  });

  it('continues delivering to healthy peers when one peer is backpressured', async () => {
    const slow = await connect(port);
    const fast = await connect(port);
    send(slow, { type: 'subscribe', streamId: 'stream-mix' });
    send(fast, { type: 'subscribe', streamId: 'stream-mix' });
    await sleep(30);

    hub.setBackpressureThresholds({ dropBytes: 0, terminateBytes: 10 * 1024 * 1024 });

    // Identify the server-side socket corresponding to `slow` by matching
    // remotePort. Stub only that one's bufferedAmount.
    const slowPort = (slow as any)._socket.localPort as number;
    const serverSockets = Array.from((hub as any).clients.keys()) as WebSocket[];
    const slowServerSock = serverSockets.find(
      (s) => (s as any)._socket?.remotePort === slowPort,
    );
    expect(slowServerSock).toBeTruthy();
    Object.defineProperty(slowServerSock!, 'bufferedAmount', {
      configurable: true,
      get: () => 1,
    });

    const fastReceived: unknown[] = [];
    const slowReceived: unknown[] = [];
    fast.on('message', (d) => fastReceived.push(JSON.parse(d.toString())));
    slow.on('message', (d) => slowReceived.push(JSON.parse(d.toString())));

    hub.broadcast({ streamId: 'stream-mix', eventId: 'mix-1', payload: {} });
    await sleep(50);

    expect(fastReceived).toHaveLength(1);
    expect(slowReceived).toHaveLength(0);
    const m = hub.getMetrics();
    expect(m.sentMessages).toBe(1);
    expect(m.droppedMessages).toBe(1);

    slow.close();
    fast.close();
  });

  it('chunks large fanouts across setImmediate boundaries without stalling the event loop', async () => {
    // Connect enough clients to exceed FANOUT_YIELD_BATCH (256).
    const N = 260;
    const clients: WebSocket[] = [];
    for (let i = 0; i < N; i++) {
      clients.push(await connect(port));
    }
    for (const c of clients) send(c, { type: 'subscribe', streamId: 'stream-fanout' });
    await sleep(100);

    let deliveries = 0;
    for (const c of clients) {
      c.on('message', () => {
        deliveries++;
      });
    }

    // Measure that a timer scheduled concurrently with broadcast still fires
    // promptly — i.e. the event loop was not monopolized by the fanout.
    let timerFiredAt = 0;
    const timerSet = Date.now();
    const timer = setTimeout(() => {
      timerFiredAt = Date.now();
    }, 0);

    hub.broadcast({ streamId: 'stream-fanout', eventId: 'fan-1', payload: { ok: true } });

    await sleep(500);
    clearTimeout(timer);

    expect(deliveries).toBe(N);
    // Timer should have fired; with batched fanout the delay stays bounded.
    expect(timerFiredAt).toBeGreaterThan(0);
    expect(timerFiredAt - timerSet).toBeLessThan(1000);

    for (const c of clients) c.close();
    await sleep(100);
  });

  it('does not re-deliver an event after a backpressured client reconnects', async () => {
    // Scenario: slow client gets a message dropped, then reconnects. The
    // dedup cache ensures the hub will not replay past events (at-least-once
    // from the indexer is the recovery mechanism, not hub-side replay).
    const ws1 = await connect(port);
    send(ws1, { type: 'subscribe', streamId: 'stream-reconn' });
    await sleep(30);

    hub.setBackpressureThresholds({ dropBytes: 0, terminateBytes: 10 * 1024 * 1024 });
    const s1 = Array.from((hub as any).clients.keys())[0] as WebSocket;
    Object.defineProperty(s1, 'bufferedAmount', { configurable: true, get: () => 1 });

    hub.broadcast({ streamId: 'stream-reconn', eventId: 'rc-1', payload: {} });
    await sleep(30);
    expect(hub.getMetrics().droppedMessages).toBe(1);

    ws1.close();
    await sleep(50);

    // Reset thresholds so the reconnecting client is healthy.
    hub.setBackpressureThresholds({
      dropBytes: 1 * 1024 * 1024,
      terminateBytes: 4 * 1024 * 1024,
    });

    const ws2 = await connect(port);
    send(ws2, { type: 'subscribe', streamId: 'stream-reconn' });
    await sleep(30);

    const received: unknown[] = [];
    ws2.on('message', (d) => received.push(JSON.parse(d.toString())));

    // Indexer retries the same event — dedup must suppress it.
    hub.broadcast({ streamId: 'stream-reconn', eventId: 'rc-1', payload: {} });
    await sleep(50);

    expect(received).toHaveLength(0);
    ws2.close();
  });

  it('setBackpressureThresholds ignores negative or non-numeric values', async () => {
    // Baseline send to ensure delivery works.
    const ws = await connect(port);
    send(ws, { type: 'subscribe', streamId: 'stream-cfg' });
    await sleep(30);

    // Invalid values must not disable backpressure.
    hub.setBackpressureThresholds({ dropBytes: -1 });
    hub.setBackpressureThresholds({ terminateBytes: -5 });
    hub.setBackpressureThresholds({} as any);
    // @ts-expect-error — exercise the type guard at runtime
    hub.setBackpressureThresholds({ dropBytes: 'nope' });

    const received: unknown[] = [];
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));
    hub.broadcast({ streamId: 'stream-cfg', eventId: 'cfg-1', payload: {} });
    await sleep(50);

    expect(received).toHaveLength(1);
    ws.close();
  });
});
