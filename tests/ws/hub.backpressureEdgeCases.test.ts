import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectWsBackpressureMetrics,
  removeWsClientBackpressureGauge,
  resetWsBackpressureMetrics,
  wsClientBufferedBytes,
  wsMaxBufferedBytes,
  wsSlowClients,
  wsStreamSubscriberCount,
} from '../../src/metrics/wsBackpressure.js';

interface StubSocket {
  OPEN: 1;
  CLOSING: 2;
  CLOSED: 3;
  readyState: number;
  bufferedAmount: number;
}

const stubSocket = (initialBuffered: number): StubSocket =>
  ({
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    readyState: 1,
    bufferedAmount: initialBuffered,
  }) as unknown as StubSocket;

function makeFakeHub(
  clients: Array<[StubSocket, { id: string }]>,
  streamSubs?: Map<string, Set<unknown>>,
) {
  return {
    _getClients: function* () {
      for (const entry of clients) yield entry;
    },
    _getStreamSubscriptions: () => streamSubs ?? new Map(),
  };
}

type AnyHub = any;

describe('WebSocket backpressure edge cases', () => {
  beforeEach(() => {
    resetWsBackpressureMetrics();
  });

  afterEach(() => {
    resetWsBackpressureMetrics();
  });

  it('clamps negative slowThresholdBytes to 0', async () => {
    const hub = makeFakeHub([
      [stubSocket(500), { id: 'conn-a' }],
    ]);
    collectWsBackpressureMetrics(hub as AnyHub, -100);
    expect(await readGauge(wsSlowClients)).toBe(1);
  });

  it('clamps topN less than 1 to 1', async () => {
    const subs = new Map<string, Set<unknown>>([
      ['stream-a', new Set(['c1', 'c2'])],
      ['stream-b', new Set(['c3'])],
    ]);
    const hub = makeFakeHub([], subs);
    collectWsBackpressureMetrics(
      { _getStreamSubscriptions: () => subs } as AnyHub,
      undefined,
      -5,
    );
    const result = await wsStreamSubscriberCount.get() as { values: Array<{ labels: Record<string, string>; value: number }> };
    expect(result.values.length).toBe(1);
    expect(result.values[0].labels.stream_id).toBe('stream-a');
  });

  it('skips clients with missing state.id', async () => {
    const ws = stubSocket(100);
    const hub = makeFakeHub([
      [ws, { id: '' }],
    ]);
    collectWsBackpressureMetrics(hub as AnyHub);
    const result = await wsClientBufferedBytes.get() as { values: Array<{ labels: Record<string, string>; value: number }> };
    expect(result.values).toEqual([]);
  });

  it('handles undefined hub methods gracefully', () => {
    expect(() => collectWsBackpressureMetrics({} as AnyHub)).not.toThrow();
  });

  it('handles missing _getClients without error', () => {
    const hub = { _getStreamSubscriptions: () => new Map() };
    expect(() => collectWsBackpressureMetrics(hub as AnyHub)).not.toThrow();
  });

  it('handles empty client list without error', async () => {
    const hub = makeFakeHub([]);
    collectWsBackpressureMetrics(hub as AnyHub);
    expect(await readGauge(wsMaxBufferedBytes)).toBe(0);
    expect(await readGauge(wsSlowClients)).toBe(0);
  });

  it('treats negative bufferedAmount as 0', async () => {
    const ws = stubSocket(-100);
    const hub = makeFakeHub([[ws, { id: 'conn-neg' }]]);
    collectWsBackpressureMetrics(hub as AnyHub);
    expect(await readLabel(wsClientBufferedBytes, 'conn-neg')).toBe(0);
  });

  it('handles stream subscription set being undefined', async () => {
    const subs = new Map<string, Set<unknown> | undefined>([
      ['stream-a', undefined],
    ]);
    const hub = {
      _getStreamSubscriptions: () => subs,
    };
    expect(() => collectWsBackpressureMetrics(hub as AnyHub)).not.toThrow();
  });

  it('removes gauge label after disconnect', async () => {
    const hub = makeFakeHub([[stubSocket(500), { id: 'conn-rm' }]]);
    collectWsBackpressureMetrics(hub as AnyHub);
    expect(await readLabel(wsClientBufferedBytes, 'conn-rm')).toBe(500);

    removeWsClientBackpressureGauge('conn-rm');
    expect(await readLabel(wsClientBufferedBytes, 'conn-rm')).toBeNull();
  });

  async function readLabel(
    gauge: typeof wsClientBufferedBytes,
    connectionId: string,
  ): Promise<number | null> {
    const result = await gauge.get() as { values: Array<{ labels: Record<string, string>; value: number }> };
    const match = result.values.find((v) => v.labels?.connection_id === connectionId);
    return match ? match.value : null;
  }

  async function readGauge(
    gauge: typeof wsMaxBufferedBytes,
  ): Promise<number> {
    const result = await gauge.get() as { values: Array<{ value: number }> };
    return result.values[0]?.value ?? 0;
  }
});
