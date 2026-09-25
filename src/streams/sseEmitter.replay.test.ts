/**
 * src/streams/sseEmitter.replay.test.ts
 *
 * Tests for the ring-buffer resumption layer inside sseEmitter:
 *   replayFromBuffer, SSE_REPLAY_BUFFER_SIZE, SseReplayExpiredError
 *
 * Acceptance criteria
 * ───────────────────
 * 1. Clients can resume from a last-event identifier.
 * 2. No event is skipped across a reconnect (within retention window).
 * 3. Retention is bounded: old events are evicted when the buffer is full.
 * 4. A resumption beyond retention throws SseReplayExpiredError explicitly.
 *
 * All tests exercise the described condition against sseEmitter.ts and assert
 * the documented outcome — no external DB or network is involved.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  replayFromBuffer,
  SseReplayExpiredError,
  SSE_REPLAY_BUFFER_SIZE,
  SSE_STREAM_UPDATE_EVENT,
  sseEventBus,
  _resetSseSubscriptionsForTest,
} from './sseEmitter.js';
import type { LiveSseStreamUpdateEvent } from './sseEmitter.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEvent(streamId: string, eventId: string): LiveSseStreamUpdateEvent {
  return { streamId, eventId, payload: { n: eventId } };
}

/** Emit `count` sequential events on the bus and return them in order. */
function emitN(streamId: string, count: number, prefix = 'evt'): LiveSseStreamUpdateEvent[] {
  const events: LiveSseStreamUpdateEvent[] = [];
  for (let i = 0; i < count; i++) {
    const e = makeEvent(streamId, `${prefix}-${i}`);
    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, e);
    events.push(e);
  }
  return events;
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetSseSubscriptionsForTest();
});

// ── 1. Resumption from a last-event identifier ────────────────────────────────

