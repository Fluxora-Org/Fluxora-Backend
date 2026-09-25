import http from 'node:http';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { getConfig, initializeConfig, resetConfig } from '../../src/config/env.js';
import { registry } from '../../src/metrics.js';
import { StreamHub, type StreamHubOptions } from '../../src/ws/hub.js';
import {
  getMaxInboundMessageBytes,
  parseWsClientMessage,
  validateWebSocketMessage,
} from '../../src/ws/messageHandler.js';

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById: vi.fn().mockResolvedValue({
      id: 'stream-resource-limit',
      sender_address: 'sender-subject',
      recipient_address: 'other-recipient',
    }),
    upsertStream: vi.fn(),
    updateStream: vi.fn(),
  },
}));

const JWT_SECRET = 'resource-limit-test-secret';
const JWT_SUBJECT = 'sender-subject';

type TestHubInternals = {
  clients: Map<string, { subscriptionFilters: Map<string, unknown> }>;
  streamSubscriptions: Map<string, Set<WebSocket>>;
  outboundQueues: Map<WebSocket, string[]>;
  queueOutboundMessage(ws: WebSocket, message: string): boolean;
};

function getHubInternals(hub: StreamHub): TestHubInternals {
  return hub as unknown as TestHubInternals;
}

function makeToken(): string {
  return jwt.sign({ sub: JWT_SUBJECT }, JWT_SECRET);
}

