import { Router, Request, Response } from 'express';
import { getStreamById } from '../db/client.js';
import {
  formatFromStroops,
} from '../serialization/decimal.js';

import {
  notFound,
  validationError,
  conflictError,
  serviceUnavailable,
  asyncHandler,
} from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { SerializationLogger, info, debug, warn } from '../utils/logger.js';
import { verifyStreamOnChain } from '../lib/stellar.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import { successResponse } from '../utils/response.js';

/**
 * Streams API routes (BigInt-Safe Implementation)
 *
 * All amount fields (depositAmount, ratePerSecond) are stored internally as BigInt (stroops)
 * and serialized as decimal strings for precision in API responses.
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

// Dependency states
const streamListingDependency = { state: 'healthy' as 'healthy' | 'unavailable' };
const idempotencyDependency = { state: 'healthy' as 'healthy' | 'unavailable' };

// Idempotency store
const idempotencyStore = new Map<string, {
  fingerprint: string;
  statusCode: number;
  body: any;
}>();

// Pagination helpers
type StreamsCursor = { v: 1; lastId: string };

function encodeCursor(lastId: string): string {
  const payload: StreamsCursor = { v: 1, lastId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): StreamsCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed?.v === 1 && typeof parsed?.lastId === 'string') return parsed;
  } catch {}
  throw validationError('cursor must be a valid opaque pagination token');
}

function parseLimit(limitParam: any): number {
  const limit = parseInt(String(limitParam || 50), 10);
  if (isNaN(limit) || limit < 1 || limit > 100) {
    throw validationError('limit must be an integer between 1 and 100');
  }
  return limit;
}

function parseIdempotencyKey(headerValue: unknown): string {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') {
    throw validationError('Idempotency-Key header is required');
  }
  const trimmed = headerValue.trim();
  if (trimmed.length > 128 || !/^[A-Za-z0-9:_-]+$/.test(trimmed)) {
    throw validationError('Invalid Idempotency-Key format');
  }
  return trimmed;
}

/**
 * GET /api/streams - List streams with pagination
 */
streamsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = parseLimit(req.query.limit);
    const cursorStr = req.query.cursor as string | undefined;
    const includeTotal = req.query.include_total === 'true';

    if (streamListingDependency.state !== 'healthy') {
      throw serviceUnavailable('Stream list is temporarily unavailable.');
    }

    const sortedStreams = [...streams].sort((a, b) => a.id.localeCompare(b.id));
    let startIndex = 0;

    if (cursorStr) {
      const cursor = decodeCursor(cursorStr);
      startIndex = sortedStreams.findIndex((s) => s.id > cursor.lastId);
      if (startIndex === -1) startIndex = sortedStreams.length;
    }

    const pageStreams = sortedStreams.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + pageStreams.length < sortedStreams.length;
    const nextCursor = hasMore && pageStreams.length > 0
      ? encodeCursor(pageStreams[pageStreams.length - 1].id)
      : undefined;

    const serializedStreams = pageStreams.map(s => ({
      ...s,
      depositAmount: formatFromStroops(s.depositAmount),
      ratePerSecond: formatFromStroops(s.ratePerSecond),
    }));

    const response: any = {
      streams: serializedStreams,
      has_more: hasMore,
    };

    if (includeTotal) response.total = streams.length;
    if (nextCursor) response.next_cursor = nextCursor;

    info('Listing streams', { count: pageStreams.length, total: streams.length });
    res.json(response);
  })
);

/**
 * GET /api/streams/:id - Get a single stream
 */
streamsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const stream = streams.find((s) => s.id === id);

    if (!stream) throw notFound('Stream', id);

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
 * POST /api/streams - Create/Verify a new stream
 */
streamsRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { transactionHash } = req.body ?? {};
    const idempotencyKey = parseIdempotencyKey(req.header('Idempotency-Key'));

    if (idempotencyDependency.state !== 'healthy') {
      throw serviceUnavailable('Idempotency processing is temporarily unavailable.');
    }

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
      return res.status(cached.statusCode).json(cached.body);
    }

    info('Verifying on-chain stream', { transactionHash });

    const verified = await verifyStreamOnChain(transactionHash);

    const pool = getPool();
    const id = `stream-${transactionHash.slice(0, 8)}`;
    const stream: Stream = {
      id,
      ...verified,
      status: 'active',
    };

    // Store in-memory (using BigInt)
    streams.push(stream);

    const responseBody = {
      ...stream,
      depositAmount: formatFromStroops(stream.depositAmount),
      ratePerSecond: formatFromStroops(stream.ratePerSecond),
    };

    idempotencyStore.set(idempotencyKey, {
      fingerprint,
      statusCode: 201,
      body: responseBody,
    });

    info('Stream verified and indexed', { id, transactionHash });
    res.status(201).json(responseBody);
  })
);

/**
 * DELETE /api/streams/:id - Cancel a stream
 */
streamsRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const index = streams.findIndex((s) => s.id === id);

    if (index === -1) throw notFound('Stream', id);
    const stream = streams[index]!;

    if (stream.status === 'cancelled') {
      throw conflictError('Stream is already cancelled');
    }

    if (stream.status === 'completed') {
      throw conflictError('Cannot cancel a completed stream');
    }

    await query(pool, "UPDATE streams SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);

    recordAuditEvent('STREAM_CANCELLED', 'stream', id, (req as any).correlationId);
    info('Stream cancelled', { id });

    res.json({ message: 'Stream cancelled', id });
  })
);
