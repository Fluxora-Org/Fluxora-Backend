import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('../metrics/wsBackpressure.js', () => ({
  recordWsBroadcastBatchFlushLatency: vi.fn(),
  wsBatchEventsCoalescedTotal: { inc: vi.fn() },
  wsBatchFlushTotal: { inc: vi.fn() },
  wsBatchSizeExceededTotal: { inc: vi.fn() },
}));

import {
  wsBatchEventsCoalescedTotal,
  wsBatchFlushTotal,
  wsBatchSizeExceededTotal,
} from '../metrics/wsBackpressure.js';
import { BatchAccumulator } from './batching.js';
import { MAX_MESSAGE_BYTES } from './hubConfig.js';
import type { BatchedEvent, ClientState } from './hubTypes.js';

function fakeSocket(open = true) {
  return { readyState: open ? WebSocket.OPEN : WebSocket.CLOSED } as unknown as WebSocket;
}

function makeState(id: string): ClientState {
  return { id } as unknown as ClientState;
}

function makeEvent(i: number, streamId = 's1', extra: Partial<BatchedEvent> = {}): BatchedEvent {
  return { eventId: `e${i}`, streamId, payload: { i }, ...extra } as BatchedEvent;
}

describe('BatchAccumulator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes a partial batch when the flush window elapses', () => {
    const deliver = vi.fn(() => true);
    const acc = new BatchAccumulator(50, 10, deliver);
    const ws = fakeSocket();
    const state = makeState('c1');

    acc.enqueue(ws, state, makeEvent(1));
    acc.enqueue(ws, state, makeEvent(2));
    expect(deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(49);
    expect(deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [, message, frames] = deliver.mock.calls[0] as unknown as [WebSocket, string, number];
    expect(frames).toBe(2);
    const parsed = JSON.parse(message);
    expect(parsed.type).toBe('stream_update_batch');
    expect(parsed.streamId).toBe('s1');
    expect(parsed.events.map((e: { eventId: string }) => e.eventId)).toEqual(['e1', 'e2']);
    expect(wsBatchFlushTotal.inc).toHaveBeenCalledTimes(1);
    expect(wsBatchEventsCoalescedTotal.inc).toHaveBeenCalledWith(2);
    expect(wsBatchSizeExceededTotal.inc).not.toHaveBeenCalled();
  });

  it('flushes immediately when the batch reaches maxSize', () => {
    const deliver = vi.fn(() => true);
    const acc = new BatchAccumulator(1000, 3, deliver);
    const ws = fakeSocket();
    const state = makeState('c1');

    acc.enqueue(ws, state, makeEvent(1));
    acc.enqueue(ws, state, makeEvent(2));
    expect(deliver).not.toHaveBeenCalled();

    acc.enqueue(ws, state, makeEvent(3));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][2]).toBe(3);
    expect(wsBatchSizeExceededTotal.inc).toHaveBeenCalledTimes(1);

    // The timer for the flushed window must have been cancelled.
    vi.advanceTimersByTime(5000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh window after a size-triggered flush', () => {
    const deliver = vi.fn(() => true);
    const acc = new BatchAccumulator(100, 2, deliver);
    const ws = fakeSocket();
    const state = makeState('c1');

    acc.enqueue(ws, state, makeEvent(1));
    acc.enqueue(ws, state, makeEvent(2));
    expect(deliver).toHaveBeenCalledTimes(1);

    acc.enqueue(ws, state, makeEvent(3));
    vi.advanceTimersByTime(100);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][2]).toBe(1);
  });

  it('keeps accumulators separate per connection and stream', () => {
    const deliver = vi.fn(() => true);
    const acc = new BatchAccumulator(10, 100, deliver);
    const ws = fakeSocket();

    acc.enqueue(ws, makeState('c1'), makeEvent(1, 's1'));
    acc.enqueue(ws, makeState('c1'), makeEvent(2, 's2'));
    acc.enqueue(ws, makeState('c2'), makeEvent(3, 's1'));

    vi.advanceTimersByTime(10);
    expect(deliver).toHaveBeenCalledTimes(3);
    for (const call of deliver.mock.calls) {
      expect(call[2]).toBe(1);
    }
  });

  it('does not send when the socket is not open, but still clears state', () => {
    const deliver = vi.fn(() => true);
    const acc = new BatchAccumulator(10, 100, deliver);
    const ws = fakeSocket(false);

    acc.enqueue(ws, makeState('c1'), makeEvent(1));
    vi.advanceTimersByTime(10);
    expect(deliver).not.toHaveBeenCalled();
    expect(wsBatchFlushTotal.inc).not.toHaveBeenCalled();
  });

  it('counts refused frames as not flushed when deliver returns false', () => {
    const deliver = vi.fn(() => false);
    const acc = new BatchAccumulator(10, 2, deliver);
    const ws = fakeSocket();
    const state = makeState('c1');

    acc.enqueue(ws, state, makeEvent(1));
    acc.enqueue(ws, state, makeEvent(2));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(wsBatchFlushTotal.inc).not.toHaveBeenCalled();
    expect(wsBatchEventsCoalescedTotal.inc).not.toHaveBeenCalled();
    expect(wsBatchSizeExceededTotal.inc).not.toHaveBeenCalled();
  });

  it('truncates oversized frames to the largest prefix under MAX_MESSAGE_BYTES', () => {
    const deliver = vi.fn(() => true);
    const acc = new BatchAccumulator(10, 1000, deliver);
    const ws = fakeSocket();
    const state = makeState('c1');
    const big = 'x'.repeat(Math.floor(MAX_MESSAGE_BYTES / 4));

    for (let i = 0; i < 8; i++) {
      acc.enqueue(ws, state, makeEvent(i, 's1', { payload: { big } }));
    }
    vi.advanceTimersByTime(10);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [, message, frames] = deliver.mock.calls[0] as unknown as [WebSocket, string, number];
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThan(8);
    expect(JSON.parse(message).events).toHaveLength(frames);
  });

  it('clearConnection cancels only that connection\'s pending batches', () => {
    const deliver = vi.fn(() => true);
    const acc = new BatchAccumulator(10, 100, deliver);
    const ws = fakeSocket();

    acc.enqueue(ws, makeState('c1'), makeEvent(1));
    acc.enqueue(ws, makeState('c2'), makeEvent(2));

    acc.clearConnection('c1');
    vi.advanceTimersByTime(10);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(JSON.parse(deliver.mock.calls[0][1]).events[0].eventId).toBe('e2');
  });

  it('clearAll cancels every pending batch', () => {
    const deliver = vi.fn(() => true);
    const acc = new BatchAccumulator(10, 100, deliver);
    const ws = fakeSocket();

    acc.enqueue(ws, makeState('c1'), makeEvent(1));
    acc.enqueue(ws, makeState('c2'), makeEvent(2));

    acc.clearAll();
    vi.advanceTimersByTime(1000);
    expect(deliver).not.toHaveBeenCalled();
  });
});
