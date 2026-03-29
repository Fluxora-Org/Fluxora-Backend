import { Router, Request, Response } from 'express';
import { getStreamById } from '../db/client.js';
import {
  validateDecimalString,
  validateAmountFields,
  formatFromStroops,
  parseToStroops,
} from '../serialization/decimal.js';

import {
  ApiError,
  ApiErrorCode,
  notFound,
  validationError,
  conflictError,
  asyncHandler,
} from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { SerializationLogger, info, debug, warn } from '../utils/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import { info, debug, warn } from '../utils/logger.js';
import { verifyStreamOnChain } from '../lib/stellar.js';

/**
 * Streams API routes (BigInt-Safe Implementation)
 */
export const streamsRouter = Router();

// Amount fields that must be decimal strinET /:ids per serialization policy
const AMOUNT_FIELDS = ['depositAmount', 'ratePerSecond'] as const;
export const streams: any[] = []

type StreamsCursor = {
  v: 1;
  lastId: string;
};

type StreamListingDependencyState = 'healthy' | 'unavailable';
type IdempotencyDependencyState = 'healthy' | 'unavailable';

type NormalizedCreateStreamInput = {
  sender: string;
  recipient: string;
  depositAmount: string;
  ratePerSecond: string;
  startTime: number;
  endTime: number;
};

/**
 * Internal Stream type using BigInt for stroops
 */
export interface Stream {
  id: string;
  sender: string;
  recipient: string;
  depositAmount: bigint;
  ratePerSecond: bigint;
  startTime: number;
  endTime: number;
  status: string;
}

// In-memory stream store
export const streams: Stream[] = [];

// Idempotency store
const idempotencyStore = new Map<string, {
  fingerprint: string;
  statusCode: number;
  body: any;
}>();

function parseIdempotencyKey(headerValue: unknown): string {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') {
    throw validationError('Idempotency-Key header is required');
  }
  return headerValue.trim();
}

/**
 * GET /api/streams
 * List streams with cursor-based pagination and filters
 */
streamsRouter.get(
  '/',
  asyncHandler(async (req: any, res: any) => {
    const requestId = (req as { id?: string }).id;
    const limit = parseLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const includeTotal = parseIncludeTotal(req.query.include_total);

    // Extract filters
    const status = req.query.status as string | undefined;
    const sender = req.query.sender as string | undefined;
    const recipient = req.query.recipient as string | undefined;

    info('Listing all streams', { count: streams.length });

    const serializedStreams = streams.map(s => ({
      ...s,
      depositAmount: formatFromStroops(s.depositAmount),
      ratePerSecond: formatFromStroops(s.ratePerSecond),
    }));

    res.json({
      streams: serializedStreams,
      total: streams.length,
      });
    
    if (streamListingDependency.state !== 'healthy') {
      warn('Stream listing dependency unavailable', { dependency: 'stream-list-view', requestId });
      throw serviceUnavailable('Stream list is temporarily unavailable.');
    }

    // Filter Validation
    if (status && !['active', 'cancelled', 'completed'].includes(status)) {
      throw validationError('Invalid status filter', [{ field: 'status', message: 'Must be active, cancelled, or completed' }]);
    }
    
    const stellarAddressRegex = /^G[A-Z2-7]{55}$/;
    if (sender && !stellarAddressRegex.test(sender)) {
      throw validationError('Invalid sender address format', [{ field: 'sender', message: 'Must be a valid Stellar public key starting with G' }]);
    }
    if (recipient && !stellarAddressRegex.test(recipient)) {
      throw validationError('Invalid recipient address format', [{ field: 'recipient', message: 'Must be a valid Stellar public key starting with G' }]);
    }

    // Apply Filters
    let filteredStreams = [...streams];
    if (status) filteredStreams = filteredStreams.filter(s => s.status === status);
    if (sender) filteredStreams = filteredStreams.filter(s => s.sender === sender);
    if (recipient) filteredStreams = filteredStreams.filter(s => s.recipient === recipient);

    // Sort the filtered list for pagination
    const sortedStreams = filteredStreams.sort((a, b) => a.id.localeCompare(b.id));
    
    // ... [KEEP YOUR EXISTING PAGINATION LOGIC FROM HERE DOWN] ...
    const startIndex = cursor
      ? sortedStreams.findIndex((stream) => stream.id > cursor.lastId)
      : 0;

    const normalizedStartIndex = startIndex === -1 ? sortedStreams.length : startIndex;
    const pageStreams = sortedStreams.slice(normalizedStartIndex, normalizedStartIndex + limit);
    const hasMore = normalizedStartIndex + pageStreams.length < sortedStreams.length;
    const nextCursor =
      hasMore && pageStreams.length > 0
        ? encodeCursor(pageStreams[pageStreams.length - 1]!.id)
        : undefined

    info('Listing streams with pagination', {
      cursorProvided: Boolean(cursor),
      includeTotal,
      limit,
      returned: pageStreams.length,
      hasMore,
      totalIncluded: includeTotal,
      total: includeTotal ? sortedStreams.length : undefined,
      requestId,
    });
    debug('Streams page computed', {
      startIndex: normalizedStartIndex,
      lastId: cursor?.lastId ?? null,
      nextCursorPresent: Boolean(nextCursor),
      requestId,
    });
  })
);

