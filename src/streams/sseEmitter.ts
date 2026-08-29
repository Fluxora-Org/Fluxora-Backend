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
  subscriber: SseStreamSubscriber
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

interface SseShutdownEntry {
  drain: () => void | Promise<void>;
  forceClose?: (() => void) | undefined;
}

const sseShutdownCallbacks = new Set<SseShutdownEntry>();

export function registerSseShutdownCallback(
  drain: () => void | Promise<void>,
  forceClose?: () => void
): () => void {
  const entry: SseShutdownEntry = { drain, forceClose };
  sseShutdownCallbacks.add(entry);
  return () => sseShutdownCallbacks.delete(entry);
}

async function raceDrainCallback(
  drain: () => void | Promise<void>,
  forceClose: (() => void) | undefined,
  timeoutMs: number
): Promise<boolean> {
  let settled = false;

  const drainPromise = (async () => {
    try {
      await drain();
    } catch {
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
    if (!completed) {
      forceClosed++;
    }
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
  sseEventBus.off(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
  sseLiveSubscribersGauge.set(0);
  sseEventListenersGauge.set(0);
}

export function _resetSseSubscriptionsForTest(): void {
  liveSubscribersByStreamId.clear();
  sseShutdownCallbacks.clear();
  sseEventBus.off(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
  sseLiveSubscribersGauge.set(0);
  sseEventListenersGauge.set(0);
}

export function deriveStreamId(txHash: string, eventIndex: number): string {
  return `stream-${txHash}-${eventIndex}`;
}

export function eventMatchesStreamId(event: StreamEventRecord | null | undefined, streamId: string): boolean {
  if (!event || !streamId) return false;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload?.['id'] === streamId || payload?.['streamId'] === streamId) return true;
  return deriveStreamId(event.txHash, event.eventIndex) === streamId;
}

