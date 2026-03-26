/**
 * Fluxora Backend Error Handler Middleware
 * 
 * Purpose: Provide consistent, operator-grade error responses across the API.
 * All errors are classified and logged for diagnostics.
 * 
 * Error Classification:
 * - VALIDATION_ERROR: Input validation failures (client error, 400)
 * - DECIMAL_ERROR: Decimal serialization policy violations (client error, 400)
 * - NOT_FOUND: Resource not found (client error, 404)
 * - CONFLICT: Duplicate or conflicting state (client error, 409)
 * - INTERNAL_ERROR: Unexpected server errors (server error, 500)
 * 
 * @module middleware/errorHandler
 */

import { Request, Response, NextFunction } from 'express';
import { DecimalSerializationError, DecimalErrorCode } from '../serialization/decimal.js';
import { SerializationLogger, error as logError } from '../utils/logger.js';

/**
 * Standard API error response format
 */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/**
 * API error codes for client-visible errors
 */
export enum ApiErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  DECIMAL_ERROR = 'DECIMAL_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
}

/**
 * Custom API error class
 */
export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Get HTTP status code for decimal error codes
 */
function getDecimalErrorStatus(code: DecimalErrorCode): number {
  switch (code) {
    case DecimalErrorCode.INVALID_TYPE:
    case DecimalErrorCode.INVALID_FORMAT:
    case DecimalErrorCode.EMPTY_VALUE:
      return 400; // Bad Request
    case DecimalErrorCode.OUT_OF_RANGE:
      return 400; // Bad Request
    case DecimalErrorCode.PRECISION_LOSS:
      return 400; // Bad Request
    default:
      return 400;
  }
}

/**
 * Get API error code for decimal error codes
 */
function getDecimalErrorApiCode(code: DecimalErrorCode): ApiErrorCode {
  return ApiErrorCode.DECIMAL_ERROR;
}

/**
 * Express error handler middleware
 * 
 * Catches all errors and returns a consistent JSON response.
 * All errors are logged with sufficient context for diagnosis.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = (req as Request & { id?: string }).id;

  // Handle DecimalSerializationError
  if (err instanceof DecimalSerializationError) {
    SerializationLogger.validationFailed(
      err.field || 'unknown',
      err.rawValue,
      err.code,
      requestId
    );

    const response: ApiErrorResponse = {
      error: {
        code: ApiErrorCode.DECIMAL_ERROR,
        message: err.message,
        details: {
          decimalErrorCode: err.code,
          field: err.field,
        },
        requestId,
      },
    };

    res.status(getDecimalErrorStatus(err.code)).json(response);
    return;
  }

  // Handle ApiError
  if (err instanceof ApiError) {
    logError(`API error: ${err.message}`, {
      code: err.code,
      statusCode: err.statusCode,
      details: err.details,
      requestId,
    });

    const response: ApiErrorResponse = {
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        requestId,
      },
    };

    res.status(err.statusCode).json(response);
    return;
  }

  // Handle unknown errors (500)
  logError('Unexpected error occurred', {
    errorName: err.name,
    errorMessage: err.message,
    stack: err.stack,
    requestId,
  });

  const response: ApiErrorResponse = {
    error: {
      code: ApiErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred. Please try again later.',
      requestId,
    },
  };

  res.status(500).json(response);
}

/**
 * Async handler wrapper to catch errors in async route handlers
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Create a not found error
 */
export function notFound(resource: string, id?: string): ApiError {
  const message = id ? `${resource} '${id}' not found` : `${resource} not found`;
  return new ApiError(ApiErrorCode.NOT_FOUND, message, 404);
}

/**
 * Create a validation error
 */
export function validationError(message: string, details?: unknown): ApiError {
  return new ApiError(ApiErrorCode.VALIDATION_ERROR, message, 400, details);
}

/**
 * Create a conflict error (e.g., duplicate resource)
 */
export function conflictError(message: string, details?: unknown): ApiError {
  return new ApiError(ApiErrorCode.CONFLICT, message, 409, details);
}

/**
 * Create a service unavailable error
 */
export function serviceUnavailable(message: string): ApiError {
  return new ApiError(ApiErrorCode.SERVICE_UNAVAILABLE, message, 503);
}
