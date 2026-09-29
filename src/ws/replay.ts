/**
 * WebSocket cursor replay.
 *
 * Sends stored contract events to one connected client, starting after a
 * client-supplied cursor and paging through the event store in ledger order.
 * A cursor the store no longer recognises is reported as a stale-cursor error
 * instead of being retried, so the client resyncs from a known-good ledger
 * rather than silently skipping events.
 *
 * @module ws/replay
 */

import { WebSocket } from 'ws';
import {
  STALE_CURSOR_ERROR_CODE,
  StaleCursorError,
  type ContractEventStore,
} from '../indexer/store.js';
import type { StreamEventReplayFilter } from '../db/types.js';

/** Collaborators replay needs from the hub. */
export interface ReplayDeps {
  /** The attached event store, if the indexer configured one. */
  getEventStore: () => ContractEventStore | undefined;
  /** Queues a protocol error frame through the hub's backpressure path. */
  sendError: (ws: WebSocket, code: string, message: string) => void;
  /** Queues one serialized frame through the hub's backpressure path. */
  queueOutboundMessage: (ws: WebSocket, message: string) => boolean;
}

/** Largest page the store will be asked for in one round trip. */
const MAX_PAGE_SIZE = 1000;
/** Page size used when the client does not ask for one. */
const DEFAULT_PAGE_SIZE = 100;

/**
 * Replay stored events to a single connected client starting after the given
 * cursor eventId.
 *
 * The method is intentionally fire-and-forget from the caller's perspective: it
 * resolves once all pages have been sent, the client disconnects, or the cursor
 * turns out to be stale.
 *
 * @param ws     Target WebSocket connection (must be OPEN).
 * @param filter Replay filter forwarded to the event store. `afterEventId`
 *               acts as the exclusive cursor.
 */
export async function replayFromCursor(
  ws: WebSocket,
  deps: ReplayDeps,
  filter: StreamEventReplayFilter = {}
): Promise<void> {
  const eventStore = deps.getEventStore();
  if (!eventStore) {
    deps.sendError(ws, 'REPLAY_UNAVAILABLE', 'Event store is not configured');
    return;
  }

  let cursor = filter.afterEventId;
  const pageSize = Math.min(filter.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  do {
    if (ws.readyState !== WebSocket.OPEN) return;

    const pageFilter: StreamEventReplayFilter = {
      ...filter,
      ...(cursor !== undefined ? { afterEventId: cursor } : {}),
      limit: pageSize,
    };
    let result: Awaited<ReturnType<ContractEventStore['getEvents']>>;
    try {
      result = await eventStore.getEvents(pageFilter);
    } catch (err) {
      if (err instanceof StaleCursorError) {
        deps.sendError(
          ws,
          STALE_CURSOR_ERROR_CODE,
          'Replay cursor no longer exists; resync from fromLedger'
        );
        return;
      }
      throw err;
    }

    for (const event of result.events) {
      if (ws.readyState !== WebSocket.OPEN) return;

      const message = JSON.stringify({
        type: 'stream_replay',
        eventId: event.eventId,
        ledger: event.ledger,
        topic: event.topic,
        payload: event.payload,
        happenedAt: event.happenedAt,
      });

      deps.queueOutboundMessage(ws, message);
    }

    cursor = result.nextCursor;
  } while (cursor !== undefined);

  // Signal end of replay stream
  if (ws.readyState === WebSocket.OPEN) {
    deps.queueOutboundMessage(
      ws,
      JSON.stringify({ type: 'stream_replay_complete', cursor: cursor ?? null })
    );
  }
}
