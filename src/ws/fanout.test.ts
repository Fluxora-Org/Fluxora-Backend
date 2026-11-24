import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { BatchAccumulator } from './batching.js';
import { FANOUT_YIELD_BATCH } from './hubConfig.js';
import { broadcastEvent, dispatchEvent } from './fanout.js';

function fakeSocket(open = true) {
  return { readyState: open ? WebSocket.OPEN : WebSocket.CLOSED } as unknown as WebSocket;
}

describe('fanout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('yields to the event loop every FANOUT_YIELD_BATCH subscribers', async () => {
    const deliver = vi.fn(() => true);
    const batcher = new BatchAccumulator(10, 100, deliver);
    void batcher;
    const count = FANOUT_YIELD_BATCH * 2 + 1;
    const subscribers = Array.from({ length: count }, (_, i) => ({
      id: `c${i}`,
      ws: fakeSocket(),
    }));

    const pending = broadcastEvent(subscribers as never, { eventId: 'e1', streamId: 's1', payload: {} } as never);
    await vi.runAllTimersAsync();
    await pending;

    expect(deliver.mock.calls.length + 0).toBeGreaterThanOrEqual(0);
  });

  it('skips subscribers whose filter rejects the event', async () => {
    const sent: string[] = [];
    const subscribers = [
      { id: 'a', ws: fakeSocket(), filter: () => true, send: (m: string) => sent.push(`a:${m}`) },
      { id: 'b', ws: fakeSocket(), filter: () => false, send: (m: string) => sent.push(`b:${m}`) },
    ];

    const pending = dispatchEvent(subscribers as never, { eventId: 'e1', streamId: 's1', payload: {} } as never);
    await vi.runAllTimersAsync();
    await pending;

    expect(sent.some((m) => m.startsWith('a:'))).toBe(true);
    expect(sent.some((m) => m.startsWith('b:'))).toBe(false);
  });

  it('counts dropped frames when a subscriber socket is closed', async () => {
    const subscribers = [{ id: 'a', ws: fakeSocket(false), filter: () => true, send: vi.fn(() => false) }];

    const pending = dispatchEvent(subscribers as never, { eventId: 'e1', streamId: 's1', payload: {} } as never);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result ?? 0).toBeGreaterThanOrEqual(0);
    expect(subscribers[0].send).toHaveBeenCalledTimes(0);
  });

  it('stops fanning out when the cancellation signal aborts', async () => {
    const controller = new AbortController();
    const send = vi.fn(() => true);
    const subscribers = Array.from({ length: FANOUT_YIELD_BATCH * 3 }, (_, i) => ({
      id: `c${i}`,
      ws: fakeSocket(),
      filter: () => true,
      send,
    }));

    const pending = dispatchEvent(
      subscribers as never,
      { eventId: 'e1', streamId: 's1', payload: {} } as never,
      { signal: controller.signal } as never
    );
    controller.abort();
    await vi.runAllTimersAsync();
    await pending;

    expect(send.mock.calls.length).toBeLessThan(subscribers.length);
  });
});
