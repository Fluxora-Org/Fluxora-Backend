import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import { StreamHub } from '../../src/ws/hub.js';
import {
  wsBroadcastBatchFlushSeconds,
  recordWsBroadcastBatchFlushLatency,
  resetWsBackpressureMetrics,
  WS_BROADCAST_BATCH_FLUSH_BUCKETS,
} from '../../src/metrics/wsBackpressure.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type MetricSnapshot = {
  values: Array<{ metricName?: string; labels: Partial<Record<string, string | number>>; value: number }>;
};

async function getMetricSampleCount(metric: { get: () => Promise<MetricSnapshot> }): Promise<number> {
  const snapshot = await metric.get();
  const countSample = snapshot.values.find((s) => s.metricName?.endsWith('_count'));
  return countSample ? countSample.value : 0;
}

async function getMetricSampleSum(metric: { get: () => Promise<MetricSnapshot> }): Promise<number> {
  const snapshot = await metric.get();
  const sumSample = snapshot.values.find((s) => s.metricName?.endsWith('_sum'));
  return sumSample ? sumSample.value : 0;
}

describe('StreamHub micro-batching flush latency metric (fluxora_ws_broadcast_batch_flush_seconds)', () => {
  let server: Server;
  let port: number;
  let hub: StreamHub;
  const activeSockets: Set<WebSocket> = new Set();

  function trackSocket(ws: WebSocket): WebSocket {
    activeSockets.add(ws);
    ws.on('close', () => activeSockets.delete(ws));
    return ws;
  }

  beforeEach(async () => {
    resetWsBackpressureMetrics();
    activeSockets.clear();
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    for (const ws of activeSockets) {
      try {
        ws.terminate();
      } catch {
        // best effort
      }
    }
    activeSockets.clear();

    if (hub) {
      await hub.close();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetWsBackpressureMetrics();
  });

  it('has correct millisecond-scale bucket boundaries and zero labels', () => {
    expect(WS_BROADCAST_BATCH_FLUSH_BUCKETS).toEqual([
      0.0001, // 0.1ms
      0.0005, // 0.5ms
      0.001,  // 1ms
      0.0025, // 2.5ms
      0.005,  // 5ms
      0.01,   // 10ms
      0.025,  // 25ms
      0.05,   // 50ms
      0.1,    // 100ms
      0.25,   // 250ms
      0.5,    // 500ms
      1.0,    // 1s
      2.5,    // 2.5s
      5.0,    // 5s
    ]);
  });

  it('is a no-op with zero overhead when micro-batching is disabled (default mode, flushWindowMs = 0)', async () => {
    hub = new StreamHub(server, { flushWindowMs: 0 });

    const ws = trackSocket(new WebSocket(`ws://127.0.0.1:${port}/ws/streams?stream_id=stream-default`));
    await new Promise<void>((resolve) => ws.on('open', resolve));

    await hub.broadcast({
      streamId: 'stream-default',
      eventId: 'evt-001',
      payload: { test: true },
    });

    await delay(50);

    const count = await getMetricSampleCount(wsBroadcastBatchFlushSeconds);
    expect(count).toBe(0);
  });

  it('records age of oldest event in batch when micro-batching is enabled (flushWindowMs > 0)', async () => {
    hub = new StreamHub(server, { flushWindowMs: 30 });

    const ws = trackSocket(new WebSocket(`ws://127.0.0.1:${port}/ws/streams?stream_id=stream-batch`));
    const receivedMessages: any[] = [];
    ws.on('message', (data) => {
      receivedMessages.push(JSON.parse(data.toString('utf8')));
    });
    await new Promise<void>((resolve) => ws.on('open', resolve));

    await hub.broadcast({
      streamId: 'stream-batch',
      eventId: 'evt-batch-001',
      payload: { num: 1 },
    });

    expect(receivedMessages.length).toBe(0);

    // Wait for the flush window timer (30ms) + buffer
    await delay(60);

    expect(receivedMessages.length).toBe(1);
    expect(receivedMessages[0].eventId).toBe('evt-batch-001');

    const count = await getMetricSampleCount(wsBroadcastBatchFlushSeconds);
    const sum = await getMetricSampleSum(wsBroadcastBatchFlushSeconds);

    expect(count).toBe(1);
    expect(sum).toBeGreaterThan(0);
  });

  it('records oldest event age when multiple events are coalesced in one flush', async () => {
    hub = new StreamHub(server, { flushWindowMs: 40 });

    const ws = trackSocket(new WebSocket(`ws://127.0.0.1:${port}/ws/streams?stream_id=stream-multi`));
    const receivedMessages: any[] = [];
    ws.on('message', (data) => {
      receivedMessages.push(JSON.parse(data.toString('utf8')));
    });
    await new Promise<void>((resolve) => ws.on('open', resolve));

    // Enqueue event 1 at t=0
    await hub.broadcast({
      streamId: 'stream-multi',
      eventId: 'evt-multi-001',
      payload: { seq: 1 },
    });

    await delay(20);

    // Enqueue event 2 at t=20ms
    await hub.broadcast({
      streamId: 'stream-multi',
      eventId: 'evt-multi-002',
      payload: { seq: 2 },
    });

    // Wait until flush window (40ms from t=0) expires
    await delay(50);

    expect(receivedMessages.length).toBe(2);

    const count = await getMetricSampleCount(wsBroadcastBatchFlushSeconds);
    const sum = await getMetricSampleSum(wsBroadcastBatchFlushSeconds);

    expect(count).toBe(1); // One batch flush executed
    expect(sum).toBeGreaterThan(0.035); // Oldest event was queued for ~40ms (>= 0.035s)
  });

  it('flushes immediately when maxBatchSize is reached', async () => {
    hub = new StreamHub(server, { flushWindowMs: 1000, maxBatchSize: 2 });

    const ws = trackSocket(new WebSocket(`ws://127.0.0.1:${port}/ws/streams?stream_id=stream-max`));
    const receivedMessages: any[] = [];
    ws.on('message', (data) => {
      receivedMessages.push(JSON.parse(data.toString('utf8')));
    });
    await new Promise<void>((resolve) => ws.on('open', resolve));

    await hub.broadcast({ streamId: 'stream-max', eventId: 'evt-m-1', payload: {} });
    expect(receivedMessages.length).toBe(0);

    // Second broadcast triggers maxBatchSize (2) immediately without waiting 1s
    await hub.broadcast({ streamId: 'stream-max', eventId: 'evt-m-2', payload: {} });

    await delay(20);

    expect(receivedMessages.length).toBe(2);

    const count = await getMetricSampleCount(wsBroadcastBatchFlushSeconds);
    expect(count).toBe(1);
  });

  it('recordWsBroadcastBatchFlushLatency ignores negative or non-finite inputs', async () => {
    recordWsBroadcastBatchFlushLatency(-1);
    recordWsBroadcastBatchFlushLatency(NaN);
    recordWsBroadcastBatchFlushLatency(Infinity);
    recordWsBroadcastBatchFlushLatency('invalid' as any);

    const count = await getMetricSampleCount(wsBroadcastBatchFlushSeconds);
    expect(count).toBe(0);
  });

  it('flushes pending batch and records metric on hub.close()', async () => {
    hub = new StreamHub(server, { flushWindowMs: 5000 });

    const ws = trackSocket(new WebSocket(`ws://127.0.0.1:${port}/ws/streams?stream_id=stream-close`));
    await new Promise<void>((resolve) => ws.on('open', resolve));

    await hub.broadcast({ streamId: 'stream-close', eventId: 'evt-close-1', payload: {} });

    await hub.close();

    const count = await getMetricSampleCount(wsBroadcastBatchFlushSeconds);
    expect(count).toBe(1);
  });
});
