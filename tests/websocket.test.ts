/**
 * Integration tests for the WebSocket stream channel.
 *
 * Covers backward compatibility layer that delegates to StreamHub.
 *
 * Note: These tests verify that the deprecated streamChannel API still works
 * by delegating to StreamHub, which requires clients to subscribe.
 */

import { createServer } from 'http';
import { WebSocket } from 'ws';
import {
  attachWebSocketServer,
  broadcast,
  getConnectionCount,
  closeWebSocketServer,
} from '../src/websockets/streamChannel.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    ws.once('error', reject);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/streams`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function sendSubscribe(ws: WebSocket, streamId: string): void {
  ws.send(JSON.stringify({ type: 'subscribe', streamId }));
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('WebSocket stream channel (backward compatibility)', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    server = createServer();
    attachWebSocketServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    await closeWebSocketServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ── 1. Successful connection and event receipt ──────────────────────────

  it('delivers a broadcast event to a subscribed client', async () => {
    const ws = await connectClient(port);
    
    // Client must subscribe to receive messages
    sendSubscribe(ws, 'stream-abc');
    await sleep(30);

    const msgPromise = waitForMessage(ws);
    broadcast({
      event: 'stream.created',
      streamId: 'stream-abc',
      payload: { sender: 'GABC', recipient: 'GXYZ', depositAmount: '100' },
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    const msg = await msgPromise;
    expect((msg as any).type).toBe('stream_update');
    expect((msg as any).streamId).toBe('stream-abc');

    ws.close();
  });

  it('does not deliver events to unsubscribed clients', async () => {
    const ws = await connectClient(port);
    
    // Don't subscribe - client should not receive messages
    const received: unknown[] = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString())));
    
    broadcast({
      event: 'stream.created',
      streamId: 'stream-xyz',
      payload: { sender: 'GABC', recipient: 'GXYZ', depositAmount: '100' },
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    
    await sleep(50);
    expect(received).toHaveLength(0);
    
    ws.close();
  });

  it('delivers events to multiple subscribed clients', async () => {
    const [ws1, ws2] = await Promise.all([connectClient(port), connectClient(port)]);

    // Both clients subscribe
    sendSubscribe(ws1, 's1');
    sendSubscribe(ws2, 's1');
    await sleep(30);

    const [p1, p2] = [waitForMessage(ws1), waitForMessage(ws2)];
    broadcast({ event: 'stream.updated', streamId: 's1', payload: {}, timestamp: new Date().toISOString() });

    const [m1, m2] = await Promise.all([p1, p2]);
    expect((m1 as any).type).toBe('stream_update');
    expect((m2 as any).type).toBe('stream_update');

    ws1.close();
    ws2.close();
  });

  // ── 2. No-op when no clients ────────────────────────────────────────────

  it('broadcast is a no-op when no clients are connected', () => {
    expect(getConnectionCount()).toBe(0);
    expect(() =>
      broadcast({ event: 'stream.cancelled', streamId: 's0', payload: {}, timestamp: new Date().toISOString() })
    ).not.toThrow();
  });

  // ── 3. Connection count tracking ────────────────────────────────────────

  it('tracks connection count accurately', async () => {
    expect(getConnectionCount()).toBe(0);

    const ws1 = await connectClient(port);
    await sleep(20);
    expect(getConnectionCount()).toBe(1);

    const ws2 = await connectClient(port);
    await sleep(20);
    expect(getConnectionCount()).toBe(2);

    ws1.close();
    await sleep(50);
    expect(getConnectionCount()).toBe(1);

    ws2.close();
    await sleep(50);
    expect(getConnectionCount()).toBe(0);
  });

  // ── 4. Disconnected client cleaned up before broadcast ──────────────────

  it('does not throw when a client disconnects before broadcast completes', async () => {
    const ws = await connectClient(port);
    await sleep(20);

    // Terminate abruptly (no close handshake)
    ws.terminate();
    await sleep(50);

    expect(() =>
      broadcast({ event: 'stream.updated', streamId: 's2', payload: {}, timestamp: new Date().toISOString() })
    ).not.toThrow();
  });
});
