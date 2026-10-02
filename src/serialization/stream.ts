/**
 * REST response shaping for streams.
 *
 * Maps repository rows to the public camelCase `Stream` shape and builds the
 * list page, cache policy and realtime update envelopes. Shared by every
 * stream-returning route (list, get, export, create, status updates, SSE and
 * long-poll) so the wire format is defined once.
 *
 * Amounts stay decimal strings end to end; nothing here converts them to
 * numbers.
 *
 * @module serialization/stream
 */
import type { StreamRecord } from '../db/types.js';
import { isTerminalStatus } from '../streams/status.js';
import { SSE_STREAM_UPDATE_EVENT } from '../streams/sseEmitter.js';
import { encodeCursor } from '../utils/opaqueCursor.js';

/** Public-facing stream shape (camelCase, decimal strings). */
export interface Stream {
  id: string;
  sender: string;
  recipient: string;
  depositAmount: string;
  streamedAmount: string;
  remainingAmount: string;
  ratePerSecond: string;
  startTime: number;
  endTime: number;
  status: string;
}

export interface StreamListPage {
  streams: Stream[];
  has_more: boolean;
  next_cursor: string | null;
  total?: number;
  _meta?: { enhanced: boolean };
}

/** Envelope shared by SSE frames and long-poll bodies. */
export interface StreamUpdateEnvelope {
  type: 'stream_update';
  streamId: string;
  eventId: string;
  payload: unknown;
  correlationId: string | undefined;
}

/** Scope stamped into cursors that are not bound to a specific list query (e.g. export resumption). */
export const UNSCOPED_STREAM_CURSOR = 'streams:v1';

const CACHEABLE_STREAM_HEADERS = 'public, max-age=300, stale-while-revalidate=60';
const NO_STORE_STREAM_HEADERS = 'private, no-store';

export function toApiStream(record: StreamRecord): Stream {
  return {
    id: record.id,
    sender: record.sender_address,
    recipient: record.recipient_address,
    depositAmount: record.amount,
    streamedAmount: record.streamed_amount,
    remainingAmount: record.remaining_amount,
    ratePerSecond: record.rate_per_second,
    startTime: record.start_time,
    endTime: record.end_time,
    status: record.status,
  };
}

/**
 * Cache-Control for a set of stream statuses: publicly cacheable only when
 * every stream is terminal (completed or cancelled). An empty set counts as
 * all-terminal because nothing mutable is present.
 */
export function streamCacheControl(statuses: readonly string[]): string {
  const allTerminal = statuses.every((status) => isTerminalStatus(status as Parameters<typeof isTerminalStatus>[0]));
  return allTerminal ? CACHEABLE_STREAM_HEADERS : NO_STORE_STREAM_HEADERS;
}

/** Canonical query binding stored in every newly issued list cursor. */
export function streamCursorScope(
  status: string | undefined,
  sender: string | undefined,
  recipient: string | undefined,
  callerAddress: string | undefined,
): string {
  return JSON.stringify({ v: 1, status: status ?? null, sender: sender ?? null, recipient: recipient ?? null, caller: callerAddress ?? null, order: 'id:asc' });
}

/**
 * Build a GET /api/streams page. `next_cursor` is issued only when more rows
 * follow, bound to `cursorScope`; `total` is included only when requested.
 */
export function toStreamListPage(
  page: { streams: StreamRecord[]; hasMore: boolean; total?: number },
  cursorScope: string,
  includeTotal: boolean,
): StreamListPage {
  const streams = page.streams.map(toApiStream);
  const last = streams[streams.length - 1];
  const nextCursor = page.hasMore && last !== undefined ? encodeCursor(last.id, cursorScope) : null;

  const response: StreamListPage = { streams, has_more: page.hasMore, next_cursor: nextCursor };
  if (includeTotal && page.total !== undefined) response.total = page.total;
  return response;
}

/** One NDJSON line per stream, followed by a resumption cursor line for the page. */
export function toExportNdjsonLines(records: readonly StreamRecord[]): string[] {
  const lines = records.map((record) => JSON.stringify(toApiStream(record)) + '\n');
  const last = records[records.length - 1];
  if (last !== undefined) {
    lines.push(JSON.stringify({ resumption_cursor: encodeCursor(last.id, UNSCOPED_STREAM_CURSOR) }) + '\n');
  }
  return lines;
}

export function streamUpdateEnvelope(
  streamId: string,
  event: { eventId: string; payload: unknown },
  correlationId: string | undefined,
): StreamUpdateEnvelope {
  return { type: 'stream_update', streamId, eventId: event.eventId, payload: event.payload, correlationId };
}

export function formatSseStreamUpdate(envelope: StreamUpdateEnvelope): string {
  return `id: ${envelope.eventId}\n` +
    `event: ${SSE_STREAM_UPDATE_EVENT}\n` +
    `data: ${JSON.stringify(envelope)}\n\n`;
}
