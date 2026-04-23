import type { Request, Response, NextFunction } from 'express';
import { DecimalSerializationError, DecimalErrorCode } from '../serialization/decimal.js';
import { SerializationLogger, error as logError } from '../utils/logger.js';
import { errorResponse } from '../utils/response.js';

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
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
}

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Express error handler middleware
 */
export function errorHandler(
  err: Error,
  req: any,
  res: any,
  _next: any
): void {
  const requestId = (req as Request & { id?: string }).id ?? (res.locals['requestId'] as string | undefined);

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
    logError(`API error: ${err.message}`, { code: err.code, statusCode: err.statusCode, details: err.details, requestId });
    res.status(err.statusCode).json(
      errorResponse(err.code, err.message, err.details, requestId)
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
export function asyncHandler(fn: (req: any, res: any, next: any) => Promise<void>) {
  return (req: any, res: any, next: any): void => {
    Promise.resolve(fn(req, res, next)).catch((error) => next(error));
  };
}

export function notFound(resource: string, id?: string): ApiError {
  return new ApiError(ApiErrorCode.NOT_FOUND, id !== undefined ? `${resource} '${id}' not found` : `${resource} not found`, 404);
}

export function validationError(message: string, details?: unknown): ApiError {
  return new ApiError(ApiErrorCode.VALIDATION_ERROR, message, 400, details);
}

export function conflictError(message: string, details?: unknown): ApiError {
  return new ApiError(ApiErrorCode.CONFLICT, message, 409, details);
}

export function serviceUnavailable(message: string): ApiError {
  return new ApiError(ApiErrorCode.SERVICE_UNAVAILABLE, message, 503);
}

export function unauthorized(message: string, details?: unknown): ApiError {
  return new ApiError(ApiErrorCode.UNAUTHORIZED, message, 401, details);
}

export function forbidden(message: string, details?: unknown): ApiError {
  return new ApiError(ApiErrorCode.FORBIDDEN, message, 403, details);
}

export function payloadTooLarge(message: string, details?: unknown): ApiError {
  return new ApiError(ApiErrorCode.PAYLOAD_TOO_LARGE, message, 413, details);
}

export function tooManyRequests(message: string, details?: unknown): ApiError {
  return new ApiError(ApiErrorCode.TOO_MANY_REQUESTS, message, 429, details);
}
