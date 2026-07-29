/**
 * tests/ws/hub.wsBackpressure.edge.test.ts
 *
 * Edge-case and alerting-surface tests for the wsBackpressure metrics module
 * (`src/metrics/wsBackpressure.ts`).
 *
 * These tests are intentionally stub-based (no real WebSocket server) so they
 * run fast, stay deterministic, and do not require a PostgreSQL connection.
 * They complement the integration-level tests in hub.backpressureGauge.unit.test.ts
 * and hub.backpressure.test.ts.
 *
 * Coverage added here:
 *   1. collectWsBackpressureMetrics — graceful no-ops when hub has no
 *      _getClients / _getStreamSubscriptions methods.
 *   2. wsBatchFlushTotal / wsBatchEventsCoalescedTotal / wsBatchSizeExceededTotal
 *      increment correctly when the hub flushes a batch (integration with real hub).
 *   3. fluxora_ws_slow_clients boundary: clients exactly at the threshold are
 *      NOT counted as slow; only clients strictly above are.
 *   4. topN = 0 collapses subscription cardinality reporting to nothing.
 *   5. Zero-duration flush latency is recorded (not rejected like negatives).
 *   6. Negative latency is silently ignored by recordWsBroadcastBatchFlushLatency.
 *   7. topN cardinality: only the top-N streams appear; lower-ranked streams
 *      are pruned and their labels do not persist after the next collection.
 */

import http from 'http';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { StreamHub } from '../../src/ws/hub.js';
import {
  collectWsBackpressureMetrics,
  recordWsBroadcastBatchFlushLatency,
  resetWsBackpressureMetrics,
  wsBatchEventsCoalescedTotal,
  wsBatchFlushTotal,
  wsBatchSizeExceededTotal,
  wsBroadcastBatchFlushLatencySeconds,
  wsClientBufferedBytes,
  wsMaxBufferedBytes,
  wsSlowClients,
  wsStreamSubscriberCount,
  DEFAULT_WS_SLOW_CLIENT_BYTES,
} from '../../src/metrics/wsBackpressure.js';
import { sendJson, wait } from './fixtures/slowClient.js';

// ── vi.mock factory for streamRepository ─────────────────────────────────
// Hoisted before variable declarations; literal must match EDGE_TEST_SUBJECT.
vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById: vi.fn().mockResolvedValue({
      id: 'stream-mock-edge',
      sender: 'edge-test-sender-subject',
      recipient: 'edge-test-recipient',
    }),
    upsertStream: vi.fn(),
    updateStream: vi.fn(),
  },
}));

const EDGE_JWT_SECRET = 'edge-test-jwt-secret-32-chars!!!';
const EDGE_TEST_SUBJECT = 'edge-test-sender-subject';

function makeEdgeToken(): string {
  return jwt.sign({ sub: EDGE_TEST_SUBJECT }, EDGE_JWT_SECRET);
}

// ── Helpers ───────────────────────────────────────────────────────────────

interface GaugeSample {
  labels: Record<string, string>;
  value: number;
}

async function readClientGauge(connectionId: string): Promise<number | null> {
  const result = (await wsClientBufferedBytes.get()) as { values: GaugeSample[] };
  const match = result.values.find((v) => v.labels?.connection_id === connectionId);
  return match ? match.value : null;
}

async function readSingleGauge(gauge: { get(): Promise<{ values: { value: number }[] }> }): Promise<number> {
  const result = await gauge.get();
  return result.values[0]?.value ?? 0;
}

async function counterTotal(counter: { get(): Promise<{ values: { value: number }[] }> }): Promise<number> {
  const result = await counter.get();
  return result.values.reduce((sum, v) => sum + v.value, 0);
}

