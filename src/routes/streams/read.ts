/**
 * Read handlers: list, NDJSON export, HEAD, GET and JSON-LD export.
 *
 * @module routes/streams/read
 */
import type { Request, Response, Router } from 'express';
import {
  asyncHandler,
  forbidden,
  notFound,
  serviceUnavailable,
  validationError,
} from '../../middleware/errorHandler.js';
import { authenticateApiKey, requireScope } from '../../middleware/auth.js';
import { recordServerTimingPhase } from '../../middleware/serverTiming.js';
import { isEnabled as isFlagEnabled } from '../../config/featureFlags.js';
import { streamRepository } from '../../db/repositories/streamRepository.js';
import { fetchExportPage, listStreams } from '../../db/repositories/streamApiQueries.js';
import { PoolExhaustedError } from '../../db/pool.js';
import { shouldForcePrimaryFromHeaders } from '../../db/writeFencePin.js';
import { PaginationSchema } from '../../validation/paginationSchema.js';
import { toStreamJsonLd } from '../../serialization/jsonld.js';
import {
  streamCacheControl,
  streamCursorScope,
  toApiStream,
  toExportNdjsonLines,
  toStreamListPage,
} from '../../serialization/stream.js';
import { successResponse } from '../../utils/response.js';
import { sendEarlyHints } from '../../utils/earlyHints.js';
import { parseCursorParam } from '../../utils/opaqueCursor.js';
import { respondNotModified, setValidatorHeaders } from '../../utils/conditionalGet.js';
import { debug, info, warn } from '../../utils/logger.js';
import {
  assertCallerMayList,
  enforceStreamScope,
  getFeatureFlagRequesterId,
  rethrowDbError,
  withDbErrors,
} from './guards.js';
import { isStreamListingHealthy } from './state.js';

const STREAMS_ENHANCED_RESPONSE_FLAG = 'streams_enhanced_response';
const MAX_EXPORT_PAGES = 1000;
const JSON_LD_CONTEXT_LINK =
  '<https://fluxora.dev/ns/v1>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"';

async function timePhase<T>(res: Response, phase: string, operation: () => Promise<T>): Promise<T> {
  const start = process.hrtime.bigint();
  try {
    return await operation();
  } finally {
    recordServerTimingPhase(res, phase, Number(process.hrtime.bigint() - start) / 1e6);
  }
}

/**
 * GET /api/streams
 * List streams with cursor-based pagination.
 *
 * Query params are validated via PaginationSchema (Zod). Invalid params
 * return 400 VALIDATION_ERROR before any DB call is made.
 */
async function listStreamsHandler(req: Request, res: Response): Promise<void> {
  const requestId = req.correlationId;

  const parsed = PaginationSchema.safeParse(req.query);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    warn('Stream list pagination validation failed', { error: first?.message, requestId });
    throw validationError(first?.message ?? 'Invalid query parameters');
  }
  const { limit, cursor: rawCursor, status, sender, recipient, include_total } = parsed.data;

  const cursor = parseCursorParam(rawCursor, requestId);
  const includeTotal = include_total === 'true';
  const cursorScope = streamCursorScope(status, sender, recipient, req.callerAddress);
  if (cursor?.scope !== undefined && cursor.scope !== cursorScope) {
    warn('Stream cursor scope mismatch', { requestId });
    throw validationError('cursor does not match the requested tenant, filters, or sort order');
  }

  if (!isStreamListingHealthy()) {
    warn('Stream listing dependency unavailable', { dependency: 'stream-list-view', requestId });
    res.setHeader('Retry-After', '30');
    throw serviceUnavailable('Stream list is temporarily unavailable. Retry when dependency health is restored.');
  }

  // Read-your-writes: a valid, unexpired write-fence pin routes this read to
  // the primary pool so the client sees its own recent write even if the
  // replica is lagging.
  const forcePrimary = shouldForcePrimaryFromHeaders(
    req.headers as Record<string, string | string[] | undefined>,
  );

  const page = await timePhase(res, 'db', () => withDbErrors(() => {
    assertCallerMayList(req.callerAddress, sender, recipient);
    return listStreams({ status, sender, recipient }, limit, cursor?.lastId, includeTotal, { forcePrimary });
  }));

  const body = toStreamListPage(page, cursorScope, includeTotal);
  info('Listing streams', { limit, returned: body.streams.length, hasMore: body.has_more, requestId });

  // HTTP 103 Early Hints for the next page lets HTTP/2 clients warm up the
  // follow-up request while this response is still being prepared.
  if (body.has_more && body.next_cursor) {
    const queryParams: Record<string, string> = {};
    if (status) queryParams.status = status;
    if (sender) queryParams.sender = sender;
    if (recipient) queryParams.recipient = recipient;
    if (includeTotal) queryParams.include_total = 'true';
    sendEarlyHints(res, { baseUrl: '/api/streams', hasMore: true, nextCursor: body.next_cursor, queryParams }, req);
  }

  if (isFlagEnabled(STREAMS_ENHANCED_RESPONSE_FLAG, getFeatureFlagRequesterId(req))) {
    body._meta = { enhanced: true };
  }

  res.set('Cache-Control', streamCacheControl(body.streams.map((s) => s.status)));

  const serializeStart = process.hrtime.bigint();
  const serialized = JSON.stringify(successResponse(body, requestId));
  recordServerTimingPhase(res, 'serialize', Number(process.hrtime.bigint() - serializeStart) / 1e6);

  res.type('application/json');
  res.send(serialized);
}

