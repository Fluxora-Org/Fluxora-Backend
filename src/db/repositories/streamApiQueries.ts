/**
 * Query construction for the REST streams API.
 *
 * Route handlers deal in API vocabulary (filter query params, validated
 * create-request bodies); this module translates that into the repository's
 * `StreamFilter` / `CreateStreamInput` shapes and issues the calls, so no
 * handler builds a filter or a row itself.
 *
 * It composes the public `streamRepository` methods rather than adding new
 * SQL, which keeps the encrypted-address handling and read-replica routing in
 * a single place.
 *
 * @module db/repositories/streamApiQueries
 */
import crypto from 'crypto';
import type { StreamFilter, StreamRecord } from '../types.js';
import { streamRepository, type UpsertResult } from './streamRepository.js';

/** Validated, normalised POST /api/streams body. Field order is significant: see createStreamFromApi. */
export type ApiCreateStreamInput = {
  sender: string;
  recipient: string;
  depositAmount: string;
  ratePerSecond: string;
  startTime: number;
  endTime: number;
};

/** Pass-through list filters as they arrive on the query string. */
export type ApiStreamListFilters = {
  status?: string | undefined;
  sender?: string | undefined;
  recipient?: string | undefined;
};

export type StreamPage = { streams: StreamRecord[]; hasMore: boolean; total?: number };

/** Fixed page size used when walking the whole table for NDJSON export. */
export const EXPORT_PAGE_SIZE = 100;

/** Marks rows that were created through the REST API rather than indexed from chain. */
const API_CREATED_CONTRACT_ID = 'api-created';

export function buildStreamFilter(filters: ApiStreamListFilters): StreamFilter {
  const filter: StreamFilter = {};
  // Unknown status strings are passed through and simply match no rows.
  if (filters.status !== undefined) filter.status = filters.status as NonNullable<StreamFilter['status']>;
  if (filters.sender !== undefined) filter.sender_address = filters.sender;
  if (filters.recipient !== undefined) filter.recipient_address = filters.recipient;
  return filter;
}

export function listStreams(
  filters: ApiStreamListFilters,
  limit: number,
  afterId: string | undefined,
  includeTotal: boolean,
  options: { forcePrimary: boolean },
): Promise<StreamPage> {
  return streamRepository.findWithCursor(buildStreamFilter(filters), limit, afterId, includeTotal, options);
}

/** One unfiltered page of the export walk, keyed after `afterId`. */
export function fetchExportPage(afterId: string | undefined): Promise<StreamPage> {
  return streamRepository.findWithCursor({}, EXPORT_PAGE_SIZE, afterId);
}

/**
 * Insert a stream from an API create request.
 *
 * The id and transaction hash are derived from the normalised input so a
 * retried request maps to the same row, and the repository's
 * ON CONFLICT DO NOTHING makes the insert idempotent.
 */
export function createStreamFromApi(input: ApiCreateStreamInput, requestId?: string): Promise<UpsertResult> {
  const idHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return streamRepository.upsertStream({
    id: `stream-${idHash}-0`,
    sender_address: input.sender,
    recipient_address: input.recipient,
    amount: input.depositAmount,
    streamed_amount: '0',
    remaining_amount: input.depositAmount,
    rate_per_second: input.ratePerSecond,
    start_time: input.startTime,
    end_time: input.endTime,
    contract_id: API_CREATED_CONTRACT_ID,
    transaction_hash: idHash,
    event_index: 0,
  }, requestId);
}
