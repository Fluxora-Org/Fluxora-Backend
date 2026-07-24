/**
 * tests/ws/hub.subscriptionCardinality.test.ts
 *
 * Stub-based unit tests for the subscription cardinality gauge
 * (`fluxora_ws_stream_subscriber_count`). Exercises the top-N cap,
 * stale-series removal, empty-hub edge case, custom top-N, and the
 * reset invariant.
 *
 * Follows the same stub pattern as hub.backpressureGauge.unit.test.ts
 * to avoid the `createSlowClient` fixture and keep tests deterministic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  collectWsBackpressureMetrics,
  resetWsBackpressureMetrics,
  wsStreamSubscriberCount,
} from '../../src/metrics/wsBackpressure.js';
import { DEFAULT_WS_STREAM_CARDINALITY_TOP_N } from '../../src/metrics/wsBackpressure.js';

// ── Stubs ──────────────────────────────────────────────────────────────────

interface StubSocket {
  OPEN: 1;
  CLOSING: 2;
  CLOSED: 3;
  readyState: number;
  bufferedAmount: number;
}

const stubSocket = (buffered = 0): StubSocket => ({
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
  readyState: 1,
  bufferedAmount: buffered,
});

interface FakeClientState {
  id: string;
}

/**
 * Builds a hub stand-in with `_getClients()` and `_getStreamSubscriptions()`.
 */
