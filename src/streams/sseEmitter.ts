import { EventEmitter } from 'node:events';
import type { StreamEventRecord } from '../db/types.js';
import {
  sseLiveSubscribersGauge,
  sseEventListenersGauge,
} from '../metrics/businessMetrics.js';
import type { Config } from '../config/env.js';
import { loadConfig } from '../config/env.js';
import { logger } from '../lib/logger.js';

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

interface TimeoutableShutdownCallback {
  fn: () => void;
  timeoutMs: number;
}

/** Counts SSE connections that were force-closed during shutdown due to timeout. */
let forceClosedSseConnections = 0;

function timeoutPromise<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, ms);

    promise
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
  });
}

export function _injectForceClosedSseConnectionsForTest(): void {
  forceClosedSseConnections = 0;
}

export function getForceClosedSseConnections(): number {
  return forceClosedSseConnections;
}

export function resetForceClosedSseConnectionsCount(): void {
  forceClosedSseConnections = 0;
}

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

/**
 * Callbacks registered by active SSE response handlers. Each callback
 * writes the SSE retry directive and closes the response.
 */
const sseShutdownCallbacks = new Set<TimeoutableShutdownCallback>();

/**
 * Register a shutdown callback for an active SSE response.
 * The returned deregister function must be called when the connection closes
 * normally so the Set does not grow unboundedly.
 *
 * @param fn - Callback that writes `retry: 0` and ends the response.
 * @param timeoutMs - Per-stream timeout in milliseconds before force-closing.
 * @returns Deregister function.
 */
export function registerSseShutdownCallback(
  fn: () => void,
  timeoutMs = 5000,
): () => void {
  sseShutdownCallbacks.add({ fn, timeoutMs });
  return () => {
    for (const cb of sseShutdownCallbacks) {
      if (cb.fn === fn) {
        sseShutdownCallbacks.delete(cb);
        break;
      }
    }
  };
}

/**
 * Drain all open SSE connections on shutdown.
 *
 * Sends a final `retry: 0` directive so browser EventSource clients do not
 * immediately reconnect, then ends each response. Detaches the dispatch
 * listener and resets subscriber state.
 */
export function drainSseEventBus(timeoutMs?: number): Promise<void> {
  const callbacksToProcess = Array.from(sseShutdownCallbacks);
  sseShutdownCallbacks.clear();

  // Run shutdown callbacks concurrently with per-stream timeouts
  const drainPromises = callbacksToProcess.map((cb) => {
    const effectiveTimeout = timeoutMs ?? cb.timeoutMs;
    
    return new Promise<void>((resolve) => {
      const timeoutId = setTimeout(() => {
        logger.warn('SSE drain callback timed out', undefined, {
          error: `Timeout exceeded after ${effectiveTimeout} ms`,
          timeoutMs: effectiveTimeout,
        });
        forceClosedSseConnections++;
        resolve();
      }, effectiveTimeout);

      try {
        const result = cb.fn();
        if (result && typeof result === 'object' && 'then' in result) {
          (result as Promise<void>).then(() => clearTimeout(timeoutId), () => clearTimeout(timeoutId));
        } else {
          clearTimeout(timeoutId);
          resolve();
        }
      } catch (err) {
        clearTimeout(timeoutId);
        logger.error('SSE drain callback failed', undefined, {
          error: err instanceof Error ? err.message : String(err),
        });
        resolve();
      }
    });
  });

  return Promise.all(drainPromises).then(() => {
    // Tear down the shared dispatcher so no further events are fanned out.
    liveSubscribersByStreamId.clear();
    sseEventBus.off(SSE_STREAM_UPDATE_EVENT, dispatchLiveSseEvent);
    sseLiveSubscribersGauge.set(0);
    sseEventListenersGauge.set(0);
  });
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
