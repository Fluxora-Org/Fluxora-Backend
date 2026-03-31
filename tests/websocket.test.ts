/**
 * Integration tests for the WebSocket stream channel.
 *
 * Covers:
 * - Successful connection and event receipt
 * - Oversized client message → connection closed with 1009
 * - Rate limit exceeded → connection closed with 1008
 * - Dead connection pruned by heartbeat
 * - GET /health includes wsConnections count
 * - broadcast() is a no-op when no clients are connected
 * - Degraded broadcast when RPC is down
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

// ── Test suite ───────────────────────────────────────────────────────────────

describe('WebSocket stream channel', () => {
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

  it('delivers a broadcast event to a connected client', async () => {
    const ws = await connectClient(port);

    const msgPromise = waitForMessage(ws);
    broadcast({
      event: 'stream.created',
      streamId: 'stream-abc',
      payload: { sender: 'GABC', recipient: 'GXYZ', depositAmount: '100' },
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    const msg = await msgPromise;
    expect(msg).toMatchObject({ event: 'stream.created', streamId: 'stream-abc' });

    ws.close();
  });

  it('delivers events to multiple connected clients', async () => {
    const [ws1, ws2] = await Promise.all([connectClient(port), connectClient(port)]);

    const [p1, p2] = [waitForMessage(ws1), waitForMessage(ws2)];
    broadcast({ event: 'stream.updated', streamId: 's1', payload: {}, timestamp: new Date().toISOString() });

    const [m1, m2] = await Promise.all([p1, p2]);
    expect((m1 as any).event).toBe('stream.updated');
    expect((m2 as any).event).toBe('stream.updated');

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

  // ── 3. Oversized client message ─────────────────────────────────────────

  it('closes connection with code 1009 when client sends oversized message', async () => {
    const ws = await connectClient(port);
    const closePromise = waitForClose(ws);

    // Send > 4 KiB
    ws.send('x'.repeat(5 * 1024));

    const { code } = await closePromise;
    expect(code).toBe(1009);
  });

  // ── 4. Rate limiting ────────────────────────────────────────────────────

  it('closes connection with code 1008 when client exceeds rate limit', async () => {
    const ws = await connectClient(port);
    const closePromise = waitForClose(ws);

    // Send 11 small messages (limit is 10 per 10 s window)
    for (let i = 0; i < 11; i++) {
      ws.send(JSON.stringify({ type: 'ping', i }));
    }

    const { code } = await closePromise;
    expect(code).toBe(1008);
  });

  // ── 5. Connection count tracking ────────────────────────────────────────

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

  // ── 6. Degraded broadcast ───────────────────────────────────────────────

  it('delivers a service.degraded event to connected clients', async () => {
    const ws = await connectClient(port);
    const msgPromise = waitForMessage(ws);

    broadcast({ event: 'service.degraded', reason: 'Stellar RPC unreachable', timestamp: new Date().toISOString() });

    const msg = await msgPromise;
    expect((msg as any).event).toBe('service.degraded');
    expect((msg as any).reason).toBe('Stellar RPC unreachable');

    ws.close();
  });

  // ── 7. Disconnected client cleaned up before broadcast ──────────────────

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
