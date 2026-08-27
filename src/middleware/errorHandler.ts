import type { Request, Response, NextFunction } from 'express';
import { DecimalSerializationError } from '../serialization/decimal.js';
import { SerializationLogger, error as logError } from '../utils/logger.js';
import { errorResponse } from '../utils/response.js';
import { QueryTimeoutError } from '../db/pool.js';
import { REQUEST_ID_HEADER } from './correlationId.js';
import { ApiError, ApiErrorCode } from '../errors.js';
import { getActiveTraceSpanIds } from '../tracing/hooks.js';

export { ApiError, ApiErrorCode } from '../errors.js';

export interface ApiErrorResponse {
  success: false;
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

/**
 * Express error handler middleware
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.correlationId ?? (res.locals['requestId'] as string | undefined);

  // Read traceId / spanId from the active OTel span context (if any).
  // Degrades gracefully to an empty object when no tracing context exists
  // (e.g. background jobs, tracing disabled).
  const traceSpanIds = getActiveTraceSpanIds();

  // Ensure X-Request-ID is present even if correlationId middleware ran before
  // the route that set it, or if something cleared it.
  if (requestId && !res.headersSent) {
    res.setHeader(REQUEST_ID_HEADER, requestId);
  }

  if (err instanceof QueryTimeoutError) {
    res.status(504).json(
      errorResponse(ApiErrorCode.GATEWAY_TIMEOUT, 'Query timed out', undefined, requestId)
    );
    return;
  }

  if (err instanceof DecimalSerializationError) {
    SerializationLogger.validationFailed(err.field ?? 'unknown', err.rawValue, err.code, requestId);
    res.status(400).json(
      errorResponse(
        ApiErrorCode.DECIMAL_ERROR,
        err.message,
        { decimalErrorCode: err.code, field: err.field },
        requestId
      )
    );
    return;
  }

  if (err instanceof ApiError) {
    logError(`API error: ${err.message}`, { code: err.code, statusCode: err.statusCode, details: err.details, requestId, ...traceSpanIds });

    if (err.expose) {
      res.status(err.statusCode).json(
        errorResponse(err.code ?? ApiErrorCode.INTERNAL_ERROR, err.message, err.details, requestId)
      );
    } else {
      res.status(err.statusCode).json({
        success: false,
        message: 'Internal server error',
      });
    }
    return;
  }

  if ((err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json(
      errorResponse(
        ApiErrorCode.PAYLOAD_TOO_LARGE,
        'Request payload exceeds the configured size limit',
        undefined,
        requestId
      )
    );
    return;
  }

  // express.json() throws SyntaxError on malformed bodies — surface as 400.
  if (err instanceof SyntaxError && (err as SyntaxError & { status?: number }).status === 400) {
    res.status(400).json(
      errorResponse(
        ApiErrorCode.VALIDATION_ERROR,
        'Request body is not valid JSON',
        undefined,
        requestId,
      ),
    );
    return;
  }

  logError('Unexpected error occurred', {
    errorName: err.name,
    errorMessage: err.message,
    stack: err.stack,
    requestId,
    ...traceSpanIds,
  });

  res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
}

/** Async handler wrapper */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch((error: unknown) => next(error));
  };
}
