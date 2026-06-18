import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { StreamHub } from '../../src/ws/hub.js';

const JWT_SECRET = 'subscription-filtering-test-secret';
const RECIPIENT_A = 'GCCFZVJYMLYWVOSZ63KUEAQSHYOYEEHZVNEK2EJBIEWJLDKAE6WFEGT7';
const RECIPIENT_B = 'GDACYVWFQFFZ4ZYTMTE3LXYBN2BBBRGCSJA7E2LCYKNZQSQB5VIXODB6';
const INVALID_CHECKSUM_RECIPIENT = 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX';

async function setup(options?: { wsAuthRequired?: boolean; jwtSecret?: string }): Promise<{
  server: http.Server;
  hub: StreamHub;
  port: number;
}> {
  const server = http.createServer();
  const hub = new StreamHub(server, options);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, hub, port: (server.address() as { port: number }).port });
    });
  });
}

async function teardown(server: http.Server, hub: StreamHub): Promise<void> {
  for (const ws of Array.from((hub as unknown as { clients: Map<WebSocket, unknown> }).clients.keys())) {
    ws.terminate();
  }
  await sleep(20);
  await new Promise<void>((resolve) => hub.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function connect(port: number, path = '/ws/streams', token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${res.statusCode}`));
    });
  });
}

function tokenFor(subject: string): string {
  return jwt.sign({ sub: subject }, JWT_SECRET);
}

function send(ws: WebSocket, message: unknown): void {
  ws.send(JSON.stringify(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collect(ws: WebSocket): unknown[] {
  const messages: unknown[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  return messages;
}

describe('StreamHub subscription filtering', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  afterEach(async () => {
    if (server && hub) {
      await teardown(server, hub);
    }
  });

  describe('stream_id filters', () => {
    beforeEach(async () => {
      ({ server, hub, port } = await setup());
    });

    it('routes stream events only to clients subscribed to the matching stream_id', async () => {
      const streamClient = await connect(port);
      const otherStreamClient = await connect(port);
      const unsubscribedClient = await connect(port);

      const streamMessages = collect(streamClient);
      const otherStreamMessages = collect(otherStreamClient);
      const unsubscribedMessages = collect(unsubscribedClient);

      send(streamClient, { type: 'subscribe', stream_id: 'stream-a' });
      send(otherStreamClient, { type: 'subscribe', stream_id: 'stream-b' });
      await sleep(30);

      await hub.broadcast({
        streamId: 'stream-a',
        eventId: 'stream-a-event',
        payload: { recipient: RECIPIENT_A },
      });
      await sleep(50);

      expect(streamMessages).toHaveLength(1);
      expect((streamMessages[0] as Record<string, unknown>)['streamId']).toBe('stream-a');
      expect(otherStreamMessages).toHaveLength(0);
      expect(unsubscribedMessages).toHaveLength(0);

      streamClient.close();
      otherStreamClient.close();
      unsubscribedClient.close();
    });

    it('does not reveal whether a subscribed stream exists', async () => {
      const ws = await connect(port);
      const messages = collect(ws);

      send(ws, { type: 'subscribe', stream_id: 'stream-does-not-exist-yet' });
      await sleep(30);

      await hub.broadcast({
        streamId: 'unrelated-stream',
        eventId: 'unrelated-event',
        payload: { recipient: RECIPIENT_A },
      });
      await sleep(50);

      expect(messages).toHaveLength(0);
      ws.close();
    });

    it('supports stream_id subscription filters supplied during the handshake', async () => {
      const ws = await connect(port, '/ws/streams?stream_id=handshake-stream');
      const messages = collect(ws);

      await hub.broadcast({
        streamId: 'handshake-stream',
        eventId: 'handshake-event',
        payload: { recipient: RECIPIENT_A },
      });
      await sleep(50);

      expect(messages).toHaveLength(1);
      expect((messages[0] as Record<string, unknown>)['streamId']).toBe('handshake-stream');
      ws.close();
    });

    it('rejects unauthenticated recipient_address subscriptions', async () => {
      const ws = await connect(port);
      const messages = collect(ws);

      send(ws, { type: 'subscribe', recipient_address: RECIPIENT_A });
      await sleep(30);

      expect(messages).toHaveLength(1);
      expect((messages[0] as Record<string, unknown>)['type']).toBe('error');
      expect((messages[0] as Record<string, unknown>)['code']).toBe('UNAUTHORIZED');
      ws.close();
    });

    it('rejects recipient_address filters that fail Stellar StrKey checksum validation', async () => {
      const ws = await connect(port);
      const messages = collect(ws);

      send(ws, { type: 'subscribe', recipient_address: INVALID_CHECKSUM_RECIPIENT });
      await sleep(30);

      expect(messages).toHaveLength(1);
      expect((messages[0] as Record<string, unknown>)['type']).toBe('error');
      expect((messages[0] as Record<string, unknown>)['code']).toBe('INVALID_MESSAGE');
      ws.close();
    });
  });

  describe('recipient_address filters', () => {
    beforeEach(async () => {
      ({ server, hub, port } = await setup({ wsAuthRequired: true, jwtSecret: JWT_SECRET }));
    });

    it('routes recipient events only to matching recipient_address subscribers', async () => {
      const recipientClient = await connect(port, '/ws/streams', tokenFor(RECIPIENT_A));
      const otherRecipientClient = await connect(port, '/ws/streams', tokenFor(RECIPIENT_B));

      const recipientMessages = collect(recipientClient);
      const otherRecipientMessages = collect(otherRecipientClient);

      send(recipientClient, { type: 'subscribe', recipient_address: RECIPIENT_A });
      send(otherRecipientClient, { type: 'subscribe', recipient_address: RECIPIENT_B });
      await sleep(30);

      await hub.broadcast({
        streamId: 'recipient-stream',
        eventId: 'recipient-event',
        recipientAddress: RECIPIENT_A,
        payload: { depositAmount: '100.0000000' },
      });
      await sleep(50);

      expect(recipientMessages).toHaveLength(1);
      expect(otherRecipientMessages).toHaveLength(0);

      recipientClient.close();
      otherRecipientClient.close();
    });

    it('uses the authenticated subject for an explicit empty filter', async () => {
      const ws = await connect(port, '/ws/streams', tokenFor(RECIPIENT_A));
      const messages = collect(ws);

      send(ws, { type: 'subscribe', filter: {} });
      await sleep(30);

      await hub.broadcast({
        streamId: 'own-stream',
        eventId: 'own-event',
        payload: { recipient_address: RECIPIENT_A },
      });
      await hub.broadcast({
        streamId: 'other-stream',
        eventId: 'other-event',
        payload: { recipient_address: RECIPIENT_B },
      });
      await sleep(50);

      expect(messages).toHaveLength(1);
      expect((messages[0] as Record<string, unknown>)['streamId']).toBe('own-stream');
      ws.close();
    });

    it('rejects recipient_address subscriptions that do not match the authenticated subject', async () => {
      const ws = await connect(port, '/ws/streams', tokenFor(RECIPIENT_A));
      const messages = collect(ws);

      send(ws, { type: 'subscribe', recipient_address: RECIPIENT_B });
      await sleep(30);

      await hub.broadcast({
        streamId: 'forbidden-stream',
        eventId: 'forbidden-event',
        recipientAddress: RECIPIENT_B,
        payload: {},
      });
      await sleep(50);

      expect(messages).toHaveLength(1);
      expect((messages[0] as Record<string, unknown>)['type']).toBe('error');
      expect((messages[0] as Record<string, unknown>)['code']).toBe('FORBIDDEN');
      ws.close();
    });

    it('rejects empty filters when the authenticated subject is not a Stellar public key', async () => {
      const ws = await connect(port, '/ws/streams', tokenFor('user-1'));
      const messages = collect(ws);

      send(ws, { type: 'subscribe', filter: {} });
      await sleep(30);

      expect(messages).toHaveLength(1);
      expect((messages[0] as Record<string, unknown>)['type']).toBe('error');
      expect((messages[0] as Record<string, unknown>)['code']).toBe('UNAUTHORIZED');
      ws.close();
    });
  });

  describe('subscription changes', () => {
    beforeEach(async () => {
      ({ server, hub, port } = await setup());
    });

    it('handles concurrent subscribe and unsubscribe without leaking stale filters', async () => {
      const ws = await connect(port);
      const messages = collect(ws);

      send(ws, { type: 'subscribe', stream_id: 'stream-race-a' });
      send(ws, { type: 'unsubscribe', stream_id: 'stream-race-a' });
      send(ws, { type: 'subscribe', stream_id: 'stream-race-b' });
      await sleep(50);

      await hub.broadcast({ streamId: 'stream-race-a', eventId: 'race-a', payload: {} });
      await hub.broadcast({ streamId: 'stream-race-b', eventId: 'race-b', payload: {} });
      await sleep(50);

      expect(messages).toHaveLength(1);
      expect((messages[0] as Record<string, unknown>)['streamId']).toBe('stream-race-b');
      ws.close();
    });
  });
});