function makeFakeHub(opts: {
  clients?: Array<[StubSocket, FakeClientState]>;
  streamSubscriptions?: Map<string, Set<StubSocket>>;
}) {
  const clients = opts.clients ?? [];
  const streamSubscriptions = opts.streamSubscriptions ?? new Map();

  return {
    _getClients: function* () {
      for (const entry of clients) yield entry;
    },
    _getStreamSubscriptions(): ReadonlyMap<string, Set<StubSocket>> {
      return streamSubscriptions;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHub = any;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function readStreamLabel(
  streamId: string,
): Promise<number | null> {
  const result = (await wsStreamSubscriberCount.get()) as {
    values: Array<{ labels: Record<string, string>; value: number }>;
  };
  const match = result.values.find((v) => v.labels?.stream_id === streamId);
  return match ? match.value : null;
}

async function readAllStreamLabels(): Promise<Map<string, number>> {
  const result = (await wsStreamSubscriberCount.get()) as {
    values: Array<{ labels: Record<string, string>; value: number }>;
  };
  const map = new Map<string, number>();
  for (const v of result.values) {
    map.set(v.labels.stream_id, v.value);
  }
  return map;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Subscription cardinality gauge (stub-based unit tests)', () => {
  beforeEach(() => {
    resetWsBackpressureMetrics();
  });

  afterEach(() => {
    resetWsBackpressureMetrics();
  });

  it('reports subscriber counts for streams when hub has subscriptions', async () => {
    const streamSubs = new Map<string, Set<StubSocket>>();
    streamSubs.set('stream-A', new Set([stubSocket(), stubSocket(), stubSocket()]));
    streamSubs.set('stream-B', new Set([stubSocket(), stubSocket()]));

    const hub = makeFakeHub({ streamSubscriptions: streamSubs });

    collectWsBackpressureMetrics(hub as AnyHub);

    expect(await readStreamLabel('stream-A')).toBe(3);
    expect(await readStreamLabel('stream-B')).toBe(2);
  });

  it('caps label cardinality to top-N (default 20)', async () => {
    const streamSubs = new Map<string, Set<StubSocket>>();

    // Create 25 streams with 1-25 subscribers respectively.
    for (let i = 1; i <= 25; i++) {
      const subs = new Set<StubSocket>();
      for (let j = 0; j < i; j++) subs.add(stubSocket());
      streamSubs.set(`stream-${String(i).padStart(2, '0')}`, subs);
    }

    const hub = makeFakeHub({ streamSubscriptions: streamSubs });
    collectWsBackpressureMetrics(hub as AnyHub);

    const all = await readAllStreamLabels();

    // Should have exactly 20 streams reported (top 20 by subscriber count).
    expect(all.size).toBe(DEFAULT_WS_STREAM_CARDINALITY_TOP_N);

    // stream-01 (1 subscriber) should NOT be in the top 20.
    expect(all.has('stream-01')).toBe(false);

    // stream-06 (6 subscribers) should be the smallest in the top 20.
    expect(all.has('stream-06')).toBe(true);

    // stream-25 (25 subscribers) should be the largest.
    expect(all.get('stream-25')).toBe(25);
  });

  it('removes stale series when a stream drops out of top-N', async () => {
    // First cycle: streams A(10), B(5), C(3), D(1) — all in top-4.
    const subs1 = new Map<string, Set<StubSocket>>();
    subs1.set('A', new Set(Array(10).fill(null).map(() => stubSocket())));
    subs1.set('B', new Set(Array(5).fill(null).map(() => stubSocket())));
    subs1.set('C', new Set(Array(3).fill(null).map(() => stubSocket())));
    subs1.set('D', new Set([stubSocket()]));

    const hub1 = makeFakeHub({ streamSubscriptions: subs1 });
    collectWsBackpressureMetrics(hub1 as AnyHub, 1_048_576, 4);

    let all = await readAllStreamLabels();
    expect(all.size).toBe(4);
    expect(all.has('D')).toBe(true);

    // Second cycle: E(20) enters, D(1) drops out of top-4.
    const subs2 = new Map<string, Set<StubSocket>>();
    subs2.set('A', new Set(Array(10).fill(null).map(() => stubSocket())));
    subs2.set('B', new Set(Array(5).fill(null).map(() => stubSocket())));
    subs2.set('C', new Set(Array(3).fill(null).map(() => stubSocket())));
    subs2.set('E', new Set(Array(20).fill(null).map(() => stubSocket())));

    const hub2 = makeFakeHub({ streamSubscriptions: subs2 });
    collectWsBackpressureMetrics(hub2 as AnyHub, 1_048_576, 4);

    all = await readAllStreamLabels();
    expect(all.size).toBe(4);
    expect(all.has('D')).toBe(false);
    expect(all.has('E')).toBe(true);
    expect(all.get('E')).toBe(20);
  });

  it('reports no series when hub has zero streams', async () => {
    const hub = makeFakeHub({ streamSubscriptions: new Map() });
    collectWsBackpressureMetrics(hub as AnyHub);

    const all = await readAllStreamLabels();
    expect(all.size).toBe(0);
  });

  it('clears all series when streams go from many to zero', async () => {
    const subs = new Map<string, Set<StubSocket>>();
    subs.set('X', new Set(Array(5).fill(null).map(() => stubSocket())));
    subs.set('Y', new Set(Array(3).fill(null).map(() => stubSocket())));

    const hub1 = makeFakeHub({ streamSubscriptions: subs });
    collectWsBackpressureMetrics(hub1 as AnyHub, 1_048_576, 10);
    expect((await readAllStreamLabels()).size).toBe(2);

    // All streams removed.
    const hub2 = makeFakeHub({ streamSubscriptions: new Map() });
    collectWsBackpressureMetrics(hub2 as AnyHub, 1_048_576, 10);
    expect((await readAllStreamLabels()).size).toBe(0);
  });

  it('supports a custom top-N value', async () => {
    const subs = new Map<string, Set<StubSocket>>();
    subs.set('a', new Set(Array(10).fill(null).map(() => stubSocket())));
    subs.set('b', new Set(Array(5).fill(null).map(() => stubSocket())));
    subs.set('c', new Set(Array(1).fill(null).map(() => stubSocket())));

    const hub = makeFakeHub({ streamSubscriptions: subs });
    collectWsBackpressureMetrics(hub as AnyHub, 1_048_576, 2);

    const all = await readAllStreamLabels();
    expect(all.size).toBe(2);
    expect(all.has('c')).toBe(false);
    expect(all.get('a')).toBe(10);
    expect(all.get('b')).toBe(5);
  });

  it('ranks streams with equal subscriber counts arbitrarily but consistently', async () => {
    const subs = new Map<string, Set<StubSocket>>();
    subs.set('equal-1', new Set(Array(5).fill(null).map(() => stubSocket())));
    subs.set('equal-2', new Set(Array(5).fill(null).map(() => stubSocket())));
    subs.set('equal-3', new Set(Array(5).fill(null).map(() => stubSocket())));

    const hub = makeFakeHub({ streamSubscriptions: subs });
    collectWsBackpressureMetrics(hub as AnyHub, 1_048_576, 2);

    const all = await readAllStreamLabels();
    expect(all.size).toBe(2);

    // All equal streams have 5 subscribers.
    for (const val of all.values()) {
      expect(val).toBe(5);
    }
  });

  it('resets the cardinality gauge state via resetWsBackpressureMetrics', async () => {
    const subs = new Map<string, Set<StubSocket>>();
    subs.set('reset-me', new Set(Array(3).fill(null).map(() => stubSocket())));

    const hub = makeFakeHub({ streamSubscriptions: subs });
    collectWsBackpressureMetrics(hub as AnyHub, 1_048_576, 10);
    expect(await readStreamLabel('reset-me')).toBe(3);

    resetWsBackpressureMetrics();

    const all = await readAllStreamLabels();
    expect(all.size).toBe(0);
  });

  it('handles streams with zero subscribers (empty Set)', async () => {
    const subs = new Map<string, Set<StubSocket>>();
    subs.set('empty-stream', new Set());
    subs.set('populated', new Set([stubSocket(), stubSocket()]));

    const hub = makeFakeHub({ streamSubscriptions: subs });
    collectWsBackpressureMetrics(hub as AnyHub, 1_048_576, 10);

    const all = await readAllStreamLabels();
    expect(all.size).toBe(2);
    expect(all.get('empty-stream')).toBe(0);
    expect(all.get('populated')).toBe(2);
  });

  it('produces stable output across consecutive identical collections', async () => {
    const subs = new Map<string, Set<StubSocket>>();
    subs.set('stable-1', new Set(Array(7).fill(null).map(() => stubSocket())));
    subs.set('stable-2', new Set(Array(3).fill(null).map(() => stubSocket())));

    const hub = makeFakeHub({ streamSubscriptions: subs });

    collectWsBackpressureMetrics(hub as AnyHub, 1_048_576, 10);
    const first = await readAllStreamLabels();

    collectWsBackpressureMetrics(hub as AnyHub, 1_048_576, 10);
    const second = await readAllStreamLabels();

    expect(second).toEqual(first);
  });
});
