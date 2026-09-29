/**
 * WebSocket fanout.
 *
 * Takes one already-deduplicated stream update, resolves its subscribers, and
 * pushes the frame(s) out: batching clients are handed to the batch
 * accumulator, everyone else gets an immediate `stream_update` frame. Large
 * fanouts are chunked so a single broadcast cannot monopolize the event loop.
 *
 * @module ws/fanout
 */

import { WebSocket } from 'ws';
import { getCorrelationId } from '../tracing/middleware.js';
import { getTracer } from '../tracing/hooks.js';
import { SSE_STREAM_UPDATE_EVENT, sseEventBus } from '../streams/sseEmitter.js';
import type { DedupCache } from '../redis/dedup.js';
import { FANOUT_YIELD_BATCH } from './hubConfig.js';
import type { SubscriptionRouter } from './subscriptionRouter.js';
import type { BatchAccumulator } from './batching.js';
import type { BatchedEvent, StreamUpdateEvent } from './hubTypes.js';

/** Delivers one serialized frame to a set of recipients; returns the count sent. */
export type DeliverBatch = (
  batch: WebSocket[],
  message: string,
  streamId: string,
  eventId: string
) => number;

/** Collaborators the fanout needs from the hub. */
export interface FanoutDeps {
  router: SubscriptionRouter;
  batches: BatchAccumulator;
  deliverBatch: DeliverBatch;
}

/** Collaborators needed to publish a freshly ingested stream update. */
export interface BroadcastDeps extends FanoutDeps {
  dedup: DedupCache;
}

/**
 * Deduplicate, mirror to the SSE bus, and dispatch one stream update.
 *
 * A `(streamId, eventId)` pair already seen by the dedup cache is dropped, so a
 * replayed ingest cannot fan out twice.
 */
export async function broadcastEvent(
  event: StreamUpdateEvent,
  deps: BroadcastDeps
): Promise<void> {
  const { streamId, eventId } = event;

  const added = await deps.dedup.add(streamId, eventId);
  if (!added) return;

  // Mirror to the Server-Sent Events bus before fanning out to WebSocket peers.
  sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, event);

  dispatchEvent(event, deps);
}

/**
 * Dispatch one event to its subscribers.
 *
 * Subscribers that opted into micro-batching are buffered; the rest receive the
 * unchanged one-frame-per-event stream. With no subscribers this is a no-op.
 */
export function dispatchEvent(event: StreamUpdateEvent, deps: FanoutDeps): void {
  const { streamId, eventId, payload } = event;
  const { batched, immediate } = deps.router.resolveTargets(event);
  if (batched.length === 0 && immediate.length === 0) return;

  // Prefer an explicit correlationId on the event (e.g. set by the indexer
  // ingestion path) over the ambient tracing-middleware value so that batch
  // frames faithfully echo the per-event correlation identifier.
  const correlationId = event.correlationId ?? getCorrelationId();

  // ── Batched subscribers: one frame per flush window ──────────────────────
  for (const { ws, state } of batched) {
    const entry: BatchedEvent = { streamId, eventId, payload, correlationId };
    deps.batches.enqueue(ws, state, entry);
  }

  // ── Immediate (non-batched) fanout ───────────────────────────────────────
  if (immediate.length === 0) return;

  const message = JSON.stringify({
    type: 'stream_update',
    streamId: event.streamId,
    eventId: event.eventId,
    payload: event.payload,
    correlationId,
  });

  if (immediate.length <= FANOUT_YIELD_BATCH) {
    deps.deliverBatch(immediate, message, streamId, eventId);
    return;
  }

  // Large fanout is chunked so one broadcast cannot monopolize the event loop.
  let i = 0;
  const next = (): void => {
    const end = Math.min(i + FANOUT_YIELD_BATCH, immediate.length);
    deps.deliverBatch(immediate.slice(i, end), message, streamId, eventId);
    i = end;
    if (i < immediate.length) setImmediate(next);
  };
  next();
}

/**
 * Record a completed broadcast as a tracing span.
 *
 * Fire-and-forget: the span carries no correlationId context of its own, it
 * simply reports how many recipients accepted the frame.
 */
export function recordBroadcastSpan(
  sent: number,
  streamId: string,
  eventId: string
): void {
  const correlationId = getCorrelationId();
  const tracer = getTracer();
  const span = tracer.startSpan({
    traceId: correlationId,
    serviceName: 'fluxora-ws',
    tags: {
      'ws.stream_id': streamId,
      'ws.event_id': eventId,
      'ws.recipients': sent,
      'ws.correlation_id': correlationId,
    },
  });
  tracer.recordEvent(span, 'ws.broadcast', {
    streamId,
    eventId,
    recipients: sent,
    correlationId,
  });
  tracer.endSpan(span, 'ok');
}
