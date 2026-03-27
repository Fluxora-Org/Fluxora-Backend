import { Router, Request, Response } from 'express';
import {
  validateDecimalString,
  validateAmountFields,
  DecimalSerializationError,
} from '../serialization/decimal.js';
import {
  ApiError,
  ApiErrorCode,
  notFound,
  validationError,
  asyncHandler,
} from '../middleware/errorHandler.js';
import { SerializationLogger, info, debug } from '../utils/logger.js';

/**
 * @openapi
 * /api/streams:
 *   get:
 *     summary: List all streams
 *     description: |
 *       Returns all active streaming payment streams.
 *       All amount fields are serialized as decimal strings for precision.
 *     tags:
 *       - streams
 *     responses:
 *       200:
 *         description: List of streams
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 streams:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Stream'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 * 
 *   post:
 *     summary: Create a new stream
 *     description: |
 *       Creates a new streaming payment stream with the specified parameters.
 *       All amount fields must be provided as decimal strings.
 *       
 *       **Trust Boundary Note**: Amount fields are validated to ensure no precision
 *       loss when crossing the chain/API boundary. Invalid inputs receive explicit
 *       error responses.
 *     tags:
 *       - streams
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/StreamCreateRequest'
 *     responses:
 *       201:
 *         description: Stream created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Stream'
 *       400:
 *         description: Invalid input
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 * 
 * /api/streams/{id}:
 *   get:
 *     summary: Get a stream by ID
 *     description: |
 *       Returns a single stream by its identifier.
 *       All amount fields are serialized as decimal strings for precision.
 *     tags:
 *       - streams
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Stream identifier
 *     responses:
 *       200:
 *         description: Stream details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Stream'
 *       404:
 *         description: Stream not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 * 
 * components:
 *   schemas:
 *     Stream:
 *       type: object
 *       description: Streaming payment stream details
 *       properties:
 *         id:
 *           type: string
 *           description: Unique stream identifier
 *           example: "stream-1709123456789"
 *         sender:
 *           type: string
 *           description: Stellar account address of the sender
 *           example: "GCSX2..."
 *         recipient:
 *           type: string
 *           description: Stellar account address of the recipient
 *           example: "GDRX2..."
 *         depositAmount:
 *           type: string
 *           description: |
 *             Total deposit amount as a decimal string.
 *             Never serialized as a floating point number to prevent precision loss.
 *           pattern: '^[+-]?\d+(\.\d+)?$'
 *           example: "1000000.0000000"
 *         ratePerSecond:
 *           type: string
 *           description: |
 *             Streaming rate per second as a decimal string.
 *             Precision is critical for accurate time-based payments.
 *           pattern: '^[+-]?\d+(\.\d+)?$'
 *           example: "0.0000116"
 *         startTime:
 *           type: integer
 *           format: int64
 *           description: Unix timestamp when the stream started
 *           example: 1709123456
 *         endTime:
 *           type: integer
 *           format: int64
 *           description: Unix timestamp when the stream ends (0 if indefinite)
 *           example: 1711719456
 *         status:
 *           type: string
 *           enum: [active, paused, cancelled, completed]
 *           description: Current status of the stream
 *           example: "active"
 * 
 *     StreamCreateRequest:
 *       type: object
 *       required:
 *         - sender
 *         - recipient
 *         - depositAmount
 *         - ratePerSecond
 *       properties:
 *         sender:
 *           type: string
 *           description: Stellar account address of the sender
 *           example: "GCSX2..."
 *         recipient:
 *           type: string
 *           description: Stellar account address of the recipient
 *           example: "GDRX2..."
 *         depositAmount:
 *           type: string
 *           description: |
 *             Total deposit amount. Must be a decimal string.
 *             Example: "1000000.0000000" for 1 million XLM with 7 decimal places.
 *           pattern: '^[+-]?\d+(\.\d+)?$'
 *           example: "1000000.0000000"
 *         ratePerSecond:
 *           type: string
 *           description: |
 *             Streaming rate per second as a decimal string.
 *             For 1 XLM/day, use "0.0000116" (with 7 decimal precision).
 *           pattern: '^[+-]?\d+(\.\d+)?$'
 *           example: "0.0000116"
 *         startTime:
 *           type: integer
 *           format: int64
 *           description: Unix timestamp when the stream should start (optional, defaults to now)
 *           example: 1709123456
 * 
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: object
 *           properties:
 *             code:
 *               type: string
 *               description: Machine-readable error code
 *               enum:
 *                 - VALIDATION_ERROR
 *                 - DECIMAL_ERROR
 *                 - NOT_FOUND
 *                 - CONFLICT
 *                 - METHOD_NOT_ALLOWED
 *                 - INTERNAL_ERROR
 *                 - SERVICE_UNAVAILABLE
 *             message:
 *               type: string
 *               description: Human-readable error message
 *             details:
 *               type: object
 *               description: Additional error context (varies by error type)
 *             requestId:
 *               type: string
 *               description: Request identifier for tracing
 */

import { ApiError } from '../errors.js';

export const streamsRouter = Router();

// Amount fields that must be decimal strings per serialization policy
const AMOUNT_FIELDS = ['depositAmount', 'ratePerSecond'] as const;

