import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { verifyWsToken } from '../middleware/tokenAuth.js';
import { checkAndReserve, getClientIp, untrackConnection } from './connectionLimiter.js';
import { attachUpgradeHandler, type UpgradeHandlerDeps } from './upgradeHandler.js';

vi.mock('../middleware/tokenAuth.js', () => ({
  verifyWsToken: vi.fn(),
}));

vi.mock('./connectionLimiter.js', () => ({
  checkAndReserve: vi.fn(),
  getClientIp: vi.fn(),
  untrackConnection: vi.fn(),
}));

const CLIENT_IP = '203.0.113.7';
const IDENTITY = 'user-1';
const WS_PATH = '/ws/streams';

function makeReq({
  url = WS_PATH,
  headers = {},
}: { url?: string; headers?: IncomingHttpHeaders } = {}): IncomingMessage {
  return {
    url,
    headers,
    method: 'GET',
    httpVersion: '1.1',
  } as unknown as IncomingMessage;
}

function makeSocket() {
  const emitter = new EventEmitter();
  const write = vi.fn();
  const destroy = vi.fn();
  const socket = Object.assign(emitter, { write, destroy }) as unknown as Duplex;

  return {
    socket,
    write,
    destroy,
    emitClose: () => emitter.emit('close'),
    closeListeners: () => emitter.listenerCount('close'),
  };
}

function makeWss() {
  const handleUpgrade = vi.fn();
  const emit = vi.fn();
  const wss = { handleUpgrade, emit } as unknown as WebSocketServer;
  return { wss, handleUpgrade, emit };
}

let server: Server;
let socket: ReturnType<typeof makeSocket>;
let wss: ReturnType<typeof makeWss>;

function attach(overrides: Partial<UpgradeHandlerDeps> = {}): void {
  const deps: UpgradeHandlerDeps = {
    wss: wss.wss,
    allowedOrigins: undefined,
    wsAuthRequired: false,
    jwtSecret: 'test-secret',
    ...overrides,
  };
  attachUpgradeHandler(server, deps);
}

function emitUpgrade(req: IncomingMessage, head = Buffer.alloc(0)): void {
  server.emit('upgrade', req, socket.socket, head);
}

async function expectRefusal(statusLine: string, body: string): Promise<void> {
  await vi.waitFor(() => expect(socket.write).toHaveBeenCalledOnce());
  const response = socket.write.mock.calls[0]?.[0] as string;
  expect(response).toContain(statusLine);
  expect(response).toContain(body);
  expect(socket.destroy).toHaveBeenCalledOnce();
}

describe('attachUpgradeHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    server = new EventEmitter() as unknown as Server;
    socket = makeSocket();
    wss = makeWss();

    vi.mocked(getClientIp).mockReturnValue(CLIENT_IP);
    vi.mocked(verifyWsToken).mockReturnValue({ ok: true, payload: { sub: IDENTITY } });
    vi.mocked(checkAndReserve).mockResolvedValue({ allowed: true });
  });

  it('ignores upgrades outside /ws/streams', () => {
    attach();
    emitUpgrade(makeReq({ url: '/health' }));

    expect(verifyWsToken).not.toHaveBeenCalled();
    expect(checkAndReserve).not.toHaveBeenCalled();
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('rejects a disallowed origin with 403 before auth or the limiter', async () => {
    attach({ allowedOrigins: new Set(['https://app.example.com']) });
    emitUpgrade(makeReq({ headers: { origin: 'https://evil.example' } }));

    await expectRefusal('HTTP/1.1 403 Forbidden', 'Forbidden origin');
    expect(verifyWsToken).not.toHaveBeenCalled();
    expect(checkAndReserve).not.toHaveBeenCalled();
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('accepts an allowlisted origin and emits the connection after upgrade', async () => {
    const origin = 'https://app.example.com';
    const req = makeReq({ headers: { origin } });
    const head = Buffer.from('early-bytes');
    const ws = {} as WebSocket;
    attach({ allowedOrigins: new Set([origin]), wsAuthRequired: true });

    emitUpgrade(req, head);
    await vi.waitFor(() => expect(wss.handleUpgrade).toHaveBeenCalledOnce());

    expect(verifyWsToken).toHaveBeenCalledWith(req, 'test-secret');
    expect(checkAndReserve).toHaveBeenCalledWith(CLIENT_IP, IDENTITY);
    expect(wss.handleUpgrade).toHaveBeenCalledWith(req, socket.socket, head, expect.any(Function));
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();

    const onUpgrade = wss.handleUpgrade.mock.calls[0]?.[3] as (ws: WebSocket) => void;
    onUpgrade(ws);
    expect(wss.emit).toHaveBeenCalledWith('connection', ws, req);
  });

  it('rejects a missing token with 401 when auth is required', async () => {
    vi.mocked(verifyWsToken).mockReturnValue({ ok: false, code: 'MISSING_TOKEN' });
    attach({ wsAuthRequired: true });
    emitUpgrade(makeReq());

    await expectRefusal('HTTP/1.1 401 Unauthorized', 'Unauthorized: MISSING_TOKEN');
    expect(checkAndReserve).not.toHaveBeenCalled();
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('rejects an over-limit reservation with 429 without upgrading', async () => {
    vi.mocked(checkAndReserve).mockResolvedValue({
      allowed: false,
      reason: 'Too many connections',
    });
    attach();
    emitUpgrade(makeReq());

    await expectRefusal('HTTP/1.1 429 Too Many Requests', 'Too many connections');
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
    expect(untrackConnection).not.toHaveBeenCalled();
  });

  it('uses the default 429 reason when the limiter omits one', async () => {
    vi.mocked(checkAndReserve).mockResolvedValue({ allowed: false });
    attach();
    emitUpgrade(makeReq());

    await expectRefusal('HTTP/1.1 429 Too Many Requests', 'Too many connections');
  });

  it('releases the reservation once when the socket closes before registration', async () => {
    attach();
    emitUpgrade(makeReq());
    await vi.waitFor(() => expect(wss.handleUpgrade).toHaveBeenCalledOnce());

    expect(socket.closeListeners()).toBe(1);
    socket.emitClose();
    socket.emitClose();

    expect(untrackConnection).toHaveBeenCalledOnce();
    expect(untrackConnection).toHaveBeenCalledWith(CLIENT_IP, IDENTITY);
    expect(socket.closeListeners()).toBe(0);
  });

  it('keeps the reservation after a completed upgrade', async () => {
    attach();
    emitUpgrade(makeReq());
    await vi.waitFor(() => expect(wss.handleUpgrade).toHaveBeenCalledOnce());

    const onUpgrade = wss.handleUpgrade.mock.calls[0]?.[3] as (ws: WebSocket) => void;
    onUpgrade({} as WebSocket);

    expect(socket.closeListeners()).toBe(0);
    socket.emitClose();
    expect(untrackConnection).not.toHaveBeenCalled();
  });
});
