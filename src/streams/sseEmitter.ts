import { EventEmitter } from 'node:events';

import type { StreamEventRecord } from '../db/types.js';
import {
  sseLiveSubscribersGauge,
  sseEventListenersGauge,
  sseSubscriberErrorsTotal,
  sseBackpressureDropsTotal,
} from '../metrics/businessMetrics.js';
import { logger } from '../lib/logger.js';

export const SSE_STREAM_UPDATE_EVENT = 'stream_update';

export const SSE_CLOSE_EVENT = 'close';

export const SSE_CLOSE_REASONS = {
  MAX_DURATION: 'max_duration',
  SERVER_SHUTDOWN: 'server_shutdown',
  BACKPRESSURE: 'backpressure',
} as const;

export type SseCloseReason = (typeof SSE_CLOSE_REASONS)[keyof typeof SSE_CLOSE_REASONS];

export const SSE_MAX_BUFFERED_EVENTS = parseInt(
  process.env.SSE_MAX_BUFFERED_EVENTS || '1000',
  10,
);

export const sseEventBus = new EventEmitter();

sseEventBus.setMaxListeners(1000);

// Upstream moved deriveStreamId to top and dropped the 'stream-' prefix.
export function deriveStreamId(transactionHash: string, eventIndex: number): string {
  return `${transactionHash}-${eventIndex}`;
}

export interface LiveSseStreamUpdateEvent {
  streamId: string;
  eventId: string;
  payload: unknown;
  correlationId?: string;
}

export type SseStreamSubscriber = (event: LiveSseStreamUpdateEvent) => void;

// ── Per-stream event ring buffer ───────────────────────────────────────────────

/**
 * Maximum number of recent events retained per stream in the in-process ring
 * buffer. Events older than this cap are evicted (oldest first).
 *
 * Bounds memory at `SSE_REPLAY_BUFFER_SIZE × (average event size)` per active
 * stream. At ~1 KB per event the default 200-event cap is ~200 KB per stream.
 *
 * Override via `SSE_REPLAY_BUFFER_SIZE` env var (positive integer).
 */
export const SSE_REPLAY_BUFFER_SIZE = (() => {
  const raw = parseInt(process.env.SSE_REPLAY_BUFFER_SIZE ?? '200', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 200;
})();

/**
 * Thrown when a client resumes with a `Last-Event-ID` that has been evicted
 * from the ring buffer. The route handler surfaces this as an `event: error`
 * SSE frame with code `SSE_REPLAY_EXPIRED` so clients fall through to the
 * persistent event store.
 */
export class SseReplayExpiredError extends Error {
  readonly code = 'SSE_REPLAY_EXPIRED' as const;
  constructor(public readonly afterEventId: string) {
    super(
      `Replay cursor '${afterEventId}' is beyond the in-process retention window; ` +
        `resync from the event store`,
    );
    this.name = 'SseReplayExpiredError';
  }
}

/** Ring buffer keyed by streamId, storing recent live events in insertion order. */
const replayBufferByStreamId = new Map<string, LiveSseStreamUpdateEvent[]>();

/**
 * Append a live event to the per-stream ring buffer, evicting the oldest entry
 * when the buffer is full. Called inside `dispatchLiveSseEvent` BEFORE fan-out.
 */
function bufferLiveEvent(event: LiveSseStreamUpdateEvent): void {
  let buf = replayBufferByStreamId.get(event.streamId);
  if (!buf) {
    buf = [];
    replayBufferByStreamId.set(event.streamId, buf);
  }
  buf.push(event);
  if (buf.length > SSE_REPLAY_BUFFER_SIZE) {
    buf.shift();
  }
}

/**
 * Return all buffered events for `streamId` emitted strictly after
 * `afterEventId`, in emission order.
 *
 * @throws {SseReplayExpiredError} when `afterEventId` is not in the buffer.
 * Returns an empty array when the cursor is already at the tip.
 */
export function replayFromBuffer(
  streamId: string,
  afterEventId: string,
): LiveSseStreamUpdateEvent[] {
  const buf = replayBufferByStreamId.get(streamId);
  if (!buf || buf.length === 0) {
    throw new SseReplayExpiredError(afterEventId);
  }
  const idx = buf.findIndex((e) => e.eventId === afterEventId);
  if (idx === -1) {
    throw new SseReplayExpiredError(afterEventId);
  }
  return buf.slice(idx + 1);
}

// ── Live subscriber fan-out ───────────────────────────────────────────────────

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

  // Buffer BEFORE fan-out — event is in the ring buffer before any subscriber
  // callback fires, preventing a gap between replay and live delivery.
  bufferLiveEvent(event);

  const subscribers = liveSubscribersByStreamId.get(event.streamId);
  if (!subscribers || subscribers.size === 0) return;

  for (const subscriber of Array.from(subscribers)) {
    try {
      subscriber(event);
    } catch (err) {
      sseSubscriberErrorsTotal.inc({ reason: 'subscriber_callback_throw' });
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error('SSE subscriber callback threw', event.correlationId, {
        streamId: event.streamId,
        subscriberError: {
          name: error.name,
          message: error.message,
        },
      });
    }
  }
}

