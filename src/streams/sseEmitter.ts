import { EventEmitter } from 'node:events';
import type { StreamEventRecord } from '../db/types.js';
import {
  sseLiveSubscribersGauge,
  sseEventListenersGauge,
} from '../metrics/businessMetrics.js';
import { logger } from '../lib/logger.js';

export const SSE_STREAM_UPDATE_EVENT = 'stream_update';

/**
 * The SSE event type emitted for deliberate server-side connection closure.
 *
 * Clients that receive `event: close` should inspect `data.reason` to decide
 * whether to reconnect immediately (e.g. `max_duration`) or back off
 * (e.g. `server_shutdown`).  This string is the single source of truth — both
 * the emitter (`streams.ts`) and the test suite import it from here.
 *
 * @security The payload carries only the reason enum — no stream data or user
 *   information is included.
 */
export const SSE_CLOSE_EVENT = 'close';

/**
 * Canonical reason strings embedded in the `event: close` data payload.
 * Keeping them here prevents silent divergence between the route and tests.
 */
export const SSE_CLOSE_REASONS = {
  /** The connection reached its configured max-duration limit. */
  MAX_DURATION: 'max_duration',
  /** The server is shutting down and instructing clients to stop reconnecting. */
  SERVER_SHUTDOWN: 'server_shutdown',
} as const;

export type SseCloseReason = typeof SSE_CLOSE_REASONS[keyof typeof SSE_CLOSE_REASONS];


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
  for (const subscriber of Array.from(subscribers)) {
    try {
      subscriber(event);
    } catch {
      // Isolate one failing connection from the rest of the stream fan-out.
    }
  }
}

function isDispatchAttached(): boolean {
  return sseEventBus.listeners(SSE_STREAM_UPDATE_EVENT).includes(dispatchLiveSseEvent);
}

function ensureDispatchAttached(): void {
  if (!isDispatchAttached()) {
    sseEventBus.on(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
    sseEventListenersGauge.set(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT));
  }
}

function detachDispatchIfIdle(): void {
  if (totalLiveSubscriberCount() === 0) {
    sseEventBus.off(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
    sseEventListenersGauge.set(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT));
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
  sseLiveSubscribersGauge.set(totalLiveSubscriberCount());

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
    sseLiveSubscribersGauge.set(totalLiveSubscriberCount());
  };
}

export function getLiveSseSubscriberCount(streamId?: string): number {
  if (streamId !== undefined) {
    return liveSubscribersByStreamId.get(streamId)?.size ?? 0;
  }
  return totalLiveSubscriberCount();
}

// ── Shutdown drain ────────────────────────────────────────────────────────────

interface SseShutdownEntry {
  drain: () => void | Promise<void>;
  forceClose?: (() => void) | undefined;
}

/**
 * Callbacks registered by active SSE response handlers. Each entry holds a
 * drain callback (writes retry:0 and gracefully ends the response) and an
 * optional forceClose callback (destroys the underlying socket) for when
 * the per-connection drain timeout is exceeded.
 */
const sseShutdownCallbacks = new Set<SseShutdownEntry>();

/**
 * Register a shutdown callback for an active SSE response.
 * The returned deregister function must be called when the connection closes
 * normally so the Set does not grow unboundedly.
 *
 * @param drain      - Callback that writes `retry: 0` and ends the response.
 *                     May return a Promise for async drain operations.
 * @param forceClose - Optional callback that destroys the socket after timeout.
 * @returns Deregister function.
 */
export function registerSseShutdownCallback(
  drain: () => void | Promise<void>,
  forceClose?: () => void,
): () => void {
  const entry: SseShutdownEntry = { drain, forceClose };
  sseShutdownCallbacks.add(entry);
  return () => sseShutdownCallbacks.delete(entry);
}

/**
 * Run a single callback with a timeout and return whether it completed
 * before the deadline.
 *
 * Uses Promise.race to race the drain callback (which may be async) against
 * a timer.  A settled guard prevents forceClose from firing after a
 * successful drain, and vice versa.
 */
async function raceDrainCallback(
  drain: () => void | Promise<void>,
  forceClose: (() => void) | undefined,
  timeoutMs: number,
): Promise<boolean> {
  let settled = false;

  const drainPromise = (async () => {
    try {
      await drain();
    } catch {
      // Isolate a single failing response from the rest of the drain.
    }
    if (!settled) {
      settled = true;
      return true; // completed (possibly with error) before timeout
    }
    // Timeout already won — this value won't be consumed by Promise.race.
    return true;
  })();

  const timeoutPromise = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      forceClose?.();
      resolve(false);
    }, timeoutMs);
    // Don't let the timer keep the event loop alive.
    if (typeof timer.unref === 'function') timer.unref();
  });

  return Promise.race([drainPromise, timeoutPromise]);
}

/**
 * Drain all open SSE connections on shutdown.
 *
 * Each registered SSE connection is given up to `timeoutMs` to write a
 * `retry: 0` directive and end gracefully.  Connections that do not complete
 * within the per-stream budget are force-closed via their registered
 * forceClose callback.
 *
 * After all connections are drained, the shared dispatch listener and
 * subscriber state are torn down.
 *
 * @param timeoutMs - Per-connection drain timeout in milliseconds.
 */
export async function drainSseEventBus(timeoutMs: number): Promise<void> {
  const entries = Array.from(sseShutdownCallbacks);
  let forceClosed = 0;

  for (const entry of entries) {
    const completed = await raceDrainCallback(
      entry.drain,
      entry.forceClose,
      timeoutMs,
    );
    if (!completed) {
      forceClosed++;
    }
  }

  sseShutdownCallbacks.clear();

  if (forceClosed > 0) {
    logger.warn(
      'SSE connections force-closed during shutdown drain',
      undefined,
      {
        forceClosed,
        total: entries.length,
        timeoutMs,
      },
    );
  }

  // Tear down the shared dispatcher so no further events are fanned out.
  liveSubscribersByStreamId.clear();
  sseEventBus.off(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
  sseLiveSubscribersGauge.set(0);
  sseEventListenersGauge.set(0);
}

export function _resetSseSubscriptionsForTest(): void {
  liveSubscribersByStreamId.clear();
  sseEventBus.off(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
  sseShutdownCallbacks.clear();
  sseLiveSubscribersGauge.set(0);
  sseEventListenersGauge.set(0);
}

/**
 * Derive the canonical stream ID from the chain-level identifiers used by the
 * ingestion path.
 *
 * Format: `stream-{transactionHash}-{eventIndex}`
 *
 * This is the single source of truth for stream ID derivation. Both the SSE
 * matching logic and the ingestion service (`streamEventService`) must import
 * and call this helper so that the format cannot silently diverge.
 *
 * @param transactionHash - The Stellar transaction hash (hex string)
 * @param eventIndex      - The zero-based event index within the transaction
 */
export function deriveStreamId(transactionHash: string, eventIndex: number): string {
  return `stream-${transactionHash}-${eventIndex}`;
}

/**
 * Checks if a historical or live StreamEventRecord belongs to a specific stream ID.
 *
 * Matching strategy (first match wins):
 * 1. Explicit `id` or `streamId` field inside the event payload.
 * 2. Canonical derivation via `deriveStreamId(event.txHash, event.eventIndex)`.
 *
 * Using the shared `deriveStreamId` helper guarantees that the format used here
 * stays in sync with the ingestion path — the previous inline template literal
 * was a divergence risk.
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
    if (deriveStreamId(event.txHash, event.eventIndex) === id) return true;
  }

  return false;
}