// In-memory stream store (placeholder for DB integration)
const streams: Array<{
  id: string;
  sender: string;
  recipient: string;
  depositAmount: string;
  ratePerSecond: string;
  startTime: number;
  endTime: number;
  status: string;
}> = [];

/**
 * GET /api/streams
 * List all streams with decimal string serialization
 */
streamsRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    info('Listing all streams', { count: streams.length });
    debug('Streams retrieved', { streams: streams.length });

    res.json({
      streams,
      total: streams.length,
    });
  })
);

/**
 * GET /api/streams/:id
 * Get a single stream by ID
 */
streamsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const requestId = (req as Request & { id?: string }).id;

    debug('Fetching stream', { id, requestId });

    const stream = streams.find((s) => s.id === id);

    if (!stream) {
      throw notFound('Stream', id);
    }

    res.json(stream);
  })
);

/**
 * POST /api/streams
 * Create a new stream with decimal string validation
 */
streamsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { sender, recipient, depositAmount, ratePerSecond, startTime, endTime } = req.body ?? {};
    const requestId = (req as Request & { id?: string }).id;

    info('Creating new stream', { requestId });

    // Validate required string fields
    if (typeof sender !== 'string' || sender.trim() === '') {
      throw validationError('sender must be a non-empty string');
    }

    if (typeof recipient !== 'string' || recipient.trim() === '') {
      throw validationError('recipient must be a non-empty string');
    }

    // Validate amount fields against decimal string policy
    const amountValidation = validateAmountFields(
      { depositAmount, ratePerSecond } as Record<string, unknown>,
      AMOUNT_FIELDS as unknown as string[]
    );

    if (!amountValidation.valid) {
      // Log validation failures for diagnostics
      for (const err of amountValidation.errors) {
        SerializationLogger.validationFailed(
          err.field || 'unknown',
          err.rawValue,
          err.code,
          requestId
        );
      }

      throw new ApiError(
        ApiErrorCode.VALIDATION_ERROR,
        'Invalid decimal string format for amount fields',
        400,
        {
          errors: amountValidation.errors.map((e) => ({
            field: e.field,
            code: e.code,
            message: e.message,
          })),
        }
      );
    }

    // Additional semantic validation
    const depositResult = validateDecimalString(depositAmount, 'depositAmount');
    const validatedDepositAmount = depositResult.valid && depositResult.value
      ? depositResult.value
      : '0'; // Default to '0' for missing values
    
    // Only validate semantic constraints for provided values
    if (depositAmount !== undefined && depositAmount !== null) {
      const depositNum = parseFloat(validatedDepositAmount);
      if (depositNum <= 0) {
        throw validationError('depositAmount must be greater than zero');
      }
    }

    const rateResult = validateDecimalString(ratePerSecond, 'ratePerSecond');
    const validatedRatePerSecond = rateResult.valid && rateResult.value
      ? rateResult.value
      : '0'; // Default to '0' for missing values
    
    // Only validate semantic constraints for provided values
    if (ratePerSecond !== undefined && ratePerSecond !== null) {
      const rateNum = parseFloat(validatedRatePerSecond);
      if (rateNum < 0) {
        throw validationError('ratePerSecond cannot be negative');
      }
    }

    // Validate startTime if provided
    let validatedStartTime = Math.floor(Date.now() / 1000);
    if (startTime !== undefined) {
      if (typeof startTime !== 'number' || !Number.isInteger(startTime) || startTime < 0) {
        throw validationError('startTime must be a non-negative integer');
      }
      validatedStartTime = startTime;
    }

    // Validate endTime if provided
    let validatedEndTime = 0;
    if (endTime !== undefined) {
      if (typeof endTime !== 'number' || !Number.isInteger(endTime) || endTime < 0) {
        throw validationError('endTime must be a non-negative integer');
      }
      validatedEndTime = endTime;
    }

    // Create the stream with validated decimal strings
    const id = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const stream = {
      id,
      sender: sender.trim(),
      recipient: recipient.trim(),
      depositAmount: validatedDepositAmount,
      ratePerSecond: validatedRatePerSecond,
      startTime: validatedStartTime,
      endTime: validatedEndTime,
      status: 'active',
    };

    streams.push(stream);

    SerializationLogger.amountSerialized(2, requestId);
    info('Stream created', { id, requestId });

    res.status(201).json(stream);
  })
);

/**
 * DELETE /api/streams/:id
 * Cancel a stream
 * 
 * Failure modes:
 * - Stream not found: Returns 404
 * - Stream already cancelled: Returns 409 Conflict
 */
streamsRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const requestId = (req as Request & { id?: string }).id;

    debug('Deleting stream', { id, requestId });

    const index = streams.findIndex((s) => s.id === id);

    if (index === -1) {
      throw notFound('Stream', id);
    }

    const stream = streams[index];

    if (stream.status === 'cancelled') {
      throw new ApiError(
        ApiErrorCode.CONFLICT,
        'Stream is already cancelled',
        409,
        { streamId: id }
      );
    }

    if (stream.status === 'completed') {
      throw new ApiError(
        ApiErrorCode.CONFLICT,
        'Cannot cancel a completed stream',
        409,
        { streamId: id }
      );
    }

    streams[index] = { ...stream, status: 'cancelled' };

    info('Stream cancelled', { id, requestId });

    res.json({ message: 'Stream cancelled', id });
  })
);