function isDispatchAttached(): boolean {
  return sseEventBus.listeners(SSE_STREAM_UPDATE_EVENT).includes(dispatchLiveSseEvent);
}

function ensureDispatchAttached(): void {
  if (!isDispatchAttached()) {
    sseEventBus.on(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
    sseEventListenersGauge.set(Math.max(0, sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)));
  }
}

function detachDispatchIfIdle(): void {
  if (totalLiveSubscriberCount() === 0) {
    sseEventBus.off(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
    sseEventListenersGauge.set(Math.max(0, sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)));
  }
}

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
  sseLiveSubscribersGauge.set(Math.max(0, totalLiveSubscriberCount()));

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
    sseLiveSubscribersGauge.set(Math.max(0, totalLiveSubscriberCount()));
  };
}

export interface SseBackpressureOptions {
  maxBufferedEvents?: number;
  onBackpressureDrop?: (reason: SseCloseReason) => void;
}

export function subscribeToSseStreamWithBackpressure(
  streamId: string,
  subscriber: SseStreamSubscriber,
  options: SseBackpressureOptions = {},
): () => void {
  const maxBuffered = options.maxBufferedEvents ?? SSE_MAX_BUFFERED_EVENTS;
  let bufferedCount = 0;
  let dropped = false;
  // Upstream: hoisted reference so wrappedSubscriber can self-unsubscribe on drop.
  let unsubscribe: () => void = () => {};

  const wrappedSubscriber = (event: LiveSseStreamUpdateEvent) => {
    if (dropped) return;
    bufferedCount++;
    if (bufferedCount > maxBuffered) {
      dropped = true;
      sseBackpressureDropsTotal.inc();
      logger.warn('SSE connection dropped due to backpressure', undefined, {
        streamId,
        bufferedCount,
        maxBuffered,
      });
      options.onBackpressureDrop?.(SSE_CLOSE_REASONS.BACKPRESSURE);
      unsubscribe();
      return;
    }
    try {
      subscriber(event);
      bufferedCount--;
    } catch (err) {
      throw err;
    }
  };

  unsubscribe = subscribeToSseStream(streamId, wrappedSubscriber);
  return () => unsubscribe();
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

const sseShutdownCallbacks = new Set<SseShutdownEntry>();

export function registerSseShutdownCallback(
  drain: () => void | Promise<void>,
  forceClose?: () => void,
): () => void {
  const entry: SseShutdownEntry = { drain, forceClose };
  sseShutdownCallbacks.add(entry);
  return () => sseShutdownCallbacks.delete(entry);
}

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
      // ignore
    }
    if (!settled) {
      settled = true;
      return true;
    }
    return true;
  })();
  const timeoutPromise = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      forceClose?.();
      resolve(false);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([drainPromise, timeoutPromise]);
}

export async function drainSseEventBus(timeoutMs: number): Promise<void> {
  const entries = Array.from(sseShutdownCallbacks);
  let forceClosed = 0;
  for (const entry of entries) {
    const completed = await raceDrainCallback(entry.drain, entry.forceClose, timeoutMs);
    if (!completed) forceClosed++;
  }
  sseShutdownCallbacks.clear();
  if (forceClosed > 0) {
    logger.warn('SSE connections force-closed during shutdown drain', undefined, {
      forceClosed,
      total: entries.length,
      timeoutMs,
    });
  }
  liveSubscribersByStreamId.clear();
  replayBufferByStreamId.clear();
  sseEventBus.off(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
  sseLiveSubscribersGauge.set(0);
  sseEventListenersGauge.set(0);
}

export function _resetSseSubscriptionsForTest(): void {
  liveSubscribersByStreamId.clear();
  replayBufferByStreamId.clear();
  sseShutdownCallbacks.clear();
  sseEventBus.off(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
  sseLiveSubscribersGauge.set(0);
  sseEventListenersGauge.set(0);
}

// Upstream: accepts null/undefined and uses a simplified implementation.
export function eventMatchesStreamId(
  event: StreamEventRecord | null | undefined,
  streamId: string,
): boolean {
  if (!event || !streamId) return false;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload?.['id'] === streamId || payload?.['streamId'] === streamId) return true;
  return deriveStreamId(event.txHash, event.eventIndex) === streamId;
}
