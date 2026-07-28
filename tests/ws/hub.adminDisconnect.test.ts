import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { StreamHub } from '../../src/ws/hub.js';

function setup(): Promise<{ server: http.Server; hub: StreamHub; port: number }> {
  const server = http.createServer();
  const hub = new StreamHub(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, hub, port: address.port });
    });
  });
}

function teardown(server: http.Server, hub: StreamHub): Promise<void> {
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

function subscribe(ws: WebSocket, streamId: string): Promise<void> {
  return new Promise((resolve) => {
    ws.send(JSON.stringify({ type: 'subscribe', streamId }));
    setTimeout(resolve, 30);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

describe('StreamHub admin disconnect', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    ({ server, hub, port } = await setup());
  });

  afterEach(async () => {
    await teardown(server, hub);
  });

  it('force-closes sockets subscribed to a stream with the admin close code and reason', async () => {
    const streamA = await connect(port);
    const streamB = await connect(port);
    const bystander = await connect(port);

    await Promise.all([
      subscribe(streamA, 'stream-a'),
      subscribe(streamB, 'stream-a'),
      subscribe(bystander, 'stream-b'),
    ]);

    const closeA = waitForClose(streamA);
    const closeB = waitForClose(streamB);
    const bystanderClose = new Promise((resolve) => {
      let settled = false;
      bystander.once('close', () => {
        settled = true;
        resolve(true);
      });
      setTimeout(() => {
        if (!settled) resolve(false);
      }, 50);
    });

    expect(hub.disconnectByStreamId('stream-a')).toBe(2);

    await expect(closeA).resolves.toEqual({ code: 4000, reason: 'admin-forced-disconnect' });
    await expect(closeB).resolves.toEqual({ code: 4000, reason: 'admin-forced-disconnect' });
    await expect(bystanderClose).resolves.toBe(false);

    bystander.close();
  });

  it('returns zero when no sockets are subscribed to the stream', () => {
    expect(hub.disconnectByStreamId('missing-stream')).toBe(0);
  });
});
