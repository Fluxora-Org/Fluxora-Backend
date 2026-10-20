import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import {
  upgradeHandler,
  validateUpgradeRequest,
  parseUpgradeHeaders,
} from './upgradeHandler';

function makeReq(overrides: Partial<Record<string, unknown>> = {}): IncomingMessage {
  return {
    headers: {},
    url: '/',
    method: 'GET',
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    rawHeaders: [],
    socket: { remoteAddress: '127.0.0.1' } as unknown as Socket,
    complete: false,
    ...overrides,
  } as unknown as IncomingMessage;
}

function makeSocket() {
  const socket = {
    write: vi.fn(),
    destroy: vi.fn(),
    end: vi.fn(),
  };
  return socket as unknown as Socket;
}

describe('parseUpgradeHeaders', () => {
  it('returns an empty object for empty headers', () => {
    expect(parseUpgradeHeaders({})).toEqual({});
  });

  it('parses single-value headers and lowercases names', () => {
    const headers = parseUpgradeHeaders({
      Upgrade: 'websocket',
      Connection: 'Upgrade',
    });
    expect(headers).toEqual({ upgrade: 'websocket', connection: 'Upgrade' });
  });

  it('joins array values with commas', () => {
    const headers = parseUpgradeHeaders({ 'Sec-WebSocket-Protocol': ['chat', 'superchat'] });
    expect(headers['sec-websocket-protocol']).toBe('chat, superchat');
  });

  it('skips undefined values', () => {
    const headers = parseUpgradeHeaders({ Upgrade: undefined });
    expect(headers).toEqual({});
  });
});

describe('validateUpgradeRequest', () => {
  it('accepts a valid websocket upgrade request', () => {
    const req = makeReq({
      headers: { upgrade: 'websocket', connection: 'Upgrade' },
    });
    const result = validateUpgradeRequest(req);
    expect(result.ok).toBe(true);
  });

  it('rejects requests missing the upgrade header', () => {
    const req = makeReq({ headers: { connection: 'Upgrade' } });
    const result = validateUpgradeRequest(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('rejects requests missing the connection header', () => {
    const req = makeReq({ headers: { upgrade: 'websocket' } });
    const result = validateUpgradeRequest(req);
    expect(result.ok).toBe(false);
  });

  it('rejects a request with a non-websocket upgrade', () => {
    const req = makeReq({
      headers: { upgrade: 'h2c', connection: 'Upgrade' },
    });
    const result = validateUpgradeRequest(req);
    expect(result.ok).toBe(false);
  });

  it('rejects a request with an empty upgrade header', () => {
    const req = makeReq({ headers: { upgrade: '', connection: 'Upgrade' } });
    const result = validateUpgradeRequest(req);
    expect(result.ok).toBe(false);
  });

  it('accepts a connection header containing Upgrade among other tokens', () => {
    const req = makeReq({
      headers: { upgrade: 'websocket', connection: 'keep-alive, Upgrade' },
    });
    const result = validateUpgradeRequest(req);
    expect(result.ok).toBe(true);
  });
});

describe('upgradeHandler', () => {
  let socket: Socket;

  beforeEach(() => {
    socket = makeSocket();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a valid upgrade request without destroying the socket', () => {
    const req = makeReq({
      headers: { upgrade: 'websocket', connection: 'Upgrade' },
    });
    upgradeHandler(req, socket, Buffer.alloc(0));
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('rejects and destroys the socket for an invalid request', () => {
    const req = makeReq({ headers: {} });
    upgradeHandler(req, socket, Buffer.alloc(0));
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it('handles an empty head buffer', () => {
    const req = makeReq({ headers: {} });
    const head = Buffer.alloc(0);
    upgradeHandler(req, socket, head);
    expect(socket.destroy).toHaveBeenCalled();
  });
});
