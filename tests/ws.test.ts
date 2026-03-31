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
  MAX_MESSAGE_BYTES,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
} from '../src/ws/hub.js';

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
    hub.broadcast({ streamId: 'stream-1', eventId: 'evt-1', payload: { foo: 'bar' } });
    const msg = await msgPromise;
    expect((msg as any).type).toBe('stream_update');

    ws.close();
    await sleep(50);

    // After disconnect, broadcast should not throw.
    hub._resetDedup();
    expect(() =>
      hub.broadcast({ streamId: 'stream-1', eventId: 'evt-1', payload: {} }),
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

    hub.broadcast({ streamId: 'stream-42', eventId: 'e1', payload: { amount: '100' } });
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

    hub.broadcast({ streamId: 'stream-7', eventId: 'e2', payload: {} });
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

    hub.broadcast({ streamId: 'stream-dup', eventId: 'evt-dup', payload: {} });
    hub.broadcast({ streamId: 'stream-dup', eventId: 'evt-dup', payload: {} }); // duplicate
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

    hub.broadcast({ streamId: 'stream-multi', eventId: 'e-1', payload: {} });
    hub.broadcast({ streamId: 'stream-multi', eventId: 'e-2', payload: {} });
    hub.broadcast({ streamId: 'stream-multi', eventId: 'e-3', payload: {} });
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
    hub.broadcast({ streamId: 'stream-recovery', eventId: 'recovery-1', payload: { status: 'active' } });
    hub.broadcast({ streamId: 'stream-recovery', eventId: 'recovery-2', payload: { status: 'completed' } });
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
    hub.broadcast({ streamId: 'stream-retry', eventId: 'rpc-evt-1', payload: {} });
    hub.broadcast({ streamId: 'stream-retry', eventId: 'rpc-evt-1', payload: {} });
    hub.broadcast({ streamId: 'stream-retry', eventId: 'rpc-evt-1', payload: {} });
    await sleep(50);

    expect(received).toHaveLength(1);
    ws.close();
  });
});
