import { EventEmitter } from 'node:events';
import type { StreamEventRecord } from '../db/types.js';
import { traceSseDispatch } from '../tracing/hooks.js';

export const SSE_STREAM_UPDATE_EVENT = 'stream_update';

// Central EventEmitter to handle SSE broadcast subscriptions locally.
export const sseEventBus = new EventEmitter();

// Defensive baseline for non-route listeners. Live SSE route fan-out below uses
// one shared dispatcher listener, so EventEmitter listener count does not grow
// linearly with active SSE connections.
sseEventBus.setMaxListeners(1000);

export interface LiveSseStreamUpdateEvent {
  streamId: string;
  eventId: string;
  payload: unknown;
  correlationId?: string;
}

export type SseStreamSubscriber = (event: LiveSseStreamUpdateEvent) => void;

const liveSubscribersByStreamId = new Map<string, Set<SseStreamSubscriber>>();

function totalLiveSubscriberCount(): number {
  let total = 0;
  for (const subscribers of liveSubscribersByStreamId.values()) {
    total += subscribers.size;
  }
  return total;
}

function dispatchLiveSseEvent(event: LiveSseStreamUpdateEvent): void {
  if (!event || typeof event.streamId !== 'string') return;

  const subscribers = liveSubscribersByStreamId.get(event.streamId);
  if (!subscribers || subscribers.size === 0) return;

  // Snapshot before iterating so a subscriber can disconnect during delivery
  // without mutating the Set currently being traversed.
  traceSseDispatch(event.streamId, event.eventId, subscribers.size, event.correlationId, () => {
    for (const subscriber of Array.from(subscribers)) {
      try {
        subscriber(event);
      } catch {
        // Isolate one failing connection from the rest of the stream fan-out.
      }
    }
  });
}

function isDispatchAttached(): boolean {
  return sseEventBus.listeners(SSE_STREAM_UPDATE_EVENT).includes(dispatchLiveSseEvent);
}

function ensureDispatchAttached(): void {
  if (!isDispatchAttached()) {
    sseEventBus.on(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
  }
}

function detachDispatchIfIdle(): void {
  if (totalLiveSubscriberCount() === 0) {
    sseEventBus.off(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
  }
}

/**
 * Register one live SSE subscriber for a stream ID.
 *
 * The process attaches exactly one listener to `sseEventBus` and multiplexes
 * live updates through an in-memory streamId -> subscriber Set. This keeps
 * EventEmitter listener count O(1) while per-event fan-out is O(number of
 * subscribers to the updated stream), not O(all active SSE connections).
 */
export function subscribeToSseStream(
  streamId: string,
  subscriber: SseStreamSubscriber,
): () => void {
  let subscribers = liveSubscribersByStreamId.get(streamId);
  if (!subscribers) {
    subscribers = new Set<SseStreamSubscriber>();
    liveSubscribersByStreamId.set(streamId, subscribers);
  }

  subscribers.add(subscriber);
  ensureDispatchAttached();

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;

    const current = liveSubscribersByStreamId.get(streamId);
    if (!current) return;

    current.delete(subscriber);
    if (current.size === 0) {
      liveSubscribersByStreamId.delete(streamId);
    }
    detachDispatchIfIdle();
  };
}

export function getLiveSseSubscriberCount(streamId?: string): number {
  if (streamId !== undefined) {
    return liveSubscribersByStreamId.get(streamId)?.size ?? 0;
  }
  return totalLiveSubscriberCount();
}

export function _resetSseSubscriptionsForTest(): void {
  liveSubscribersByStreamId.clear();
  sseEventBus.off(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
}

/**
 * Checks if a historical or live StreamEventRecord belongs to a specific stream ID.
 *
 * Mapping logic:
 * 1. Matches exact stream ID inside the payload under `id` or `streamId`.
 * 2. If the topic is 'stream.created', checks if the transaction hash and event index
 *    combine deterministically to form the requested stream ID: `stream-{txHash}-{eventIndex}`.
 */
export function eventMatchesStreamId(event: StreamEventRecord, id: string): boolean {
  if (!event || !id) return false;

  const payload = event.payload;
  if (payload) {
    if (payload.id === id || payload.streamId === id) {
      return true;
    }
  }

  if (event.txHash && typeof event.eventIndex === 'number') {
    const derivedId = `stream-${event.txHash}-${event.eventIndex}`;
    if (derivedId === id) return true;
  }

  return false;
}
