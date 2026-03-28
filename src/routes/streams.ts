import { Router, Request, Response } from 'express';
import {
  formatFromStroops,
} from '../serialization/decimal.js';

import {
  notFound,
  validationError,
  conflictError,
  asyncHandler,
} from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { info, debug } from '../utils/logger.js';
import { verifyStreamOnChain } from '../lib/stellar.js';
import { getPool, query, DuplicateEntryError } from '../db/pool.js';

/**
 * Streams API routes (PostgreSQL Implementation)
 */
export const streamsRouter = Router();

function parseIdempotencyKey(headerValue: unknown): string {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') {
    throw validationError('Idempotency-Key header is required');
  }
  return headerValue.trim();
}

/**
 * GET /api/streams
 * List all streams from PostgreSQL
 */
streamsRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const pool = getPool();
    const result = await query(pool, 'SELECT * FROM streams ORDER BY created_at DESC');
    
    info('Listing all streams', { count: result.rows.length });

    const serializedStreams = result.rows.map(s => ({
      id: s.id,
      sender: s.sender_address,
      recipient: s.recipient_address,
      depositAmount: s.amount,
      ratePerSecond: s.rate_per_second,
      startTime: Number(s.start_time),
      endTime: Number(s.end_time),
      status: s.status,
      contractId: s.contract_id,
      transactionHash: s.transaction_hash,
    }));

    res.json({
      streams: serializedStreams,
      total: serializedStreams.length,
    });
  })
);

/**
 * GET /api/streams/:id
 * Get a single stream from PostgreSQL
 */
streamsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    debug('Fetching stream', { id });

    const pool = getPool();
    const result = await query(pool, 'SELECT * FROM streams WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      throw notFound('Stream', id);
    }

    const s = result.rows[0];
    if (!s) {
      throw notFound('Stream', id);
    }

    res.json({
      id: s.id,
      sender: s.sender_address,
      recipient: s.recipient_address,
      depositAmount: s.amount,
      ratePerSecond: s.rate_per_second,
      startTime: Number(s.start_time),
      endTime: Number(s.end_time),
      status: s.status,
      contractId: s.contract_id,
      transactionHash: s.transaction_hash,
    });
  })
);

/**
 * POST /api/streams
 * Create a new stream via on-chain verification and PG persistence
 */
streamsRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { transactionHash } = req.body ?? {};
    const requestId = (req as any).id;
    const idempotencyKey = parseIdempotencyKey(req.header('Idempotency-Key'));

    if (!transactionHash) {
      throw validationError('transactionHash is required');
    }

    info('Verifying on-chain stream', { transactionHash, requestId, idempotencyKey });

    const verified = await verifyStreamOnChain(transactionHash);

    const pool = getPool();
    const id = `stream-${transactionHash.slice(0, 8)}`;

    try {
      await query(
        pool,
        `INSERT INTO streams (
          id, sender_address, recipient_address, amount, 
          rate_per_second, start_time, end_time, status, 
          contract_id, transaction_hash, event_index
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          verified.sender,
          verified.recipient,
          formatFromStroops(verified.depositAmount),
          formatFromStroops(verified.ratePerSecond),
          verified.startTime,
          verified.endTime,
          'active',
          verified.contractId || 'unknown',
          transactionHash,
          0
        ]
      );

      info('Stream verified and indexed in PG', { id, transactionHash, requestId });
      res.status(201).json({
        id,
        sender: verified.sender,
        recipient: verified.recipient,
        depositAmount: formatFromStroops(verified.depositAmount),
        ratePerSecond: formatFromStroops(verified.ratePerSecond),
        startTime: verified.startTime,
        endTime: verified.endTime,
        status: 'active',
      });
    } catch (err) {
      if (err instanceof DuplicateEntryError) {
        const existing = await query(pool, 'SELECT * FROM streams WHERE transaction_hash = $1', [transactionHash]);
        if (existing.rows.length > 0) {
        const s = existing.rows[0];
        if (s) {
          res.set('Idempotency-Replayed', 'true');
          res.status(200).json({
            id: s.id,
            sender: s.sender_address,
            recipient: s.recipient_address,
            depositAmount: s.amount,
            ratePerSecond: s.rate_per_second,
            startTime: Number(s.start_time),
            endTime: Number(s.end_time),
            status: s.status,
          });
          return;
        }
        }
      }
      throw err;
    }
  })
);

/**
 * DELETE /api/streams/:id
 * Cancel a stream in PostgreSQL
 */
streamsRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const requestId = (req as any).id;

    debug('Cancelling stream', { id, requestId });

    const pool = getPool();
    const result = await query(pool, 'SELECT status FROM streams WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      throw notFound('Stream', id);
    }

    const s = result.rows[0];
    if (!s) {
       throw notFound('Stream', id);
    }

    if (s.status === 'cancelled') {
      throw conflictError('Stream already cancelled');
    }

    await query(pool, "UPDATE streams SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);

    info('Stream cancelled in PG', { id, requestId });
    res.json({ message: 'Stream cancelled', id });
  })
);
