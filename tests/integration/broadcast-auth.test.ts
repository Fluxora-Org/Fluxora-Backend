/**
 * Integration tests for broadcast authentication and access control.
 *
 * Covers the interplay between JWT auth, subscription filter authorization,
 * recipient-based broadcast delivery, and the WebSocket upgrade handshake.
 *
 * Edge-case semantics:
 * - streamId-based subscriptions bypass auth entirely (no recipient check)
 * - recipientAddress subscriptions require JWT sub matching the Stellar key
 * - Empty filters (no streamId, no recipientAddress) require JWT and auto-assign sub
 * - Unregistered clients are rejected with UNAUTHORIZED
 * - Broadcast with recipientAddress in event/payload only reaches that address's subscribers
 * - WS_AUTH_REQUIRED=true rejects unauthenticated upgrades before the WebSocket handshake
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { StreamHub, type StreamHubOptions, type StreamUpdateEvent } from '../../src/ws/hub.js';
import { verifyWsToken, type WsTokenPayload } from '../../src/middleware/tokenAuth.js';
import { _resetLimiter } from '../../src/ws/connectionLimiter.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STELLAR_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const ANOTHER_STELLAR_KEY = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';
const JWT_SECRET = 'test-jwt-secret-for-broadcast-auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestServer(
  options?: StreamHubOptions,
): Promise<{ server: http.Server; hub: StreamHub; port: number }> {
  const server = http.createServer();
  const hub = new StreamHub(server, options);
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

function connect(port: number, options?: { token?: string; path?: string }): Promise<WebSocket> {
  const path = options?.path ?? '/ws/streams';
  const query = options?.token ? `?token=${options.token}` : '';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}${query}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function connectWithAuth(port: number, token: string, path?: string): Promise<WebSocket> {
  return connect(port, { token, path });
}

async function connectExpectFail(port: number, options?: { token?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const query = options?.token ? `?token=${options.token}` : '';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/streams${query}`);
    ws.once('unexpected-response', (_req, res) => {
      ws.close();
      resolve(res.statusCode);
    });
    ws.once('error', () => {});
    setTimeout(() => reject(new Error('Connection did not fail within timeout')), 2000);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nextMessage timed out')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()));
      } catch {
        reject(new Error(`Non-JSON message: ${data.toString()}`));
      }
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

function signToken(payload: Partial<WsTokenPayload> & { sub: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function resetConnectionLimiter(): void {
  _resetLimiter();
}

// ---------------------------------------------------------------------------
// authorizeSubscriptionFilter — direct unit tests
// ---------------------------------------------------------------------------

describe('authorizeSubscriptionFilter unit semantics', () => {
  beforeEach(() => resetConnectionLimiter());

  it('rejects filter for unregistered client', () => {
    const server = http.createServer();
    const hub = new StreamHub(server, { jwtSecret: JWT_SECRET });
    const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
    const result = (hub as any).authorizeSubscriptionFilter(mockWs, { recipientAddress: VALID_STELLAR_KEY });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNAUTHORIZED');
    expect(result.message).toContain('not registered');
    server.close();
  });

  it('allows streamId filter without auth', () => {
    const server = http.createServer();
    const hub = new StreamHub(server, { jwtSecret: JWT_SECRET });
    const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
    (hub as any).clients.set(mockWs, {
      id: 'test-id',
      connectedAt: Date.now(),
      ip: '127.0.0.1',
      metrics: { messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0 },
      subscriptionFilters: new Map(),
      messageTimestamps: [],
    });

    const result = (hub as any).authorizeSubscriptionFilter(mockWs, { streamId: 'stream-123' });
    expect(result.ok).toBe(true);
    server.close();
  });

  it('rejects recipientAddress filter when client has no authenticated subject', () => {
    const server = http.createServer();
    const hub = new StreamHub(server, { jwtSecret: JWT_SECRET });
    const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
    (hub as any).clients.set(mockWs, {
      id: 'test-id',
      connectedAt: Date.now(),
      ip: '127.0.0.1',
      metrics: { messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0 },
      subscriptionFilters: new Map(),
      messageTimestamps: [],
    });

    const result = (hub as any).authorizeSubscriptionFilter(mockWs, { recipientAddress: VALID_STELLAR_KEY });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNAUTHORIZED');
    expect(result.message).toContain('require an authenticated Stellar public key subject');
    server.close();
  });

  it('rejects recipientAddress filter that does not match authenticated subject', () => {
    const server = http.createServer();
    const hub = new StreamHub(server, { jwtSecret: JWT_SECRET });
    const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
    (hub as any).clients.set(mockWs, {
      id: 'test-id',
      connectedAt: Date.now(),
      ip: '127.0.0.1',
      authenticatedSubject: VALID_STELLAR_KEY,
      metrics: { messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0 },
      subscriptionFilters: new Map(),
      messageTimestamps: [],
    });

    const result = (hub as any).authorizeSubscriptionFilter(mockWs, { recipientAddress: ANOTHER_STELLAR_KEY });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FORBIDDEN');
    expect(result.message).toContain('must match the authenticated subject');
    server.close();
  });

  it('allows recipientAddress filter that matches authenticated subject', () => {
    const server = http.createServer();
    const hub = new StreamHub(server, { jwtSecret: JWT_SECRET });
    const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
    (hub as any).clients.set(mockWs, {
      id: 'test-id',
      connectedAt: Date.now(),
      ip: '127.0.0.1',
      authenticatedSubject: VALID_STELLAR_KEY,
      metrics: { messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0 },
      subscriptionFilters: new Map(),
      messageTimestamps: [],
    });

    const result = (hub as any).authorizeSubscriptionFilter(mockWs, { recipientAddress: VALID_STELLAR_KEY });
    expect(result.ok).toBe(true);
    expect(result.filter.recipientAddress).toBe(VALID_STELLAR_KEY);
    server.close();
  });

  it('rejects empty filter (no streamId, no recipientAddress) without auth', () => {
    const server = http.createServer();
    const hub = new StreamHub(server, { jwtSecret: JWT_SECRET });
    const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
    (hub as any).clients.set(mockWs, {
      id: 'test-id',
      connectedAt: Date.now(),
      ip: '127.0.0.1',
      metrics: { messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0 },
      subscriptionFilters: new Map(),
      messageTimestamps: [],
    });

    const result = (hub as any).authorizeSubscriptionFilter(mockWs, {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNAUTHORIZED');
    expect(result.message).toContain('require an authenticated Stellar public key subject');
    server.close();
  });

  it('auto-assigns recipientAddress from authenticated subject for empty filter', () => {
    const server = http.createServer();
    const hub = new StreamHub(server, { jwtSecret: JWT_SECRET });
    const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
    (hub as any).clients.set(mockWs, {
      id: 'test-id',
      connectedAt: Date.now(),
      ip: '127.0.0.1',
      authenticatedSubject: VALID_STELLAR_KEY,
      metrics: { messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0 },
      subscriptionFilters: new Map(),
      messageTimestamps: [],
    });

    const result = (hub as any).authorizeSubscriptionFilter(mockWs, {});
    expect(result.ok).toBe(true);
    expect(result.filter.recipientAddress).toBe(VALID_STELLAR_KEY);
    server.close();
  });

  it('rejects empty filter when authenticated subject is not a valid Stellar key', () => {
    const server = http.createServer();
    const hub = new StreamHub(server, { jwtSecret: JWT_SECRET });
    const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
    (hub as any).clients.set(mockWs, {
      id: 'test-id',
      connectedAt: Date.now(),
      ip: '127.0.0.1',
      authenticatedSubject: 'not-a-valid-stellar-key',
      metrics: { messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0 },
      subscriptionFilters: new Map(),
      messageTimestamps: [],
    });

    const result = (hub as any).authorizeSubscriptionFilter(mockWs, {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNAUTHORIZED');
    server.close();
  });

  it('rejects recipientAddress filter when authenticated subject is not a valid Stellar key', () => {
    const server = http.createServer();
    const hub = new StreamHub(server, { jwtSecret: JWT_SECRET });
    const mockWs = { readyState: WebSocket.OPEN } as WebSocket;
    (hub as any).clients.set(mockWs, {
      id: 'test-id',
      connectedAt: Date.now(),
      ip: '127.0.0.1',
      authenticatedSubject: 'not-a-valid-stellar-key',
      metrics: { messagesReceived: 0, messagesSent: 0, bytesReceived: 0, bytesSent: 0 },
      subscriptionFilters: new Map(),
      messageTimestamps: [],
    });

    const result = (hub as any).authorizeSubscriptionFilter(mockWs, { recipientAddress: VALID_STELLAR_KEY });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNAUTHORIZED');
    server.close();
  });
});

// ---------------------------------------------------------------------------
// verifyWsToken — direct unit tests
// ---------------------------------------------------------------------------

describe('verifyWsToken edge cases', () => {
  it('returns AUTH_NOT_CONFIGURED when secret is undefined', () => {
    const req = { headers: {}, url: '/ws/streams' } as unknown as http.IncomingMessage;
    const result = verifyWsToken(req, undefined);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('AUTH_NOT_CONFIGURED');
  });

  it('returns MISSING_TOKEN when no auth header or query param', () => {
    const req = { headers: {}, url: '/ws/streams' } as unknown as http.IncomingMessage;
    const result = verifyWsToken(req, JWT_SECRET);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MISSING_TOKEN');
  });

  it('returns MISSING_TOKEN for Authorization header without Bearer scheme', () => {
    const req = {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
      url: '/ws/streams',
    } as unknown as http.IncomingMessage;
    const result = verifyWsToken(req, JWT_SECRET);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MISSING_TOKEN');
  });

  it('returns MISSING_TOKEN for empty Bearer token', () => {
    const req = {
      headers: { authorization: 'Bearer ' },
      url: '/ws/streams',
    } as unknown as http.IncomingMessage;
    const result = verifyWsToken(req, JWT_SECRET);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MISSING_TOKEN');
  });

  it('extracts token from Authorization header', () => {
    const token = signToken({ sub: VALID_STELLAR_KEY });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      url: '/ws/streams',
    } as unknown as http.IncomingMessage;
    const result = verifyWsToken(req, JWT_SECRET);
    expect(result.ok).toBe(true);
    expect((result as { ok: true; payload: WsTokenPayload }).payload.sub).toBe(VALID_STELLAR_KEY);
  });

  it('extracts token from query string when no auth header', () => {
    const token = signToken({ sub: VALID_STELLAR_KEY });
    const req = {
      headers: {},
      url: `/ws/streams?token=${token}`,
    } as unknown as http.IncomingMessage;
    const result = verifyWsToken(req, JWT_SECRET);
    expect(result.ok).toBe(true);
    expect((result as { ok: true; payload: WsTokenPayload }).payload.sub).toBe(VALID_STELLAR_KEY);
  });

  it('returns INVALID_TOKEN for expired JWT', () => {
    const token = jwt.sign({ sub: VALID_STELLAR_KEY }, JWT_SECRET, { expiresIn: '0s' });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      url: '/ws/streams',
    } as unknown as http.IncomingMessage;
    const result = verifyWsToken(req, JWT_SECRET);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_TOKEN');
  });

  it('returns INVALID_TOKEN for tampered JWT', () => {
    const token = signToken({ sub: VALID_STELLAR_KEY });
    const tampered = token.slice(0, -5) + 'XXXXX';
    const req = {
      headers: { authorization: `Bearer ${tampered}` },
      url: '/ws/streams',
    } as unknown as http.IncomingMessage;
    const result = verifyWsToken(req, JWT_SECRET);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_TOKEN');
  });

  it('returns INVALID_TOKEN for token signed with different secret', () => {
    const token = jwt.sign({ sub: VALID_STELLAR_KEY }, 'different-secret');
    const req = {
      headers: { authorization: `Bearer ${token}` },
      url: '/ws/streams',
    } as unknown as http.IncomingMessage;
    const result = verifyWsToken(req, JWT_SECRET);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_TOKEN');
  });

  it('prefers Authorization header over query param', () => {
    const headerToken = signToken({ sub: VALID_STELLAR_KEY });
    const queryToken = signToken({ sub: ANOTHER_STELLAR_KEY });
    const req = {
      headers: { authorization: `Bearer ${headerToken}` },
      url: `/ws/streams?token=${queryToken}`,
    } as unknown as http.IncomingMessage;
    const result = verifyWsToken(req, JWT_SECRET);
    expect(result.ok).toBe(true);
    expect((result as { ok: true; payload: WsTokenPayload }).payload.sub).toBe(VALID_STELLAR_KEY);
  });

  it('accepts token with missing sub claim', () => {
    const token = jwt.sign({ role: 'viewer' }, JWT_SECRET);
    const req = {
      headers: { authorization: `Bearer ${token}` },
      url: '/ws/streams',
    } as unknown as http.IncomingMessage;
    const result = verifyWsToken(req, JWT_SECRET);
    expect(result.ok).toBe(true);
    expect((result as { ok: true; payload: WsTokenPayload }).payload.sub).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WebSocket upgrade auth (WS_AUTH_REQUIRED)
// ---------------------------------------------------------------------------

describe('WebSocket upgrade authentication (WS_AUTH_REQUIRED)', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(() => resetConnectionLimiter());

  afterEach(async () => {
    await teardown(server, hub);
  });

  it('rejects upgrade with 401 when auth required and no token', async () => {
    ({ server, hub, port } = await createTestServer({
      wsAuthRequired: true,
      jwtSecret: JWT_SECRET,
    }));
    const statusCode = await connectExpectFail(port);
    expect(statusCode).toBe(401);
  });

  it('rejects upgrade with 401 when auth required and invalid token', async () => {
    ({ server, hub, port } = await createTestServer({
      wsAuthRequired: true,
      jwtSecret: JWT_SECRET,
    }));
    const statusCode = await connectExpectFail(port, { token: 'invalid-token' });
    expect(statusCode).toBe(401);
  });

  it('accepts upgrade when auth required and valid token provided', async () => {
    ({ server, hub, port } = await createTestServer({
      wsAuthRequired: true,
      jwtSecret: JWT_SECRET,
    }));
    const token = signToken({ sub: VALID_STELLAR_KEY });
    const ws = await connectWithAuth(port, token);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('accepts upgrade when auth disabled (WS_AUTH_REQUIRED=false) regardless of token', async () => {
    ({ server, hub, port } = await createTestServer({
      wsAuthRequired: false,
      jwtSecret: JWT_SECRET,
    }));
    const ws = await connect(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('accepts upgrade when auth disabled by default (wsAuthRequired not set)', async () => {
    ({ server, hub, port } = await createTestServer());
    const ws = await connect(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('extracts authenticated subject from valid token on upgrade', async () => {
    ({ server, hub, port } = await createTestServer({
      jwtSecret: JWT_SECRET,
      wsAuthRequired: true,
    }));
    const token = signToken({ sub: VALID_STELLAR_KEY });
    const ws = await connectWithAuth(port, token);

    send(ws, { type: 'subscribe', filter: {} });
    await new Promise((r) => setTimeout(r, 30));

    const pMsg = nextMessage(ws);

    hub.broadcast({
      recipientAddress: VALID_STELLAR_KEY,
      eventId: 'event-extract-1',
      payload: {},
    });

    const msg = await pMsg;
    expect(msg).toMatchObject({ type: 'stream_update', eventId: 'event-extract-1' });
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// Broadcast delivery with recipient address authorization
// ---------------------------------------------------------------------------

describe('broadcast delivery with recipient authorization', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    resetConnectionLimiter();
    ({ server, hub, port } = await createTestServer({ jwtSecret: JWT_SECRET }));
  });

  afterEach(async () => {
    await teardown(server, hub);
  });

  it('delivers broadcast only to recipient-matched subscribers', async () => {
    const tokenA = signToken({ sub: VALID_STELLAR_KEY });
    const tokenB = signToken({ sub: ANOTHER_STELLAR_KEY });

    const wsA = await connectWithAuth(port, tokenA);
    const wsB = await connectWithAuth(port, tokenB);

    send(wsA, { type: 'subscribe', recipient_address: VALID_STELLAR_KEY });
    await new Promise((r) => setTimeout(r, 30));

    send(wsB, { type: 'subscribe', recipient_address: ANOTHER_STELLAR_KEY });
    await new Promise((r) => setTimeout(r, 30));

    hub.broadcast({
      streamId: 'stream-1',
      eventId: 'event-1',
      payload: {},
      recipientAddress: VALID_STELLAR_KEY,
    });

    const receivedA = await nextMessage(wsA);
    expect(receivedA).toMatchObject({ type: 'stream_update', streamId: 'stream-1', eventId: 'event-1' });

    const wsBMessages: unknown[] = [];
    const onWsBMessage = (data: Buffer) => { wsBMessages.push(JSON.parse(data.toString())); };
    wsB.on('message', onWsBMessage);
    await new Promise((r) => setTimeout(r, 150));
    wsB.removeListener('message', onWsBMessage);
    expect(wsBMessages.length).toBe(0);

    wsA.close();
    wsB.close();
  });

  it('delivers broadcast to stream subscribers regardless of recipient', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', stream_id: 'stream-1' });
    await new Promise((r) => setTimeout(r, 30));

    hub.broadcast({
      streamId: 'stream-1',
      eventId: 'event-2',
      payload: { recipient_address: ANOTHER_STELLAR_KEY },
    });

    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: 'stream_update', streamId: 'stream-1', eventId: 'event-2' });
    ws.close();
  });

  it('delivers broadcast to both stream and recipient subscribers', async () => {
    const token = signToken({ sub: VALID_STELLAR_KEY });
    const wsRecipient = await connectWithAuth(port, token);
    const wsStream = await connect(port);

    send(wsRecipient, { type: 'subscribe', recipient_address: VALID_STELLAR_KEY });
    await new Promise((r) => setTimeout(r, 50));
    send(wsStream, { type: 'subscribe', stream_id: 'stream-1' });
    await new Promise((r) => setTimeout(r, 50));

    const pRecipient = nextMessage(wsRecipient);
    const pStream = nextMessage(wsStream);

    hub.broadcast({
      streamId: 'stream-1',
      eventId: 'event-3',
      payload: {},
      recipientAddress: VALID_STELLAR_KEY,
    });

    const [msgRecipient, msgStream] = await Promise.all([pRecipient, pStream]);
    expect(msgRecipient).toMatchObject({ type: 'stream_update', eventId: 'event-3' });
    expect(msgStream).toMatchObject({ type: 'stream_update', eventId: 'event-3' });

    wsRecipient.close();
    wsStream.close();
  });

  it('does not deliver broadcast to unsubscribed clients', async () => {
    const ws = await connect(port);
    const messages: unknown[] = [];
    ws.on('message', (data) => { messages.push(JSON.parse(data.toString())); });

    hub.broadcast({
      streamId: 'stream-1',
      eventId: 'event-4',
      payload: {},
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(messages.length).toBe(0);
    ws.close();
  });

  it('extracts recipientAddress from event payload fields', async () => {
    const token = signToken({ sub: VALID_STELLAR_KEY });
    const ws = await connectWithAuth(port, token);
    send(ws, { type: 'subscribe', recipient_address: VALID_STELLAR_KEY });
    await new Promise((r) => setTimeout(r, 30));

    hub.broadcast({
      streamId: 'stream-1',
      eventId: 'event-5',
      payload: { recipient_address: VALID_STELLAR_KEY },
    });

    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: 'stream_update', eventId: 'event-5' });
    ws.close();
  });

  it('extracts recipientAddress from payload.recipient field', async () => {
    const token = signToken({ sub: VALID_STELLAR_KEY });
    const ws = await connectWithAuth(port, token);
    send(ws, { type: 'subscribe', recipient_address: VALID_STELLAR_KEY });
    await new Promise((r) => setTimeout(r, 30));

    hub.broadcast({
      streamId: 'stream-1',
      eventId: 'event-6',
      payload: { recipient: VALID_STELLAR_KEY },
    });

    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: 'stream_update', eventId: 'event-6' });
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// Subscription authorization via WebSocket messages
// ---------------------------------------------------------------------------

describe('subscription authorization via WebSocket messages', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    resetConnectionLimiter();
    ({ server, hub, port } = await createTestServer({ jwtSecret: JWT_SECRET }));
  });

  afterEach(async () => {
    await teardown(server, hub);
  });

  it('rejects subscribe by recipientAddress when unauthenticated', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', recipient_address: VALID_STELLAR_KEY });
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({
      type: 'error',
      code: 'UNAUTHORIZED',
    });
    ws.close();
  });

  it('rejects subscribe by non-matching recipientAddress when authenticated', async () => {
    const token = signToken({ sub: VALID_STELLAR_KEY });
    const ws = await connectWithAuth(port, token);
    send(ws, { type: 'subscribe', recipient_address: ANOTHER_STELLAR_KEY });
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({
      type: 'error',
      code: 'FORBIDDEN',
    });
    ws.close();
  });

  it('allows subscribe by matching recipientAddress when authenticated', async () => {
    const token = signToken({ sub: VALID_STELLAR_KEY });
    const ws = await connectWithAuth(port, token);
    send(ws, { type: 'subscribe', recipient_address: VALID_STELLAR_KEY });
    await new Promise((r) => setTimeout(r, 30));

    hub.broadcast({
      streamId: 'stream-1',
      eventId: 'event-auth-1',
      payload: {},
      recipientAddress: VALID_STELLAR_KEY,
    });

    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: 'stream_update', eventId: 'event-auth-1' });
    ws.close();
  });

  it('allows subscribe by streamId without any auth', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', stream_id: 'stream-1' });
    await new Promise((r) => setTimeout(r, 30));

    hub.broadcast({
      streamId: 'stream-1',
      eventId: 'event-stream-1',
      payload: {},
    });

    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: 'stream_update', eventId: 'event-stream-1' });
    ws.close();
  });

  it('allows empty filter subscribe when authenticated (auto-assigns subject)', async () => {
    const token = signToken({ sub: VALID_STELLAR_KEY });
    const ws = await connectWithAuth(port, token);
    send(ws, { type: 'subscribe', filter: {} });
    await new Promise((r) => setTimeout(r, 30));

    hub.broadcast({
      streamId: 'stream-1',
      eventId: 'event-empty-1',
      payload: {},
      recipientAddress: VALID_STELLAR_KEY,
    });

    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: 'stream_update', eventId: 'event-empty-1' });
    ws.close();
  });

  it('rejects empty filter subscribe when unauthenticated', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', filter: {} });
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({
      type: 'error',
      code: 'UNAUTHORIZED',
    });
    ws.close();
  });

  it('handles unsubscribe gracefully', async () => {
    const token = signToken({ sub: VALID_STELLAR_KEY });
    const ws = await connectWithAuth(port, token);

    send(ws, { type: 'subscribe', recipient_address: VALID_STELLAR_KEY });
    await new Promise((r) => setTimeout(r, 30));

    send(ws, { type: 'unsubscribe', recipient_address: VALID_STELLAR_KEY });
    await new Promise((r) => setTimeout(r, 30));

    hub.broadcast({
      streamId: 'stream-1',
      eventId: 'event-after-unsub',
      payload: {},
      recipientAddress: VALID_STELLAR_KEY,
    });

    const messages: unknown[] = [];
    ws.on('message', (data) => { messages.push(JSON.parse(data.toString())); });
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.length).toBe(0);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// requireScope integration
// ---------------------------------------------------------------------------

describe('requireScope integration', () => {
  it('returns 401 when neither API key nor JWT auth is present', async () => {
    const { requireScope } = await import('../../src/middleware/auth.js');
    const mockReq = {
      correlationId: 'req-scope-1',
      path: '/test',
    } as any;
    const mockRes = {
      statusCode: 200,
      jsonBody: null,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.jsonBody = body; return this; },
    } as any;
    const next = vi.fn();

    requireScope('streams:read')(mockReq, mockRes, next);
    expect(mockRes.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when API key has empty scopes', async () => {
    const { requireScope } = await import('../../src/middleware/auth.js');
    const mockReq = {
      correlationId: 'req-scope-2',
      path: '/test',
      keyId: 'key-1',
      keyScopes: [],
    } as any;
    const mockRes = {
      statusCode: 200,
      jsonBody: null,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.jsonBody = body; return this; },
    } as any;
    const next = vi.fn();

    requireScope('streams:read')(mockReq, mockRes, next);
    expect(mockRes.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when JWT permissions do not include required scope', async () => {
    const { requireScope } = await import('../../src/middleware/auth.js');
    const mockReq = {
      correlationId: 'req-scope-3',
      path: '/test',
      user: { address: 'GABC', role: 'viewer', permissions: ['audit:read'] },
    } as any;
    const mockRes = {
      statusCode: 200,
      jsonBody: null,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.jsonBody = body; return this; },
    } as any;
    const next = vi.fn();

    requireScope('streams:write')(mockReq, mockRes, next);
    expect(mockRes.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows access when JWT permissions include at least one required scope', async () => {
    const { requireScope } = await import('../../src/middleware/auth.js');
    const mockReq = {
      correlationId: 'req-scope-4',
      path: '/test',
      user: { address: 'GABC', role: 'operator', permissions: ['streams:read', 'streams:write'] },
    } as any;
    const mockRes = {
      statusCode: 200,
      jsonBody: null,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.jsonBody = body; return this; },
    } as any;
    const next = vi.fn();

    requireScope('streams:read')(mockReq, mockRes, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows access when API key scopes include at least one required scope', async () => {
    const { requireScope } = await import('../../src/middleware/auth.js');
    const mockReq = {
      correlationId: 'req-scope-5',
      path: '/test',
      keyId: 'key-1',
      keyScopes: ['streams:read', 'dlq:list'],
    } as any;
    const mockRes = {
      statusCode: 200,
      jsonBody: null,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.jsonBody = body; return this; },
    } as any;
    const next = vi.fn();

    requireScope('dlq:list')(mockReq, mockRes, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows access with any-of matching for multiple required scopes', async () => {
    const { requireScope } = await import('../../src/middleware/auth.js');
    const mockReq = {
      correlationId: 'req-scope-6',
      path: '/test',
      keyId: 'key-1',
      keyScopes: ['streams:read'],
    } as any;
    const mockRes = {
      statusCode: 200,
      jsonBody: null,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.jsonBody = body; return this; },
    } as any;
    const next = vi.fn();

    requireScope('streams:write', 'streams:read')(mockReq, mockRes, next);
    expect(next).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Authenticate middleware — anonymous/malformed header edge cases
// ---------------------------------------------------------------------------

describe('authenticate middleware — header edge cases', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('proceeds as anonymous when Authorization header has no Bearer scheme', async () => {
    vi.doMock('../../src/lib/auth.js', () => ({
      verifyToken: vi.fn(),
    }));
    vi.doMock('../../src/redis/jwtRevocationStore.js', () => ({
      isRevoked: vi.fn(),
    }));

    const { authenticate } = await import('../../src/middleware/auth.js');
    const mockReq = {
      correlationId: 'req-hedge-1',
      headers: { authorization: 'Basic dGVzdDpwYXNz' },
    } as any;
    const mockRes = {
      statusCode: 200,
      jsonBody: null,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.jsonBody = body; return this; },
    } as any;
    const next = vi.fn();

    await authenticate(mockReq, mockRes, next);
    expect(next).toHaveBeenCalled();
    expect(mockReq.user).toBeUndefined();
  });

  it('proceeds as anonymous when Authorization header is absent', async () => {
    vi.doMock('../../src/lib/auth.js', () => ({
      verifyToken: vi.fn(),
    }));
    vi.doMock('../../src/redis/jwtRevocationStore.js', () => ({
      isRevoked: vi.fn(),
    }));

    const { authenticate } = await import('../../src/middleware/auth.js');
    const mockReq = {
      correlationId: 'req-hedge-2',
      headers: {},
    } as any;
    const mockRes = {
      statusCode: 200,
      jsonBody: null,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.jsonBody = body; return this; },
    } as any;
    const next = vi.fn();

    await authenticate(mockReq, mockRes, next);
    expect(next).toHaveBeenCalled();
    expect(mockReq.user).toBeUndefined();
  });

  it('proceeds as anonymous when Authorization is Bearer with whitespace-only token', async () => {
    vi.doMock('../../src/lib/auth.js', () => ({
      verifyToken: vi.fn(),
    }));
    vi.doMock('../../src/redis/jwtRevocationStore.js', () => ({
      isRevoked: vi.fn(),
    }));

    const { authenticate } = await import('../../src/middleware/auth.js');
    const mockReq = {
      correlationId: 'req-hedge-3',
      headers: { authorization: 'Bearer   ' },
    } as any;
    const mockRes = {
      statusCode: 200,
      jsonBody: null,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.jsonBody = body; return this; },
    } as any;
    const next = vi.fn();

    await authenticate(mockReq, mockRes, next);
    expect(next).toHaveBeenCalled();
    expect(mockReq.user).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: WS without auth still works
// ---------------------------------------------------------------------------

describe('backward compatibility — WS without auth', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    resetConnectionLimiter();
    ({ server, hub, port } = await createTestServer({
      wsAuthRequired: false,
    }));
  });

  afterEach(async () => {
    await teardown(server, hub);
  });

  it('unauthenticated client can subscribe by streamId and receive broadcasts', async () => {
    const ws = await connect(port);
    send(ws, { type: 'subscribe', stream_id: 'stream-bc-1' });
    await new Promise((r) => setTimeout(r, 30));

    hub.broadcast({
      streamId: 'stream-bc-1',
      eventId: 'event-bc-1',
      payload: { foo: 'bar' },
    });

    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({
      type: 'stream_update',
      streamId: 'stream-bc-1',
      eventId: 'event-bc-1',
      payload: { foo: 'bar' },
    });
    ws.close();
  });

  it('multiple unauthenticated clients all receive the same broadcast', async () => {
    const ws1 = await connect(port);
    const ws2 = await connect(port);
    send(ws1, { type: 'subscribe', stream_id: 'stream-bc-2' });
    send(ws2, { type: 'subscribe', stream_id: 'stream-bc-2' });
    await new Promise((r) => setTimeout(r, 30));

    hub.broadcast({
      streamId: 'stream-bc-2',
      eventId: 'event-bc-2',
      payload: {},
    });

    const msg1 = await nextMessage(ws1);
    const msg2 = await nextMessage(ws2);
    expect(msg1).toMatchObject({ eventId: 'event-bc-2' });
    expect(msg2).toMatchObject({ eventId: 'event-bc-2' });
    ws1.close();
    ws2.close();
  });
});