describe('replayFromBuffer — resumption from last-event-id', () => {
  it('returns events emitted strictly after the cursor', () => {
    const emitted = emitN('s1', 5);
    const replayed = replayFromBuffer('s1', emitted[1].eventId);

    expect(replayed).toHaveLength(3);
    expect(replayed[0].eventId).toBe('evt-2');
    expect(replayed[1].eventId).toBe('evt-3');
    expect(replayed[2].eventId).toBe('evt-4');
  });

  it('returns an empty array when the cursor is the most recent event', () => {
    const emitted = emitN('s2', 3);
    const replayed = replayFromBuffer('s2', emitted[2].eventId);
    expect(replayed).toHaveLength(0);
  });

  it('returns all buffered events when cursor is the very first event', () => {
    const emitted = emitN('s3', 4);
    const replayed = replayFromBuffer('s3', emitted[0].eventId);
    expect(replayed).toHaveLength(3);
    expect(replayed.map((e) => e.eventId)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });
});

// ── 2. No event skipped across a reconnect ────────────────────────────────────

describe('replayFromBuffer — no gap across reconnect', () => {
  it('replays all events missed between two connections without skipping', () => {
    // Connection A subscribes, receives first 3 events, disconnects at evt-2.
    const emitted = emitN('gap', 6);

    // Connection B reconnects with Last-Event-ID = evt-2 (last received).
    const replayed = replayFromBuffer('gap', emitted[2].eventId);

    // Must deliver evt-3, evt-4, evt-5 — nothing skipped.
    expect(replayed).toHaveLength(3);
    expect(replayed.map((e) => e.eventId)).toEqual(['evt-3', 'evt-4', 'evt-5']);
  });

  it('replay result payloads match original emissions exactly', () => {
    const emitted = emitN('payload-check', 4);
    const replayed = replayFromBuffer('payload-check', emitted[0].eventId);

    for (let i = 0; i < replayed.length; i++) {
      expect(replayed[i]).toEqual(emitted[i + 1]);
    }
  });

  it('events across multiple streams are isolated (no cross-stream bleed)', () => {
    emitN('stream-A', 3, 'a');
    emitN('stream-B', 3, 'b');

    const replayedA = replayFromBuffer('stream-A', 'a-0');
    const replayedB = replayFromBuffer('stream-B', 'b-0');

    expect(replayedA.every((e) => e.streamId === 'stream-A')).toBe(true);
    expect(replayedB.every((e) => e.streamId === 'stream-B')).toBe(true);
    expect(replayedA).toHaveLength(2);
    expect(replayedB).toHaveLength(2);
  });
});

// ── 3. Bounded retention ──────────────────────────────────────────────────────

describe('ring buffer — bounded retention', () => {
  it('SSE_REPLAY_BUFFER_SIZE is a positive integer', () => {
    expect(Number.isInteger(SSE_REPLAY_BUFFER_SIZE)).toBe(true);
    expect(SSE_REPLAY_BUFFER_SIZE).toBeGreaterThan(0);
  });

  it('never holds more than SSE_REPLAY_BUFFER_SIZE events per stream', () => {
    // Emit more than the cap.
    const count = SSE_REPLAY_BUFFER_SIZE + 10;
    emitN('bounded', count);

    // Cursor of a very early event — it was evicted.
    expect(() => replayFromBuffer('bounded', 'evt-0')).toThrow(SseReplayExpiredError);

    // The most recent SSE_REPLAY_BUFFER_SIZE events are still there.
    const lastEventId = `evt-${count - 2}`; // second-to-last
    const tail = replayFromBuffer('bounded', lastEventId);
    expect(tail).toHaveLength(1);
    expect(tail[0].eventId).toBe(`evt-${count - 1}`);
  });

  it('evicts oldest events when the buffer overflows (FIFO)', () => {
    const cap = SSE_REPLAY_BUFFER_SIZE;

    // Emit exactly cap + 1 events; the very first one must be evicted.
    emitN('fifo', cap + 1);

    // evt-0 was evicted — must throw.
    expect(() => replayFromBuffer('fifo', 'evt-0')).toThrow(SseReplayExpiredError);

    // evt-1 is the oldest surviving event — cursor on it must succeed.
    const fromEvt1 = replayFromBuffer('fifo', 'evt-1');
    // cap events were emitted after evt-1 (evt-2 … evt-{cap}) = cap - 1 events.
    expect(fromEvt1).toHaveLength(cap - 1);
    expect(fromEvt1[0].eventId).toBe('evt-2');
  });

  it('independent streams have independent retention budgets', () => {
    // Fill stream-X to exactly the cap.
    emitN('stream-X', SSE_REPLAY_BUFFER_SIZE);
    // Emit one event on stream-Y.
    emitN('stream-Y', 1);

    // stream-X is full; its first event is still inside retention (not evicted yet).
    const xFirst = replayFromBuffer('stream-X', 'evt-0');
    expect(xFirst.length).toBe(SSE_REPLAY_BUFFER_SIZE - 1);

    // stream-Y only has one event — cursor on it returns empty (nothing after it).
    const yEmpty = replayFromBuffer('stream-Y', 'evt-0');
    expect(yEmpty).toHaveLength(0);
  });
});

// ── 4. Resumption beyond retention reports explicitly ─────────────────────────

describe('replayFromBuffer — beyond-retention error', () => {
  it('throws SseReplayExpiredError when cursor has been evicted', () => {
    emitN('expired', SSE_REPLAY_BUFFER_SIZE + 5);

    expect(() => replayFromBuffer('expired', 'evt-0')).toThrow(SseReplayExpiredError);
  });

  it('SseReplayExpiredError carries the requested afterEventId', () => {
    emitN('expired2', SSE_REPLAY_BUFFER_SIZE + 1);

    let caught: SseReplayExpiredError | undefined;
    try {
      replayFromBuffer('expired2', 'evt-0');
    } catch (err) {
      if (err instanceof SseReplayExpiredError) caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught!.afterEventId).toBe('evt-0');
    expect(caught!.code).toBe('SSE_REPLAY_EXPIRED');
  });

  it('throws SseReplayExpiredError when the stream has no buffer at all', () => {
    // No events ever emitted for this stream in this process lifetime.
    expect(() => replayFromBuffer('never-seen', 'some-id')).toThrow(SseReplayExpiredError);
  });

  it('SseReplayExpiredError message is descriptive', () => {
    expect(() => replayFromBuffer('no-events', 'cursor-xyz')).toThrowError(
      /beyond the in-process retention window/,
    );
  });

  it('throws SseReplayExpiredError for an unknown cursor even when the buffer is non-empty', () => {
    emitN('partial', 3);
    // 'nonexistent-id' was never emitted.
    expect(() => replayFromBuffer('partial', 'nonexistent-id')).toThrow(SseReplayExpiredError);
  });
});

// ── 5. Buffer–subscriber ordering guarantee ───────────────────────────────────

describe('buffer populated before subscriber fan-out', () => {
  it('cursor is in the buffer by the time a subscriber fires', () => {
    let bufferSnapshotDuringDelivery: ReturnType<typeof replayFromBuffer> | undefined;
    let eventIdSeen: string | undefined;

    // Subscribe before emitting.
    sseEventBus.once(SSE_STREAM_UPDATE_EVENT, (e: LiveSseStreamUpdateEvent) => {
      eventIdSeen = e.eventId;
      // At this point bufferLiveEvent has already run because dispatch does
      // bufferLiveEvent(event) BEFORE fan-out.  Prove that by calling replay
      // with an id that does not exist — which means the event is in the buffer
      // already, so using the event itself as cursor returns [].
      bufferSnapshotDuringDelivery = replayFromBuffer(e.streamId, e.eventId);
    });

    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, makeEvent('order-check', 'first'));

    expect(eventIdSeen).toBe('first');
    // Cursor on the just-delivered event → nothing after it yet.
    expect(bufferSnapshotDuringDelivery).toEqual([]);
  });

  it('subsequent event is replayable immediately after emission', () => {
    const [a, b] = emitN('seq', 2);
    const replayed = replayFromBuffer('seq', a.eventId);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toEqual(b);
  });
});

// ── 6. Reset clears the buffer ────────────────────────────────────────────────

describe('_resetSseSubscriptionsForTest clears replay buffer', () => {
  it('throws SseReplayExpiredError after reset for a previously emitted cursor', () => {
    emitN('will-be-reset', 3);

    _resetSseSubscriptionsForTest();

    expect(() => replayFromBuffer('will-be-reset', 'evt-0')).toThrow(SseReplayExpiredError);
  });
});