/**
 * GET /api/streams/:id
 * Get a single stream by ID from the database.
 */
streamsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const requestId = (req as { id?: string }).id;

    debug('Fetching stream from database', { id, requestId });

    // Basic validation
    if (!id || typeof id !== 'string') {
       res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Stream ID is required' } });
       return;
    }

    try {
      const stream = await getStreamById(id);
      if (!stream) {
        throw notFound('Stream', id);
      }
      res.json(stream);
    } catch (error: any) {
      if (error.name === 'ApiError') throw error; // Let the errorHandler catch 404s
      warn('Database query failed', { id, error: error.message, requestId });
      throw serviceUnavailable('Database query failed');
    }
  })
);

/**
 * POST /api/streams
 * Create a new stream via on-chain verification
 */
streamsRouter.post(
  '/',
  authenticate,
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { transactionHash } = req.body ?? {};
    const requestId = (req as any).id;
    const idempotencyKey = parseIdempotencyKey(req.header('Idempotency-Key'));

    if (!transactionHash) {
      throw validationError('transactionHash is required');
    }

    // Check idempotency
    const fingerprint = JSON.stringify({ transactionHash });
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw conflictError('Idempotency key reused with different payload');
      }
      res.set('Idempotency-Replayed', 'true');
      res.status(cached.statusCode).json(cached.body);
      return;
    }

    info('Verifying on-chain stream', { transactionHash, requestId });

    // Trust boundary: Verify the transaction on Stellar
    const verified = await verifyStreamOnChain(transactionHash);

    const id = `stream-${transactionHash.slice(0, 8)}`;
    const stream: Stream = {
      id,
      ...verified,
      status: 'active',
    };

    // Store in-memory
    const existingStream = streams.find(s => s.id === id);
    if (existingStream) {
      const responseBody = {
        ...existingStream,
        depositAmount: formatFromStroops(existingStream.depositAmount),
        ratePerSecond: formatFromStroops(existingStream.ratePerSecond),
      };
      idempotencyStore.set(idempotencyKey, { fingerprint, statusCode: 200, body: responseBody });
      res.status(200).json(responseBody);
      return;
    }

    streams.push(stream);

    const responseBody = {
      ...stream,
      depositAmount: formatFromStroops(stream.depositAmount),
      ratePerSecond: formatFromStroops(stream.ratePerSecond),
    };

    idempotencyStore.set(idempotencyKey, { fingerprint, statusCode: 201, body: responseBody });

    info('Stream verified and indexed', { id, transactionHash, requestId });
    res.status(201).json(responseBody);
  })
);

/**
 * DELETE /api/streams/:id
 * Cancel a stream
 */
streamsRouter.delete(
  '/:id',
  authenticate,
  requireAuth,
  asyncHandler(async (req: any, res: any) => {
    const { id } = req.params;
    const requestId = (req as any).id;

    debug('Cancelling stream', { id, requestId });

    const index = streams.findIndex((s) => s.id === id);
    const stream = streams[index];

    if (index === -1 || !stream) {
      throw notFound('Stream', id);
    }

    if (stream.status === 'cancelled') {
      throw conflictError('Stream already cancelled');
    }

    streams[index] = { ...stream, status: 'cancelled' };

    info('Stream cancelled', { id });

    recordAuditEvent(
      'STREAM_CANCELLED',
      'stream',
      id as string,
      (req as any).correlationId || 'unknown'
    )

    res.json({ message: 'Stream cancelled', id });

    const config = getConfig();
    if (config.webhookUrl && config.webhookSecret) {
      dispatchWebhook({
        url: config.webhookUrl,
        secret: config.webhookSecret,
        event: 'stream.deleted',
        payload: streams[index],
      }).catch((err) => error('Failed to dispatch deletion webhook', { streamId: id }, err as Error));
    }
  })
);
