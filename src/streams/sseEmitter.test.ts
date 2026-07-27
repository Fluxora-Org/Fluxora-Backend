import { test, expect, beforeEach, vi } from 'vitest';
import {
  subscribeToSseStreamWithBackpressure,
  sseEventBus,
  SSE_STREAM_UPDATE_EVENT,
  SSE_CLOSE_REASONS,
  SSE_MAX_BUFFERED_EVENTS,
  _resetSseSubscriptionsForTest,
} from './sseEmitter.js';
import type { LiveSseStreamUpdateEvent } from './sseEmitter.js';

beforeEach(() => {
  _resetSseSubscriptionsForTest();
});

function makeEvent(streamId: string, eventId: string): LiveSseStreamUpdateEvent {
  return { streamId, eventId, payload: { test: true } };
}

// ── basic functionality ─────────────────────────────────────────────────────

test('subscribeToSseStreamWithBackpressure delivers events normally under cap', () => {
  const received: LiveSseStreamUpdateEvent[] = [];
  const unsub = subscribeToSseStreamWithBackpressure('stream-1', (event) => {
    received.push(event);
  });

  const event = makeEvent('stream-1', 'evt-1');
  sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, event);

  expect(received).toHaveLength(1);
  expect(received[0]).toEqual(event);

  unsub();
});

test('subscribeToSseStreamWithBackpressure decrements buffer after successful delivery', () => {
  let delivered = 0;
  const unsub = subscribeToSseStreamWithBackpressure(
    'stream-1',
    () => {
      delivered++;
    },
    { maxBufferedEvents: 5 },
  );

  // Send 10 events — should all deliver since each decrements after
  for (let i = 0; i < 10; i++) {
    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, makeEvent('stream-1', `evt-${i}`));
  }

  expect(delivered).toBe(10);
  unsub();
});

// ── backpressure drop ───────────────────────────────────────────────────────

test('subscribeToSseStreamWithBackpressure drops connection when buffer exceeds cap', () => {
  let dropReason: string | undefined;
  let delivered = 0;

  const unsub = subscribeToSseStreamWithBackpressure(
    'stream-1',
    (event) => {
      delivered++;
      // Simulate slow consumer — don't drain, let buffer grow
      // Actually the buffer decrements in finally block after delivery
      // So we need to throw to prevent decrement
      throw new Error('slow consumer');
    },
    {
      maxBufferedEvents: 3,
      onBackpressureDrop: (reason) => {
        dropReason = reason;
      },
    },
  );

  // Send 4 events — 4th should trigger drop
  for (let i = 0; i < 4; i++) {
    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, makeEvent('stream-1', `evt-${i}`));
  }

  expect(delivered).toBe(3); // 3 delivered before drop
  expect(dropReason).toBe(SSE_CLOSE_REASONS.BACKPRESSURE);

  // 5th event should not deliver (dropped)
  sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, makeEvent('stream-1', 'evt-4'));
  expect(delivered).toBe(3);

  unsub();
});

test('subscribeToSseStreamWithBackpressure respects custom maxBufferedEvents', () => {
  let dropCount = 0;
  let delivered = 0;

  const unsub = subscribeToSseStreamWithBackpressure(
    'stream-1',
    () => {
      delivered++;
      throw new Error('block drain');
    },
    {
      maxBufferedEvents: 10,
      onBackpressureDrop: () => {
        dropCount++;
      },
    },
  );

  // Send 11 events — 11th should trigger drop
  for (let i = 0; i < 11; i++) {
    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, makeEvent('stream-1', `evt-${i}`));
  }

  expect(delivered).toBe(10);
  expect(dropCount).toBe(1);

  unsub();
});

// ── edge cases ──────────────────────────────────────────────────────────────

test('subscribeToSseStreamWithBackpressure handles maxBufferedEvents = 1', () => {
  let dropReason: string | undefined;
  let delivered = 0;

  const unsub = subscribeToSseStreamWithBackpressure(
    'stream-1',
    () => {
      delivered++;
      throw new Error('block');
    },
    {
      maxBufferedEvents: 1,
      onBackpressureDrop: (reason) => {
        dropReason = reason;
      },
    },
  );

  // 1st event delivers, 2nd triggers drop
  sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, makeEvent('stream-1', 'evt-1'));
  expect(delivered).toBe(1);

  sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, makeEvent('stream-1', 'evt-2'));
  expect(delivered).toBe(1);
  expect(dropReason).toBe(SSE_CLOSE_REASONS.BACKPRESSURE);

  unsub();
});

test('subscribeToSseStreamWithBackpressure ignores events after drop', () => {
  let delivered = 0;
  let dropped = false;

  const unsub = subscribeToSseStreamWithBackpressure(
    'stream-1',
    () => {
      delivered++;
      throw new Error('block');
    },
    {
      maxBufferedEvents: 2,
      onBackpressureDrop: () => {
        dropped = true;
      },
    },
  );

  // Trigger drop on 3rd event
  for (let i = 0; i < 3; i++) {
    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, makeEvent('stream-1', `evt-${i}`));
  }

  expect(dropped).toBe(true);
  const deliveredBeforeExtra = delivered;

  // Send more events — should be ignored
  for (let i = 0; i < 5; i++) {
    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, makeEvent('stream-1', `extra-${i}`));
  }

  expect(delivered).toBe(deliveredBeforeExtra);
  unsub();
});

test('subscribeToSseStreamWithBackpressure cleanup works after drop', () => {
  let dropped = false;

  const unsub = subscribeToSseStreamWithBackpressure(
    'stream-1',
    () => {
      throw new Error('block');
    },
    {
      maxBufferedEvents: 1,
      onBackpressureDrop: () => {
        dropped = true;
      },
    },
  );

  // Trigger drop
  sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, makeEvent('stream-1', 'evt-1'));
  sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, makeEvent('stream-1', 'evt-2'));

  expect(dropped).toBe(true);

  // Unsubscribe should work without error
  expect(() => unsub()).not.toThrow();

  // Calling again should be idempotent
  expect(() => unsub()).not.toThrow();
});

// ── SSE_MAX_BUFFERED_EVENTS constant ────────────────────────────────────────

test('SSE_MAX_BUFFERED_EVENTS is a positive integer', () => {
  expect(typeof SSE_MAX_BUFFERED_EVENTS).toBe('number');
  expect(Number.isInteger(SSE_MAX_BUFFERED_EVENTS)).toBe(true);
  expect(SSE_MAX_BUFFERED_EVENTS).toBeGreaterThan(0);
});
