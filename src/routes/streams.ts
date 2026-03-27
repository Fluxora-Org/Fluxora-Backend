import { Router, Request, Response } from 'express';
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
import { info, debug, warn } from '../utils/logger.js';
import { verifyStreamOnChain } from '../lib/stellar.js';

/**
 * Streams API routes (BigInt-Safe Implementation)
 */
export const streamsRouter = Router();

// Amount fields that must be decimal strings per serialization policy
const AMOUNT_FIELDS = ['depositAmount', 'ratePerSecond'] as const;

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
 * List all streams, formatting BigInt to string
 */
streamsRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
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
  })
);

/**
 * GET /api/streams/:id
 * Get a single stream, formatting BigInt to string
 */
streamsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    debug('Fetching stream', { id });

    const stream = streams.find((s) => s.id === id);
    if (!stream) {
      throw notFound('Stream', id);
    }

    res.json({
      ...stream,
      depositAmount: formatFromStroops(stream.depositAmount),
      ratePerSecond: formatFromStroops(stream.ratePerSecond),
    });
  })
);

/**
 * POST /api/streams
 * Create a new stream via on-chain verification
 */
streamsRouter.post(
  '/',
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
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
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

    info('Stream cancelled', { id, requestId });
    res.json({ message: 'Stream cancelled', id });
  })
);