/**
 * GET /api/streams/export
 * Export streams in NDJSON format, with a resumption cursor after every page.
 */
async function exportStreamsHandler(req: Request, res: Response): Promise<void> {
  const requestId = req.correlationId;

  const resumeFrom = req.query.resume_from;
  if (Array.isArray(resumeFrom) || (resumeFrom !== undefined && typeof resumeFrom !== 'string')) {
    warn('Export pagination validation failed', { error: 'resume_from must be a string', requestId });
    throw validationError('resume_from must be a single valid opaque pagination token');
  }

  let afterId = resumeFrom ? parseCursorParam(resumeFrom, requestId)?.lastId : undefined;

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.callerAddress) {
      throw forbidden('Scoped users are not authorized to use the full export endpoint');
    }

    let pagesFetched = 0;
    while (pagesFetched < MAX_EXPORT_PAGES) {
      if (req.closed || req.destroyed) {
        info('Stream export cancelled by client', { requestId });
        break;
      }
      const page = await fetchExportPage(afterId);
      pagesFetched++;

      for (const line of toExportNdjsonLines(page.streams)) res.write(line);
      afterId = page.streams[page.streams.length - 1]?.id ?? afterId;

      if (!page.hasMore) break;
    }

    res.end();
    info('Stream export completed or bounded', { requestId, pagesFetched });
  } catch (err) {
    warn('Stream export failed', { requestId, error: err instanceof Error ? err.message : String(err) });
    rethrowDbError(err);
  }
}

/**
 * HEAD /api/streams/:id
 * Lightweight existence check with cache validators only.
 */
async function headStreamHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id) {
    res.status(404).end();
    return;
  }

  debug('Checking stream existence', { id });

  let record;
  try {
    record = await streamRepository.existsById(id);
  } catch (err) {
    if (err instanceof PoolExhaustedError) {
      res.status(503).end();
      return;
    }
    throw err;
  }

  if (!record) {
    res.status(404).end();
    return;
  }

  setValidatorHeaders(res, { id, updated_at: record.updated_at });
  res.status(200).end();
}

/**
 * GET /api/streams/:id
 * Get a single stream by ID. Supports conditional GET (RFC 7232 §3.2).
 */
async function getStreamHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id) throw notFound('Stream', '');
  debug('Fetching stream', { id });

  const record = await withDbErrors(() => streamRepository.getById(id));
  if (!record) throw notFound('Stream', id);

  if (respondNotModified(req, res, record)) return;

  const stream = toApiStream(record);
  setValidatorHeaders(res, record);
  res.set('Cache-Control', streamCacheControl([stream.status]));
  res.json(successResponse({ stream }, req.correlationId));
}

/**
 * GET /api/streams/:id/export.jsonld
 *
 * Export a single stream as a JSON-LD document for data portability. The body
 * is the raw JSON-LD object (no success envelope) so linked-data processors
 * can consume it directly. Cache validators match GET /:id, so a client that
 * already validated the plain-JSON representation can skip re-fetching.
 */
async function exportStreamJsonLdHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  const requestId = req.correlationId;
  if (!id) throw notFound('Stream', '');

  debug('Exporting stream as JSON-LD', { id, requestId });

  const record = await withDbErrors(() => streamRepository.getById(id));
  if (!record) throw notFound('Stream', id);

  if (respondNotModified(req, res, record)) return;

  setValidatorHeaders(res, record);
  res.set('Cache-Control', streamCacheControl([record.status]));
  // Advertise the context document per the JSON-LD HTTP spec (§4.1).
  res.set('Link', JSON_LD_CONTEXT_LINK);
  res.type('application/ld+json');
  res.send(JSON.stringify(toStreamJsonLd(record)));
}

export function registerReadRoutes(router: Router): void {
  // Registration order matters: '/export' must precede '/:id'.
  router.get('/', authenticateApiKey, requireScope('streams:read'), enforceStreamScope, asyncHandler(listStreamsHandler));
  router.get('/export', authenticateApiKey, requireScope('streams:read'), enforceStreamScope, asyncHandler(exportStreamsHandler));
  router.head('/:id', asyncHandler(headStreamHandler));
  router.get('/:id', authenticateApiKey, requireScope('streams:read'), asyncHandler(getStreamHandler));
  router.get('/:id/export.jsonld', authenticateApiKey, requireScope('streams:read'), asyncHandler(exportStreamJsonLdHandler));
}
