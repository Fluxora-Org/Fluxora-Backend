import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { StreamHub } from '../../src/ws/hub.js';
import { _resetLimiter } from '../../src/ws/connectionLimiter.js';

const SECRET = 'websocket-admission-test-secret';

function connect(port: number, options: { origin?: string; token?: string } = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/streams`, {
      ...(options.origin ? { headers: { Origin: options.origin } } : {}),
      ...(options.token ? { headers: { ...(options.origin ? { Origin: options.origin } : {}), Authorization: `Bearer ${options.token}` } } : {}),
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('WebSocket upgrade admission', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    server = http.createServer();
    hub = new StreamHub(server, {
      wsAuthRequired: true,
      jwtSecret: SECRET,
      allowedOrigins: ['https://app.example'],
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    _resetLimiter();
  });

  afterEach(async () => {
    _resetLimiter();
    await new Promise<void>((resolve) => hub.close(() => server.close(() => resolve())));
  });

  it('rejects missing, expired, and disallowed-origin upgrades before subscription', async () => {
    await expect(connect(port, { origin: 'https://app.example' })).rejects.toBeTruthy();

    const expired = jwt.sign({ sub: 'user-1' }, SECRET, { expiresIn: -1 });
    await expect(connect(port, { origin: 'https://app.example', token: expired })).rejects.toBeTruthy();
    const valid = jwt.sign({ sub: 'user-1' }, SECRET, { expiresIn: '5m' });
    await expect(connect(port, { origin: 'https://evil.example', token: valid })).rejects.toBeTruthy();
    expect(hub.clientCount).toBe(0);
  });

  it('accepts a refreshed valid token with an allowed origin', async () => {
    const refreshed = jwt.sign({ sub: 'user-1' }, SECRET, { expiresIn: '5m' });
    const ws = await connect(port, { origin: 'https://app.example', token: refreshed });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  // ── Scope matrix — exact, missing, malformed, expired, cross-tenant (#1266) ──

  it('rejects a malformed (non-JWT) token before upgrade', async () => {
    await expect(
      connect(port, { origin: 'https://app.example', token: 'not-a-jwt-at-all' }),
    ).rejects.toBeTruthy();
    expect(hub.clientCount).toBe(0);
  });

  it('rejects a token signed with a different (cross-tenant) secret before upgrade', async () => {
    const crossTenant = jwt.sign({ sub: 'user-1' }, 'another-tenant-secret', { expiresIn: '5m' });
    await expect(
      connect(port, { origin: 'https://app.example', token: crossTenant }),
    ).rejects.toBeTruthy();
    expect(hub.clientCount).toBe(0);
  });

  it('rejects an expired token even when the payload is otherwise valid', async () => {
    const expired = jwt.sign({ sub: 'user-1' }, SECRET, { expiresIn: -60 });
    await expect(
      connect(port, { origin: 'https://app.example', token: expired }),
    ).rejects.toBeTruthy();
    expect(hub.clientCount).toBe(0);
  });
});