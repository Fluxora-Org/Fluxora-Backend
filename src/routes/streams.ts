import express from 'express';
import type { Request, Response } from 'express';
import { validateDecimalString, validateAmountFields } from '../serialization/decimal.js';
import { ApiError, ApiErrorCode, notFound, validationError, asyncHandler } from '../middleware/errorHandler.js';
import { SerializationLogger, info, debug } from '../utils/logger.js';
import { type CacheClient, getCacheClient, CacheKey, TTL } from '../cache/redis.js';

export const streamsRouter = express.Router();

const AMOUNT_FIELDS = ['depositAmount', 'ratePerSecond'] as const;

interface Stream {
  id: string;
  sender: string;
  recipient: string;
  depositAmount: string;
  ratePerSecond: string;
  startTime: number;
  endTime: number;
  status: string;
}

const streams: Stream[] = [];

let _cacheOverride: CacheClient | null = null;

/** @internal for testing only */
export function setStreamsCache(client: CacheClient | null): void {
  _cacheOverride = client;
}

function getCache(): CacheClient {
  return _cacheOverride ?? getCacheClient();
}

streamsRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const cache = getCache();
    const cacheKey = CacheKey.streamList();
    const cached = await cache.get<{ streams: Stream[]; total: number }>(cacheKey);
    if (cached !== null) {
      debug('Stream list cache hit', { cacheKey });
      res.setHeader('X-Cache', 'HIT');
      res.json(cached);
      return;
    }
    info('Listing all streams', { count: streams.length });
    const payload = { streams, total: streams.length };
    await cache.set(cacheKey, payload, TTL.STREAM_LIST);
    res.setHeader('X-Cache', 'MISS');
    res.json(payload);
  }),
);

streamsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const cache = getCache();
    const cacheKey = CacheKey.stream(id ?? '');
    const cached = await cache.get<Stream>(cacheKey);
    if (cached !== null) {
      debug('Stream cache hit', { id, cacheKey });
      res.setHeader('X-Cache', 'HIT');
      res.json(cached);
      return;
    }
    debug('Fetching stream', { id, correlationId: req.correlationId });
    const stream = streams.find((s) => s.id === id);
    if (!stream) throw notFound('Stream', id);
    await cache.set(cacheKey, stream, TTL.STREAM);
    res.setHeader('X-Cache', 'MISS');
    res.json(stream);
  }),
);

streamsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const { sender, recipient, depositAmount, ratePerSecond, startTime, endTime } = body;
    const correlationId = req.correlationId;
    info('Creating new stream', { correlationId });
    if (typeof sender !== 'string' || sender.trim() === '') {
      throw validationError('sender must be a non-empty string');
    }
    if (typeof recipient !== 'string' || recipient.trim() === '') {
      throw validationError('recipient must be a non-empty string');
    }
    const amountValidation = validateAmountFields(
      { depositAmount, ratePerSecond } as Record<string, unknown>,
      AMOUNT_FIELDS as unknown as string[],
    );
    if (!amountValidation.valid) {
      for (const err of amountValidation.errors) {
        SerializationLogger.validationFailed(err.field ?? 'unknown', err.rawValue, err.code, correlationId);
      }
      throw new ApiError(
        ApiErrorCode.VALIDATION_ERROR,
        'Invalid decimal string format for amount fields',
        400,
        { errors: amountValidation.errors.map((e) => ({ field: e.field, code: e.code, message: e.message })) },
      );
    }
    const depositResult = validateDecimalString(depositAmount, 'depositAmount');
    const validatedDepositAmount = depositResult.valid && depositResult.value != null ? depositResult.value : '0';
    if (depositAmount !== undefined && depositAmount !== null) {
      if (parseFloat(validatedDepositAmount) <= 0) throw validationError('depositAmount must be greater than zero');
    }
    const rateResult = validateDecimalString(ratePerSecond, 'ratePerSecond');
    const validatedRatePerSecond = rateResult.valid && rateResult.value != null ? rateResult.value : '0';
    if (ratePerSecond !== undefined && ratePerSecond !== null) {
      if (parseFloat(validatedRatePerSecond) < 0) throw validationError('ratePerSecond cannot be negative');
    }
    let validatedStartTime = Math.floor(Date.now() / 1000);
    if (startTime !== undefined) {
      if (typeof startTime !== 'number' || !Number.isInteger(startTime) || startTime < 0) {
        throw validationError('startTime must be a non-negative integer');
      }
      validatedStartTime = startTime;
    }
    let validatedEndTime = 0;
    if (endTime !== undefined) {
      if (typeof endTime !== 'number' || !Number.isInteger(endTime) || endTime < 0) {
        throw validationError('endTime must be a non-negative integer');
      }
      validatedEndTime = endTime;
    }
    const id = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const stream: Stream = {
      id, sender: sender.trim(), recipient: recipient.trim(),
      depositAmount: validatedDepositAmount, ratePerSecond: validatedRatePerSecond,
      startTime: validatedStartTime, endTime: validatedEndTime, status: 'active',
    };
    streams.push(stream);
    SerializationLogger.amountSerialized(2, correlationId);
    info('Stream created', { id, correlationId });
    const cache = getCache();
    await Promise.all([cache.set(CacheKey.stream(id), stream, TTL.STREAM), cache.del(CacheKey.streamList())]);
    res.status(201).json(stream);
  }),
);

streamsRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    debug('Cancelling stream', { id, correlationId: req.correlationId });
    const index = streams.findIndex((s) => s.id === id);
    if (index === -1) throw notFound('Stream', id);
    const stream = streams[index];
    if (stream === undefined) throw notFound('Stream', id);
    if (stream.status === 'cancelled') {
      throw new ApiError(ApiErrorCode.CONFLICT, 'Stream is already cancelled', 409, { streamId: id });
    }
    if (stream.status === 'completed') {
      throw new ApiError(ApiErrorCode.CONFLICT, 'Cannot cancel a completed stream', 409, { streamId: id });
    }
    streams[index] = { ...stream, status: 'cancelled' };
    info('Stream cancelled', { id, correlationId: req.correlationId });
    const cache = getCache();
    await Promise.all([cache.del(CacheKey.stream(id ?? '')), cache.del(CacheKey.streamList())]);
    res.json({ message: 'Stream cancelled', id });
  }),
);
