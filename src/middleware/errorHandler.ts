import type { Request, Response, NextFunction } from 'express';
import { DecimalSerializationError } from '../serialization/decimal.js';
import { SerializationLogger, error as logError } from '../utils/logger.js';
import { errorResponse } from '../utils/response.js';
import { ApiError } from '../errors.js';

export { ApiError } from '../errors.js';

export interface ApiErrorResponse {
  success: false;
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export enum ApiErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  DECIMAL_ERROR = 'DECIMAL_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
  METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED',
  REQUEST_TIMEOUT = 'REQUEST_TIMEOUT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  UNPROCESSABLE_ENTITY = 'UNPROCESSABLE_ENTITY',
  GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT',
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
  const requestId = req.id ?? (res.locals['requestId'] as string | undefined);

  if (err.name === 'QueryTimeoutError') {
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
    const clientCode = err.expose ? err.code : ApiErrorCode.INTERNAL_ERROR;
    const clientMessage = err.expose ? err.message : 'An unexpected error occurred. Please try again later.';
    const clientDetails = err.expose ? err.details : undefined;
    logError(`API error: ${err.message}`, {
      code: err.code,
      statusCode: err.statusCode,
      details: err.details,
      expose: err.expose,
      requestId,
    });
    res.status(err.statusCode).json(
      errorResponse(clientCode, clientMessage, clientDetails, requestId)
    );
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
  });

  res.status(500).json(
    errorResponse(
      ApiErrorCode.INTERNAL_ERROR,
      'An unexpected error occurred. Please try again later.',
      undefined,
      requestId
    )
  );
}

/** Async handler wrapper */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch((error: unknown) => next(error));
  };
}

export function notFound(resource: string, id?: string): ApiError {
  return new ApiError(404, ApiErrorCode.NOT_FOUND, id !== undefined ? `${resource} '${id}' not found` : `${resource} not found`);
}

export function validationError(message: string, details?: unknown): ApiError {
  return new ApiError(400, ApiErrorCode.VALIDATION_ERROR, message, details);
}

export function conflictError(message: string, details?: unknown): ApiError {
  return new ApiError(409, ApiErrorCode.CONFLICT, message, details);
}

export function serviceUnavailable(message: string): ApiError {
  return new ApiError(503, ApiErrorCode.SERVICE_UNAVAILABLE, message);
}

export function unauthorized(message: string, details?: unknown): ApiError {
  return new ApiError(401, ApiErrorCode.UNAUTHORIZED, message, details);
}

export function forbidden(message: string, details?: unknown): ApiError {
  return new ApiError(403, ApiErrorCode.FORBIDDEN, message, details);
}

export function payloadTooLarge(message: string, details?: unknown): ApiError {
  return new ApiError(413, ApiErrorCode.PAYLOAD_TOO_LARGE, message, details);
}

export function tooManyRequests(message: string, details?: unknown): ApiError {
  return new ApiError(429, ApiErrorCode.TOO_MANY_REQUESTS, message, details);
}

export function requestTimeout(message: string): ApiError {
  return new ApiError(408, ApiErrorCode.REQUEST_TIMEOUT, message);
}

export function gatewayTimeout(message: string): ApiError {
  return new ApiError(504, ApiErrorCode.GATEWAY_TIMEOUT, message);
}
