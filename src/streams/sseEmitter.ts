import { EventEmitter } from 'node:events';
import type { StreamEventRecord } from '../db/types.js';

// Central EventEmitter to handle SSE broadcast subscriptions locally
export const sseEventBus = new EventEmitter();

// Allow standard high-load listener limits
sseEventBus.setMaxListeners(1000);

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