async function createHub(overrides: Partial<StreamHubOptions> = {}) {
  const server = http.createServer();
  const hub = new StreamHub(server, {
    jwtSecret: JWT_SECRET,
    dropBytes: 0,
    terminateBytes: 1,
    maxSubscriptionsPerConnection: 2,
    maxOutboundQueuePerConnection: 2,
    maxOutboundQueueBytesPerConnection: 1024 * 1024,
    maxInboundMessageBytes: 32,
    ...overrides,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return { server, hub, port };
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/streams`, {
      headers: { Authorization: `Bearer ${makeToken()}` },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('StreamHub resource limits', () => {
  let server: http.Server | undefined;
  let hub: StreamHub | undefined;

  afterEach(async () => {
    if (hub) {
      await new Promise<void>((resolve) => hub!.close(() => resolve()));
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('bounds per-connection subscription count without growing without limit', async () => {
    const created = await createHub({ maxInboundMessageBytes: 256 });
    server = created.server;
    hub = created.hub;
    const port = (server.address() as { port: number }).port;
    const ws = await connect(port);

    try {
      for (let i = 0; i < 5; i += 1) {
        ws.send(JSON.stringify({ type: 'subscribe', stream_id: `stream-${i}` }));
      }
      await wait(75);

      const internals = getHubInternals(hub);
      const clientState = [...internals.clients.values()][0];
      expect(clientState?.subscriptionFilters.size).toBe(2);
      const totals = [...internals.streamSubscriptions.values()].reduce((sum, set) => sum + set.size, 0);
      expect(totals).toBe(2);
    } finally {
      ws.close();
    }
  });

  it('registers configured resource limit gauges in the application registry', async () => {
    const created = await createHub();
    server = created.server;
    hub = created.hub;

    expect(registry.getSingleMetric('fluxora_ws_max_subscriptions_per_connection')).toBeDefined();
    expect(registry.getSingleMetric('fluxora_ws_max_outbound_queue_per_connection')).toBeDefined();
    expect(registry.getSingleMetric('fluxora_ws_max_outbound_queue_bytes_per_connection')).toBeDefined();
    expect(registry.getSingleMetric('fluxora_ws_max_inbound_message_bytes')).toBeDefined();
  });

  it('drops the newest queued outbound message once the per-connection queue is full', async () => {
    const created = await createHub();
    server = created.server;
    hub = created.hub;
    const port = (server.address() as { port: number }).port;
    const ws = await connect(port);
    Object.defineProperty(ws, 'bufferedAmount', {
      configurable: true,
      get: () => 1,
    });

    const internals = getHubInternals(hub);
    const queued1 = internals.queueOutboundMessage(ws, 'msg-1');
    const queued2 = internals.queueOutboundMessage(ws, 'msg-2');
    const queued3 = internals.queueOutboundMessage(ws, 'msg-3');

    expect(queued1).toBe(true);
    expect(queued2).toBe(true);
    expect(queued3).toBe(false);

    const queue = internals.outboundQueues.get(ws);
    expect(queue).toHaveLength(2);
    expect(queue).toEqual(['msg-1', 'msg-2']);

    ws.close();
  });

  it('bounds queued outbound bytes and rejects newest messages that exceed the byte cap', async () => {
    const created = await createHub({
      maxOutboundQueuePerConnection: 3,
      maxOutboundQueueBytesPerConnection: 10,
    });
    server = created.server;
    hub = created.hub;
    const ws = await connect(created.port);
    Object.defineProperty(ws, 'bufferedAmount', {
      configurable: true,
      get: () => 1,
    });

    const internals = getHubInternals(hub);
    expect(internals.queueOutboundMessage(ws, '123456')).toBe(true);
    expect(internals.queueOutboundMessage(ws, '78901')).toBe(false);
    expect(internals.outboundQueues.get(ws)).toEqual(['123456']);

    ws.close();
  });

  it('enforces the inbound limit in transport bytes at the exact limit and one byte over', async () => {
    const created = await createHub();
    server = created.server;
    hub = created.hub;
    const port = (server.address() as { port: number }).port;
    const ws = await connect(port);
    const exactLimitPayload = 'é'.repeat(16);
    const exactLimitMessage = new Promise<unknown>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    ws.send(exactLimitPayload);
    await expect(exactLimitMessage).resolves.toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' });
    expect(Buffer.byteLength(exactLimitPayload, 'utf8')).toBe(32);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    const close = new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
    });
    const oneByteOverPayload = `${exactLimitPayload}a`;
    expect(oneByteOverPayload.length).toBeLessThan(32);
    expect(Buffer.byteLength(oneByteOverPayload, 'utf8')).toBe(33);
    ws.send(oneByteOverPayload);

    await expect(close).resolves.toBe(1009);

    ws.close();
  });

  it('rejects multibyte control messages by UTF-8 byte length in the parser', () => {
    const maxBytes = getMaxInboundMessageBytes();
    const emptyMessage = JSON.stringify({ type: 'unsupported', value: '' });
    const repeats = Math.floor((maxBytes - emptyMessage.length) / 2) + 1;
    const message = { type: 'unsupported', value: 'é'.repeat(repeats) };
    const serialized = JSON.stringify(message);

    expect(serialized.length).toBeLessThanOrEqual(maxBytes);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(maxBytes);
    expect(parseWsClientMessage(message)).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
  });

  it('shares the configured inbound limit in a standalone, uninitialized hub', async () => {
    const previousLimit = process.env.WS_MAX_INBOUND_MESSAGE_BYTES;
    process.env.WS_MAX_INBOUND_MESSAGE_BYTES = '8192';
    resetConfig();

    try {
      expect(() => getConfig()).toThrow();

      server = http.createServer();
      hub = new StreamHub(server, {
        jwtSecret: JWT_SECRET,
        maxSubscriptionsPerConnection: 2,
        maxOutboundQueuePerConnection: 2,
        maxOutboundQueueBytesPerConnection: 1024 * 1024,
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));

      const configuredLimit = getConfig().wsMaxInboundMessageBytes;
      expect(configuredLimit).toBe(8192);
      expect(getMaxInboundMessageBytes()).toBe(configuredLimit);

      const prefix = '{"type":"subscribe","stream_id":"standalone","padding":"';
      const suffix = '"}';
      const exactLimitMessage = `${prefix}${'x'.repeat(
        configuredLimit - Buffer.byteLength(prefix, 'utf8') - Buffer.byteLength(suffix, 'utf8'),
      )}${suffix}`;
      expect(Buffer.byteLength(exactLimitMessage, 'utf8')).toBe(configuredLimit);
      expect(validateWebSocketMessage(exactLimitMessage)).toMatchObject({ ok: true });

      const port = (server.address() as { port: number }).port;
      const ws = await connect(port);
      ws.send(exactLimitMessage);
      await wait(75);
      const clientState = [...getHubInternals(hub).clients.values()][0];
      expect(clientState?.subscriptionFilters.size).toBe(1);

      const close = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
      ws.send('x'.repeat(configuredLimit + 1));
      await expect(close).resolves.toBe(1009);
      ws.close();
    } finally {
      if (previousLimit === undefined) {
        delete process.env.WS_MAX_INBOUND_MESSAGE_BYTES;
      } else {
        process.env.WS_MAX_INBOUND_MESSAGE_BYTES = previousLimit;
      }
      resetConfig();
      initializeConfig();
    }
  });
});
