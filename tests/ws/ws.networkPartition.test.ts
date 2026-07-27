import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import {
  StreamHub,
  type StreamHubBackpressureEvent,
} from '../../src/ws/hub.js';
import { _resetLimiter } from '../../src/ws/connectionLimiter.js';
import {
  connectClient,
  createSlowClient,
  sendJson,
  wait,
  type SlowClient,
} from './fixtures/slowClient.js';

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

describe('StreamHub Network Partition', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;
  const slowClients: SlowClient[] = [];
  const plainClients: WebSocket[] = [];

  beforeEach(async () => {
    ({ server, hub, port } = await setup());
    _resetLimiter();
    hub._resetDedup();
    hub._resetMetrics();
    slowClients.length = 0;
    plainClients.length = 0;
  });

  afterEach(async () => {
    for (const sc of slowClients) {
      try { sc.close(); } catch { /* ignore */ }
    }
    for (const ws of plainClients) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch { /* ignore */ }
    }
    await wait(50);
    _resetLimiter();
    await teardown(server, hub);
  });

  it('simulation: bufferedAmount grows with each broadcast in partition mode', async () => {
    const slow = await createSlowClient(port, hub);
    slowClients.push(slow);
    slow.subscribe('accumulate');
    await wait(50);

    expect(slow.getBufferedAmount()).toBe(0);

    slow.simulatePartition();

    await hub.broadcast({ streamId: 'accumulate', eventId: 'evt-1', payload: { seq: 1 } });
    await wait(20);
    const afterOne = slow.getBufferedAmount();
    expect(afterOne).toBeGreaterThan(0);

    await hub.broadcast({ streamId: 'accumulate', eventId: 'evt-2', payload: { seq: 2 } });
    await wait(20);
    const afterTwo = slow.getBufferedAmount();
    expect(afterTwo).toBeGreaterThan(afterOne);
  });

  it('drops events for a partitioned client when bufferedAmount exceeds dropBytes', async () => {
    hub.setBackpressureThresholds({ dropBytes: 600, terminateBytes: 50000 });
    const events = collectBackpressureEvents(hub);

    const slow = await createSlowClient(port, hub);
    slowClients.push(slow);
    slow.subscribe('drop-stream');
    await wait(50);

    slow.simulatePartition();

    for (let i = 0; i < 15; i++) {
      await hub.broadcast({ streamId: 'drop-stream', eventId: `evt-drop-${i}`, payload: { n: i } });
    }
    await wait(50);

    const dropEvents = events.filter((e) => e.action === 'drop');
    expect(dropEvents.length).toBeGreaterThan(0);

    const metrics = hub.getMetrics();
    expect(metrics.droppedMessages).toBeGreaterThan(0);
    expect(metrics.terminatedConnections).toBe(0);
    expect(hub.clientCount).toBe(1);
  });

  it('terminates a partitioned client when bufferedAmount exceeds terminateBytes', async () => {
    hub.setBackpressureThresholds({ dropBytes: 50000, terminateBytes: 1200 });

    const slow = await createSlowClient(port, hub);
    slowClients.push(slow);
    slow.subscribe('terminate-stream');
    await wait(50);

    let terminateFired = false;
    hub.on('backpressure', (evt) => {
      if ((evt as StreamHubBackpressureEvent).action === 'terminate') {
        terminateFired = true;
      }
    });

    slow.simulatePartition();

    for (let i = 0; i < 20; i++) {
      await hub.broadcast({
        streamId: 'terminate-stream',
        eventId: `evt-term-${i}`,
        payload: { n: i },
      });
      if (hub.clientCount === 0) break;
    }
    await wait(50);

    expect(terminateFired).toBe(true);

    const metrics = hub.getMetrics();
    expect(metrics.terminatedConnections).toBeGreaterThanOrEqual(1);

    expect(hub.getStreamSubscriptionCount('terminate-stream')).toBe(0);
    expect(hub.clientCount).toBe(0);
  });

  it('delivers to a healthy client with bounded latency while a partitioned peer is reaped', async () => {
    hub.setBackpressureThresholds({ dropBytes: 50000, terminateBytes: 2000 });
    const slowEvents = collectBackpressureEvents(hub);

    const slow = await createSlowClient(port, hub);
    slowClients.push(slow);
    slow.subscribe('mixed-latency');
    slow.simulatePartition();

    const fast = await connectClient(port);
    plainClients.push(fast);
    const fastMessages: unknown[] = [];
    fast.on('message', (data) => {
      fastMessages.push(JSON.parse(data.toString()));
    });
    sendJson(fast, { type: 'subscribe', streamId: 'mixed-latency' });
    await wait(50);

    const latencies: number[] = [];

    for (let i = 0; i < 20; i++) {
      const before = Date.now();
      await hub.broadcast({
        streamId: 'mixed-latency',
        eventId: `evt-latency-${i}`,
        payload: { seq: i },
      });
      const after = Date.now();
      latencies.push(after - before);

      if (hub.clientCount === 0) break;
    }
    await wait(100);

    const terminateEvents = slowEvents.filter((e) => e.action === 'terminate');
    expect(terminateEvents.length).toBeGreaterThanOrEqual(1);

    const healthyUpdates = fastMessages.filter(
      (m) => (m as Record<string, unknown>).type === 'stream_update',
    );
    expect(healthyUpdates.length).toBeGreaterThanOrEqual(1);

    for (const lat of latencies) {
      expect(lat).toBeLessThan(500);
    }
  });

  it('handles multiple partitioned clients independently', async () => {
    hub.setBackpressureThresholds({ dropBytes: 50000, terminateBytes: 2000 });
    const events = collectBackpressureEvents(hub);

    const [slowA, slowB] = await Promise.all([
      createSlowClient(port, hub),
      createSlowClient(port, hub),
    ]);
    slowClients.push(slowA, slowB);
    slowA.subscribe('multi-partition');
    slowB.subscribe('multi-partition');
    await wait(50);

    slowA.simulatePartition();
    slowB.simulatePartition();

    for (let i = 0; i < 20; i++) {
      await hub.broadcast({
        streamId: 'multi-partition',
        eventId: `evt-mp-${i}`,
        payload: { n: i },
      });
      if (hub.clientCount === 0) break;
    }
    await wait(100);

    const terminateEvents = events.filter((e) => e.action === 'terminate');
    expect(terminateEvents.length).toBeGreaterThanOrEqual(2);

    const metrics = hub.getMetrics();
    expect(metrics.terminatedConnections).toBeGreaterThanOrEqual(2);
  });

  it('does not let a partitioned client block delivery to healthy subscribers', async () => {
    hub.setBackpressureThresholds({ dropBytes: 50000, terminateBytes: 2000 });

    const slow = await createSlowClient(port, hub);
    slowClients.push(slow);
    slow.subscribe('non-blocking');
    slow.simulatePartition();

    const fast = await connectClient(port);
    plainClients.push(fast);
    const fastMessages: unknown[] = [];
    fast.on('message', (data) => {
      fastMessages.push(JSON.parse(data.toString()));
    });
    sendJson(fast, { type: 'subscribe', streamId: 'non-blocking' });
    await wait(50);

    for (let i = 0; i < 20; i++) {
      await hub.broadcast({
        streamId: 'non-blocking',
        eventId: `evt-nb-${i}`,
        payload: { seq: i },
      });
      if (hub.clientCount === 0) break;
    }
    await wait(100);

    const healthyUpdates = fastMessages.filter(
      (m) => (m as Record<string, unknown>).type === 'stream_update',
    );
    expect(healthyUpdates.length).toBeGreaterThanOrEqual(1);

    expect(hub.getMetrics().sentMessages).toBeGreaterThanOrEqual(1);
  });

  it('cleans up subscription state after partition-triggered termination', async () => {
    hub.setBackpressureThresholds({ dropBytes: 50000, terminateBytes: 2000 });

    const slow = await createSlowClient(port, hub);
    slowClients.push(slow);
    slow.subscribe('cleanup-stream');
    await wait(50);

    slow.simulatePartition();

    for (let i = 0; i < 20; i++) {
      await hub.broadcast({
        streamId: 'cleanup-stream',
        eventId: `evt-clean-${i}`,
        payload: { n: i },
      });
      if (hub.clientCount === 0) break;
    }
    await wait(50);

    expect(hub.getStreamSubscriptionCount('cleanup-stream')).toBe(0);
    expect(hub.clientCount).toBe(0);

    await hub.broadcast({
      streamId: 'cleanup-stream',
      eventId: 'evt-clean-after',
      payload: { done: true },
    });
  });
});

function collectBackpressureEvents(hub: StreamHub): StreamHubBackpressureEvent[] {
  const events: StreamHubBackpressureEvent[] = [];
  hub.on('backpressure', (event) => {
    events.push(event as StreamHubBackpressureEvent);
  });
  return events;
}
