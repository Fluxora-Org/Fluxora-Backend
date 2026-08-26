import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import net from 'net';
import { StreamHub } from '../../src/ws/hub.js';

function setup(options: any = {}): Promise<{ server: http.Server; hub: StreamHub; port: number }> {
  const server = http.createServer();
  const hub = new StreamHub(server, options);

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

function connectUnresponsive(port: number): Promise<net.Socket> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = 'dGhlIHNhbXBsZSBub25jZQ==';
      const req = `GET /ws/streams HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
      socket.write(req);
    });

    socket.once('data', (data) => {
      if (data.toString().includes('101 Switching Protocols')) {
        resolve(socket);
      }
    });
  });
}

describe('StreamHub health probes', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  afterEach(async () => {
    if (server && hub) {
      await teardown(server, hub);
    }
  });

  it('sends pings periodically to active clients and keeps them alive if they pong', async () => {
    ({ server, hub, port } = await setup({ healthProbeIntervalMs: 50, healthProbeMaxMissed: 2 }));
    const ws = await connect(port);
    let pingsReceived = 0;
    
    ws.on('ping', () => {
      pingsReceived++;
    });

    await new Promise((resolve) => setTimeout(resolve, 150)); // Should trigger 2 or 3 pings

    expect(pingsReceived).toBeGreaterThanOrEqual(2);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    ws.close();
  });

  it('terminates unresponsive clients after max missed pongs', async () => {
    ({ server, hub, port } = await setup({ healthProbeIntervalMs: 50, healthProbeMaxMissed: 2 }));
    const socket = await connectUnresponsive(port);
    
    let closed = false;
    socket.on('close', () => {
      closed = true;
    });

    // We configured it to terminate after 2 missed pongs (approx 100ms)
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(closed).toBe(true);
  });
});
