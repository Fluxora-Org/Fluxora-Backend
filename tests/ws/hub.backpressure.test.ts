import http from 'http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  BACKPRESSURE_DROP_BYTES,
  BACKPRESSURE_TERMINATE_BYTES,
  StreamHub,
  type StreamHubBackpressureEvent,
} from '../../src/ws/hub.js';
import {
  connectClient,
  createSlowClient,
  sendJson,
  wait,
  type SlowClient,
} from './fixtures/slowClient.js';

describe('StreamHub backpressure', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;
  let openClients: WebSocket[];
  let slowClients: SlowClient[];

  beforeEach(async () => {
    server = http.createServer();
    hub = new StreamHub(server);
    hub._resetDedup();
    hub._resetMetrics();
    openClients = [];
    slowClients = [];

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    hub.setBackpressureThresholds({ dropBytes: 8, terminateBytes: 64 });
  });

  afterEach(async () => {
    for (const slowClient of slowClients) slowClient.restore();
    for (const client of openClients) {
      if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) {
        client.close();
      }
    }

    await new Promise<void>((resolve) => hub.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('emits a backpressure event and drops a message for a single slow client', async () => {
    const events = collectBackpressureEvents(hub);
    const slow = await trackSlow(createSlowClient(port, hub));
    slow.subscribe('stream-slow');
    await wait(30);

    slow.setBufferedAmount(16);
    await hub.broadcast({ streamId: 'stream-slow', eventId: 'evt-drop-1', payload: { ok: true } });
    await wait(30);

    expect(slow.messages).toHaveLength(0);
    expect(events).toMatchObject([
      {
        action: 'drop',
        streamId: 'stream-slow',
        eventId: 'evt-drop-1',
        bufferedAmount: 16,
        thresholdBytes: 8,
      },
    ]);
    expect(events[0]?.connectionId).toEqual(expect.any(String));
    expect(events[0]?.timestamp).toEqual(expect.any(String));
    expect(hub.getMetrics()).toMatchObject({
      droppedMessages: 1,
      sentMessages: 0,
      terminatedConnections: 0,
    });
  });

  it('does not let one slow peer block delivery to a fast peer on the same stream', async () => {
    const slow = await trackSlow(createSlowClient(port, hub));
    const fast = await track(connectClient(port));
    const fastMessages: unknown[] = [];
    fast.on('message', (data) => fastMessages.push(JSON.parse(data.toString())));

    slow.subscribe('stream-mixed');
    sendJson(fast, { type: 'subscribe', streamId: 'stream-mixed' });
    await wait(30);

    slow.setBufferedAmount(16);
    await hub.broadcast({ streamId: 'stream-mixed', eventId: 'evt-mixed-1', payload: { value: 1 } });
    await wait(30);

    expect(slow.messages).toHaveLength(0);
    expect(fastMessages).toHaveLength(1);
    expect(fastMessages[0]).toMatchObject({
      type: 'stream_update',
      streamId: 'stream-mixed',
      eventId: 'evt-mixed-1',
    });
    expect(hub.getMetrics()).toMatchObject({
      droppedMessages: 1,
      sentMessages: 1,
      terminatedConnections: 0,
    });
  });

  it('accounts for multiple slow clients independently', async () => {
    const events = collectBackpressureEvents(hub);
    const [slowA, slowB] = await Promise.all([
      trackSlow(createSlowClient(port, hub)),
      trackSlow(createSlowClient(port, hub)),
    ]);

    slowA.subscribe('stream-many-slow');
    slowB.subscribe('stream-many-slow');
    await wait(30);

    slowA.setBufferedAmount(16);
    slowB.setBufferedAmount(32);
    await hub.broadcast({ streamId: 'stream-many-slow', eventId: 'evt-many-1', payload: {} });
    await wait(30);

    expect(slowA.messages).toHaveLength(0);
    expect(slowB.messages).toHaveLength(0);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.bufferedAmount).sort((a, b) => a - b)).toEqual([16, 32]);
    expect(hub.getMetrics()).toMatchObject({
      droppedMessages: 2,
      sentMessages: 0,
      terminatedConnections: 0,
    });
  });

  it('resumes delivery after a slow client drains below the drop threshold', async () => {
    const slow = await trackSlow(createSlowClient(port, hub));
    slow.subscribe('stream-recovers');
    await wait(30);

    slow.setBufferedAmount(16);
    await hub.broadcast({ streamId: 'stream-recovers', eventId: 'evt-recovers-drop', payload: {} });
    await wait(30);

    slow.releaseDrain();
    await hub.broadcast({
      streamId: 'stream-recovers',
      eventId: 'evt-recovers-deliver',
      payload: { delivered: true },
    });
    await wait(30);

    expect(slow.messages).toHaveLength(1);
    expect(slow.messages[0]).toMatchObject({
      type: 'stream_update',
      eventId: 'evt-recovers-deliver',
      payload: { delivered: true },
    });
    expect(hub.getMetrics()).toMatchObject({
      droppedMessages: 1,
      sentMessages: 1,
      terminatedConnections: 0,
    });
  });

  it('terminates clients above the hard threshold and cleans them up', async () => {
    const events = collectBackpressureEvents(hub);
    const slow = await trackSlow(createSlowClient(port, hub));
    slow.subscribe('stream-terminate');
    await wait(30);

    const closed = new Promise<void>((resolve) => slow.client.once('close', () => resolve()));
    slow.setBufferedAmount(128);
    await hub.broadcast({ streamId: 'stream-terminate', eventId: 'evt-term-1', payload: {} });
    await Promise.race([closed, wait(500)]);

    expect(events).toMatchObject([
      {
        action: 'terminate',
        streamId: 'stream-terminate',
        eventId: 'evt-term-1',
        bufferedAmount: 128,
        thresholdBytes: 64,
      },
    ]);
    expect(hub.getMetrics()).toMatchObject({
      droppedMessages: 1,
      sentMessages: 0,
      terminatedConnections: 1,
    });
    expect(hub.clientCount).toBe(0);
  });

  it('does not retain a slow disconnected client in later broadcasts', async () => {
    const slow = await trackSlow(createSlowClient(port, hub));
    slow.subscribe('stream-disconnect');
    await wait(30);

    slow.setBufferedAmount(16);
    await hub.broadcast({ streamId: 'stream-disconnect', eventId: 'evt-before-disconnect', payload: {} });
    slow.client.terminate();
    await wait(50);

    await expect(
      hub.broadcast({ streamId: 'stream-disconnect', eventId: 'evt-after-disconnect', payload: {} }),
    ).resolves.toBeUndefined();
    expect(hub.clientCount).toBe(0);
    expect(hub.getMetrics().droppedMessages).toBe(1);
  });

  it('keeps default production thresholds above the test thresholds', () => {
    expect(BACKPRESSURE_DROP_BYTES).toBeGreaterThan(8);
    expect(BACKPRESSURE_TERMINATE_BYTES).toBeGreaterThan(BACKPRESSURE_DROP_BYTES);
  });

  async function track(clientPromise: Promise<WebSocket>): Promise<WebSocket> {
    const client = await clientPromise;
    openClients.push(client);
    return client;
  }

  async function trackSlow(clientPromise: Promise<SlowClient>): Promise<SlowClient> {
    const slowClient = await clientPromise;
    slowClients.push(slowClient);
    openClients.push(slowClient.client);
    return slowClient;
  }
});

function collectBackpressureEvents(hub: StreamHub): StreamHubBackpressureEvent[] {
  const events: StreamHubBackpressureEvent[] = [];
  hub.on('backpressure', (event) => {
    events.push(event as StreamHubBackpressureEvent);
  });
  return events;
}