async function readStreamSubscriberCount(streamId: string): Promise<number | null> {
  const result = (await wsStreamSubscriberCount.get()) as { values: GaugeSample[] };
  const match = result.values.find((v) => v.labels?.stream_id === streamId);
  return match ? match.value : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHub = any;

// ── 1. No-op when hub has no _getClients / _getStreamSubscriptions ─────────

describe('collectWsBackpressureMetrics — graceful no-ops', () => {
  beforeEach(() => resetWsBackpressureMetrics());
  afterEach(() => resetWsBackpressureMetrics());

  it('does nothing when hub has neither _getClients nor _getStreamSubscriptions', () => {
    // Should not throw, should not update any metrics.
    expect(() => collectWsBackpressureMetrics({} as AnyHub)).not.toThrow();
  });

  it('only iterates clients when _getClients is present but _getStreamSubscriptions is absent', async () => {
    const hub = {
      _getClients: function* () {
        yield [{ readyState: 1, bufferedAmount: 42 }, { id: 'conn-no-subs' }] as [unknown, { id: string }];
      },
    };
    collectWsBackpressureMetrics(hub as AnyHub);
    expect(await readClientGauge('conn-no-subs')).toBe(42);
    // Stream subscriber gauge must remain untouched (no _getStreamSubscriptions).
    const streamResult = (await wsStreamSubscriberCount.get()) as { values: GaugeSample[] };
    expect(streamResult.values).toHaveLength(0);
  });

  it('only collects stream subscriptions when _getStreamSubscriptions is present but _getClients is absent', async () => {
    const subs = new Map([['stream-only', new Set([{}])]]);
    const hub = { _getStreamSubscriptions: () => subs };
    collectWsBackpressureMetrics(hub as AnyHub);
    expect(await readStreamSubscriberCount('stream-only')).toBe(1);
    // Client gauges must remain untouched.
    const clientResult = (await wsClientBufferedBytes.get()) as { values: GaugeSample[] };
    expect(clientResult.values).toHaveLength(0);
  });
});

// ── 2. Batch counter increments ───────────────────────────────────────────

describe('wsBatch* counters — increment on flush', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;
  const openClients: WebSocket[] = [];

  beforeEach(async () => {
    server = http.createServer();
    hub = new StreamHub(server, {
      jwtSecret: EDGE_JWT_SECRET,
      backpressureCollector: { intervalMs: 0 },
      batching: { flushMs: 30, maxSize: 3 },
    });
    hub._resetDedup();

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    // Reset batch counters before each test.
    wsBatchFlushTotal.reset();
    wsBatchEventsCoalescedTotal.reset();
    wsBatchSizeExceededTotal.reset();
  });

  afterEach(async () => {
    for (const ws of openClients) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    }
    openClients.length = 0;
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function connectAuth(): Promise<WebSocket> {
    const token = makeEdgeToken();
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws/streams`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      client.once('open', () => resolve(client));
      client.once('error', reject);
    });
    openClients.push(ws);
    return ws;
  }

  it('increments wsBatchFlushTotal and wsBatchEventsCoalescedTotal on a timer-driven flush', async () => {
    const client = await connectAuth();
    sendJson(client, { type: 'subscribe', streamId: 'stream-batch-1', batching: true });
    await wait(20);

    const flushBefore = await counterTotal(wsBatchFlushTotal);
    const coalescedBefore = await counterTotal(wsBatchEventsCoalescedTotal);

    await hub.broadcast({ streamId: 'stream-batch-1', eventId: 'b1', payload: {} });
    await hub.broadcast({ streamId: 'stream-batch-1', eventId: 'b2', payload: {} });
    await wait(60); // wait for flush window (30ms + slack)

    expect(await counterTotal(wsBatchFlushTotal)).toBe(flushBefore + 1);
    expect(await counterTotal(wsBatchEventsCoalescedTotal)).toBe(coalescedBefore + 2);
    expect(await counterTotal(wsBatchSizeExceededTotal)).toBe(0);
  });

  it('increments wsBatchSizeExceededTotal when the batch hits maxSize before the window', async () => {
    const client = await connectAuth();
    sendJson(client, { type: 'subscribe', streamId: 'stream-batch-2', batching: true });
    await wait(20);

    const exceededBefore = await counterTotal(wsBatchSizeExceededTotal);

    // maxSize = 3 → three events trigger an early flush.
    await hub.broadcast({ streamId: 'stream-batch-2', eventId: 'c1', payload: {} });
    await hub.broadcast({ streamId: 'stream-batch-2', eventId: 'c2', payload: {} });
    await hub.broadcast({ streamId: 'stream-batch-2', eventId: 'c3', payload: {} });
    await wait(20); // early flush happens synchronously before the timer

    expect(await counterTotal(wsBatchSizeExceededTotal)).toBe(exceededBefore + 1);
    expect(await counterTotal(wsBatchEventsCoalescedTotal)).toBeGreaterThanOrEqual(3);
  });
});

// ── 3. fluxora_ws_slow_clients boundary classification ───────────────────

describe('fluxora_ws_slow_clients — boundary classification', () => {
  beforeEach(() => resetWsBackpressureMetrics());
  afterEach(() => resetWsBackpressureMetrics());

  function makeHub(clients: Array<{ id: string; bufferedAmount: number }>): AnyHub {
    return {
      _getClients: function* () {
        for (const c of clients) {
          yield [{ readyState: 1, bufferedAmount: c.bufferedAmount }, { id: c.id }] as [unknown, { id: string }];
        }
      },
    };
  }

  it('does NOT count a client whose bufferedAmount equals the threshold as slow', async () => {
    const hub = makeHub([{ id: 'at-threshold', bufferedAmount: DEFAULT_WS_SLOW_CLIENT_BYTES }]);
    collectWsBackpressureMetrics(hub);
    // Exactly at threshold → not slow (strictly-greater check).
    expect(await readSingleGauge(wsSlowClients)).toBe(0);
  });

  it('counts a client whose bufferedAmount is 1 byte above the threshold as slow', async () => {
    const hub = makeHub([{ id: 'just-above', bufferedAmount: DEFAULT_WS_SLOW_CLIENT_BYTES + 1 }]);
    collectWsBackpressureMetrics(hub);
    expect(await readSingleGauge(wsSlowClients)).toBe(1);
  });

  it('correctly classifies a mix of at-threshold, below, and above clients', async () => {
    const hub = makeHub([
      { id: 'below', bufferedAmount: DEFAULT_WS_SLOW_CLIENT_BYTES - 1 },
      { id: 'at', bufferedAmount: DEFAULT_WS_SLOW_CLIENT_BYTES },
      { id: 'above-1', bufferedAmount: DEFAULT_WS_SLOW_CLIENT_BYTES + 1 },
      { id: 'above-2', bufferedAmount: DEFAULT_WS_SLOW_CLIENT_BYTES + 1_000_000 },
    ]);
    collectWsBackpressureMetrics(hub);
    // Only the two strictly-above clients are counted.
    expect(await readSingleGauge(wsSlowClients)).toBe(2);
    // Max should be the largest bufferedAmount.
    expect(await readSingleGauge(wsMaxBufferedBytes)).toBe(DEFAULT_WS_SLOW_CLIENT_BYTES + 1_000_000);
  });
});

// ── 4. topN = 0 collapses subscription cardinality ───────────────────────

describe('collectWsBackpressureMetrics — topN = 0', () => {
  beforeEach(() => resetWsBackpressureMetrics());
  afterEach(() => resetWsBackpressureMetrics());

  it('emits no stream_subscriber_count labels when topN is 0', async () => {
    const subs = new Map([
      ['stream-a', new Set([{}, {}])],
      ['stream-b', new Set([{}])],
    ]);
    const hub = { _getStreamSubscriptions: () => subs };
    collectWsBackpressureMetrics(hub as AnyHub, DEFAULT_WS_SLOW_CLIENT_BYTES, /* topN */ 0);
    const result = (await wsStreamSubscriberCount.get()) as { values: GaugeSample[] };
    expect(result.values).toHaveLength(0);
  });
});

// ── 5 & 6. recordWsBroadcastBatchFlushLatency — zero and negative ─────────

describe('recordWsBroadcastBatchFlushLatency — zero and negative guard', () => {
  beforeEach(() => wsBroadcastBatchFlushLatencySeconds.reset());
  afterEach(() => wsBroadcastBatchFlushLatencySeconds.reset());

  it('records zero-duration latency (boundary: 0 is valid)', async () => {
    const before = await wsBroadcastBatchFlushLatencySeconds.get();
    const countBefore = before.values.find((v) => v.metricName?.endsWith('_count'))?.value ?? 0;

    recordWsBroadcastBatchFlushLatency(0);

    const after = await wsBroadcastBatchFlushLatencySeconds.get();
    const countAfter = after.values.find((v) => v.metricName?.endsWith('_count'))?.value ?? 0;
    expect(countAfter).toBe(countBefore + 1);
  });

  it('silently ignores negative latency values', async () => {
    const before = await wsBroadcastBatchFlushLatencySeconds.get();
    const countBefore = before.values.find((v) => v.metricName?.endsWith('_count'))?.value ?? 0;

    recordWsBroadcastBatchFlushLatency(-0.001);
    recordWsBroadcastBatchFlushLatency(-999);

    const after = await wsBroadcastBatchFlushLatencySeconds.get();
    const countAfter = after.values.find((v) => v.metricName?.endsWith('_count'))?.value ?? 0;
    // Count must not have changed — negative values are dropped.
    expect(countAfter).toBe(countBefore);
  });
});

// ── 7. topN cardinality pruning ───────────────────────────────────────────

describe('collectWsBackpressureMetrics — topN cardinality pruning', () => {
  beforeEach(() => resetWsBackpressureMetrics());
  afterEach(() => resetWsBackpressureMetrics());

  it('exposes only the top-N streams by subscriber count and prunes the rest', async () => {
    const subs = new Map([
      ['stream-high', new Set([{}, {}, {}])],  // 3 subscribers — top
      ['stream-mid', new Set([{}, {}])],        // 2 subscribers — top
      ['stream-low', new Set([{}])],            // 1 subscriber — pruned when N=2
    ]);
    const hub = { _getStreamSubscriptions: () => subs };

    // First pass with topN=2 — only stream-high and stream-mid should appear.
    collectWsBackpressureMetrics(hub as AnyHub, DEFAULT_WS_SLOW_CLIENT_BYTES, 2);
    expect(await readStreamSubscriberCount('stream-high')).toBe(3);
    expect(await readStreamSubscriberCount('stream-mid')).toBe(2);
    expect(await readStreamSubscriberCount('stream-low')).toBeNull();
  });

  it('removes stale stream labels when the top-N set changes between collections', async () => {
    const subs = new Map([
      ['stream-a', new Set([{}, {}])],
      ['stream-b', new Set([{}])],
    ]);
    const hub = { _getStreamSubscriptions: () => subs };

    // First collection — both appear (topN=2).
    collectWsBackpressureMetrics(hub as AnyHub, DEFAULT_WS_SLOW_CLIENT_BYTES, 2);
    expect(await readStreamSubscriberCount('stream-a')).toBe(2);
    expect(await readStreamSubscriberCount('stream-b')).toBe(1);

    // Remove stream-b entirely, add stream-c with higher cardinality.
    subs.delete('stream-b');
    subs.set('stream-c', new Set([{}, {}, {}]));

    // Second collection — stream-b must no longer appear.
    collectWsBackpressureMetrics(hub as AnyHub, DEFAULT_WS_SLOW_CLIENT_BYTES, 2);
    expect(await readStreamSubscriberCount('stream-c')).toBe(3);
    expect(await readStreamSubscriberCount('stream-a')).toBe(2);
    // Stale label pruned by wsStreamSubscriberCount.reset() inside collect.
    expect(await readStreamSubscriberCount('stream-b')).toBeNull();
  });
});
