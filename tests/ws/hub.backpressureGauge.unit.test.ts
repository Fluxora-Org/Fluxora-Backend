/**
 * tests/ws/hub.backpressureGauge.unit.test.ts
 *
 * Stub-based unit tests for the per-client WebSocket backpressure gauge.
 *
 * This file intentionally avoids the `createSlowClient` fixture (which has
 * a pre-existing `findServerSocket` flake in the test environment) and
 * instead drives `collectWsBackpressureMetrics` and
 * `removeWsClientBackpressureGauge` against a hand-built `StreamHub`-like
 * object with three synthetic `WebSocket`s. This guarantees the rise/clear
 * invariant — the one the PR template explicitly requires — runs in CI.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  collectWsBackpressureMetrics,
  removeWsClientBackpressureGauge,
  resetWsBackpressureMetrics,
  wsClientBufferedBytes,
  wsMaxBufferedBytes,
  wsSlowClients,
} from '../../src/metrics/wsBackpressure.js';

type Buffered = () => number;
type ReadyStateValue = number;

/**
 * Minimal WebSocket stub — only the two properties the collector reads.
 */
interface StubSocket extends Pick<WebSocket, 'OPEN' | 'CLOSING' | 'CLOSED'> {
  OPEN: 1;
  CLOSING: 2;
  CLOSED: 3;
  readyState: ReadyStateValue;
  bufferedAmount: number;
}

const stubSocket = (initialBuffered: number): StubSocket => {
  const ws = {
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    readyState: 1,
    bufferedAmount: initialBuffered,
  } as unknown as StubSocket;
  return ws;
};

interface FakeClientState {
  id: string;
}

/**
 * Builds a `_getClients()`-shaped hub stand-in. The collector only reads
 * `ws.readyState`, `ws.bufferedAmount`, and `state.id`.
 */
function makeFakeHub(
  clients: Array<[StubSocket, FakeClientState]>,
): { _getClients: () => IterableIterator<[StubSocket, FakeClientState]> } {
  return {
    _getClients: function* () {
      for (const entry of clients) yield entry;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHub = any;

describe('Per-client backpressure gauge (stub-based unit tests)', () => {
  beforeEach(() => {
    resetWsBackpressureMetrics();
  });

  afterEach(() => {
    resetWsBackpressureMetrics();
  });

  it('records the rise of buffered bytes per connection_id', async () => {
    const hub = makeFakeHub([
      [stubSocket(0), { id: 'conn-A' }],
      [stubSocket(0), { id: 'conn-B' }],
    ]);

    const result1 = await wsClientBufferedBytes.get();
    expect(result1.values).toEqual([]);

    // Snapshot empty state — slow count is zero, max is zero.
    collectWsBackpressureMetrics(hub as AnyHub);
    expect(await readLabel(wsClientBufferedBytes, 'conn-A')).toBe(0);
    expect(await readLabel(wsClientBufferedBytes, 'conn-B')).toBe(0);
    expect(await readGauge(wsSlowClients)).toBe(0);
    expect(await readGauge(wsMaxBufferedBytes)).toBe(0);

    // Drive conn-A's bufferedAmount up — the gauge should rise in lockstep.
    {
      const [ws] = (hub._getClients().next().value as [StubSocket, FakeClientState]);
      ws.bufferedAmount = 2_500_000;
    }
    collectWsBackpressureMetrics(hub as AnyHub);

    expect(await readLabel(wsClientBufferedBytes, 'conn-A')).toBe(2_500_000);
    expect(await readGauge(wsSlowClients)).toBe(1); // > 1 MiB threshold
    expect(await readGauge(wsMaxBufferedBytes)).toBe(2_500_000);
  });

  it('clears the per-client gauge label on disconnect (bounded cardinality)', async () => {
    const ws = stubSocket(777_777);
    const hub = makeFakeHub([[ws, { id: 'conn-disconnect' }]]);

    collectWsBackpressureMetrics(hub as AnyHub);
    expect(await readLabel(wsClientBufferedBytes, 'conn-disconnect')).toBe(777_777);

    // Simulate onDisconnect: remove the series explicitly (same call hub.ts
    // makes in onDisconnect).
    removeWsClientBackpressureGauge('conn-disconnect');

    expect(await readLabel(wsClientBufferedBytes, 'conn-disconnect')).toBeNull();
  });

  it('clears the gauge time series when all clients disconnect (rise-then-clear)', async () => {
    const hub = makeFakeHub([
      [stubSocket(8 * 1024 * 1024), { id: 'conn-rise' }],
      [stubSocket(2 * 1024 * 1024), { id: 'conn-rise-2' }],
    ]);

    collectWsBackpressureMetrics(hub as AnyHub);
    expect(await readLabel(wsClientBufferedBytes, 'conn-rise')).toBe(8 * 1024 * 1024);
    expect(await readGauge(wsSlowClients)).toBe(2);
    expect(await readGauge(wsMaxBufferedBytes)).toBe(8 * 1024 * 1024);

    // Both clients disconnect.
    removeWsClientBackpressureGauge('conn-rise');
    removeWsClientBackpressureGauge('conn-rise-2');

    // Hub cleans up after disconnect; no live clients left.
    collectWsBackpressureMetrics(makeFakeHub([]) as AnyHub);
    expect(await readLabel(wsClientBufferedBytes, 'conn-rise')).toBeNull();
    expect(await readLabel(wsClientBufferedBytes, 'conn-rise-2')).toBeNull();
    expect(await readGauge(wsSlowClients)).toBe(0);
    expect(await readGauge(wsMaxBufferedBytes)).toBe(0);
  });

  it('skips sockets whose readyState is not OPEN', async () => {
    const a = stubSocket(100);
    const b = stubSocket(200);
    b.readyState = 2; // CLOSING
    const hub = makeFakeHub([
      [a, { id: 'conn-open' }],
      [b, { id: 'conn-closing' }],
    ]);

    collectWsBackpressureMetrics(hub as AnyHub);
    expect(await readLabel(wsClientBufferedBytes, 'conn-open')).toBe(100);
    expect(await readLabel(wsClientBufferedBytes, 'conn-closing')).toBeNull();
  });

  it('respects a custom slow threshold', async () => {
    const hub = makeFakeHub([
      [stubSocket(100), { id: 'low' }],
      [stubSocket(500), { id: 'high' }],
    ]);

    collectWsBackpressureMetrics(hub as AnyHub, 250);
    expect(await readGauge(wsSlowClients)).toBe(1); // only "high" > 250
  });

  it('treats undefined bufferedAmount as 0 (defensive fallback)', async () => {
    const ws = stubSocket(0);
    Object.defineProperty(ws, 'bufferedAmount', {
      configurable: true,
      get: (() => undefined) as Buffered,
    });
    const hub = makeFakeHub([[ws, { id: 'conn-undef' }]]);

    collectWsBackpressureMetrics(hub as AnyHub);
    expect(await readLabel(wsClientBufferedBytes, 'conn-undef')).toBe(0);
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  async function readLabel(
    gauge: typeof wsClientBufferedBytes,
    connectionId: string,
  ): Promise<number | null> {
    const result = (await gauge.get()) as { values: Array<{ labels: Record<string, string>; value: number }> };
    const match = result.values.find((v) => v.labels?.connection_id === connectionId);
    return match ? match.value : null;
  }

  async function readGauge(
    gauge: typeof wsMaxBufferedBytes,
  ): Promise<number> {
    const result = (await gauge.get()) as { values: Array<{ value: number }> };
    return result.values[0]?.value ?? 0;
  }
});
