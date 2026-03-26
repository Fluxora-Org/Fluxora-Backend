import { Router, Request, Response } from 'express';
import { Logger } from '../config/logger.js';
import { validateCreateStreamRequest, validateStreamId, ValidationError } from '../config/validation.js';
import { successResponse, errorResponse } from '../utils/response.js';

export const streamsRouter = Router();

// Placeholder: replace with DB and contract sync later
const streams: Array<{
  id: string;
  sender: string;
  recipient: string;
  depositAmount: string;
  ratePerSecond: string;
  startTime: number;
  status: string;
}> = [];

/**
 * GET /api/streams - List all streams
 *
 * Success: 200 { success: true, data: { streams: [...] }, meta }
 */
streamsRouter.get('/', (req: Request, res: Response) => {
  const logger = req.app.locals.logger as Logger;

  try {
    logger.debug('Listing streams', { count: streams.length });
    res.json(successResponse({ streams }));
  } catch (err) {
    logger.error('Failed to list streams', err as Error);
    res.status(500).json(errorResponse('Failed to list streams', 'INTERNAL_ERROR'));
  }
});

/**
 * GET /api/streams/:id - Get a single stream
 *
 * Success: 200 { success: true, data: { stream }, meta }
 * Not found: 404 { success: false, error, code }
 * Invalid ID: 400 { success: false, error, code }
 */
streamsRouter.get('/:id', (req: Request, res: Response) => {
  const logger = req.app.locals.logger as Logger;

  try {
    const id = validateStreamId(req.params.id);
    const stream = streams.find((s) => s.id === id);

    if (!stream) {
      logger.debug('Stream not found', { id });
      return res.status(404).json(errorResponse('Stream not found', 'NOT_FOUND'));
    }

    logger.debug('Retrieved stream', { id });
    res.json(successResponse({ stream }));
  } catch (err) {
    if (err instanceof ValidationError) {
      logger.warn('Invalid stream ID', { id: req.params.id, error: err.message });
      return res.status(400).json(errorResponse(err.message, 'VALIDATION_ERROR', undefined, err.field));
    }

    logger.error('Failed to get stream', err as Error);
    res.status(500).json(errorResponse('Failed to get stream', 'INTERNAL_ERROR'));
  }
});

/**
 * POST /api/streams - Create a new stream
 *
 * Request body:
 *   sender: string (Stellar address)
 *   recipient: string (Stellar address)
 *   depositAmount: string (stroops)
 *   ratePerSecond: string (stroops/second)
 *   startTime: number (Unix timestamp)
 *
 * Success: 201 { success: true, data: { stream }, meta }
 * Validation error: 400 { success: false, error, code, field? }
 */
streamsRouter.post('/', (req: Request, res: Response) => {
  const logger = req.app.locals.logger as Logger;

  try {
    const validated = validateCreateStreamRequest(req.body);

    const id = `stream-${Date.now()}`;
    const stream = {
      id,
      sender: validated.sender,
      recipient: validated.recipient,
      depositAmount: validated.depositAmount,
      ratePerSecond: validated.ratePerSecond,
      startTime: validated.startTime,
      status: 'active',
    };

    streams.push(stream);

    logger.info('Stream created', {
      id,
      sender: validated.sender,
      recipient: validated.recipient,
      depositAmount: validated.depositAmount,
    });

    res.status(201).json(successResponse({ stream }));
  } catch (err) {
    if (err instanceof ValidationError) {
      logger.warn('Invalid stream creation request', {
        field: err.field,
        error: err.message,
      });
      return res.status(400).json(errorResponse(err.message, 'VALIDATION_ERROR', undefined, err.field));
    }

    logger.error('Failed to create stream', err as Error);
    res.status(500).json(errorResponse('Failed to create stream', 'INTERNAL_ERROR'));
  }
});
