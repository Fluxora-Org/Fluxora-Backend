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

import express from 'express';
import { DecimalSerializationError, DecimalErrorCode } from '../serialization/decimal.js';
import { SerializationLogger, error as logError } from '../utils/logger.js';

/**
 * Standard API error response format
 */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    status?: number;
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
  DEPENDENCY_OUTAGE = 'DEPENDENCY_OUTAGE',
  PARTIAL_DATA = 'PARTIAL_DATA',
  DUPLICATE_DELIVERY = 'DUPLICATE_DELIVERY',
}

/**
 * Custom API error class
 */
export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode | string,
    message: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Internal interface to handle various error properties safely
 */
interface ExtendedError extends Error {
  code?: string;
  statusCode?: number;
  status?: number;
  field?: string;
  rawValue?: unknown;
  details?: unknown;
}

/**
 * Internal interface for requests with correlation IDs
 */
interface CorrelationIdRequest extends express.Request {
  id?: string;
  correlationId?: string;
}

/**
 * Get HTTP status code for decimal error codes
 */
function getDecimalErrorStatus(code: string | undefined): number {
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
 * Express error handler middleware
 */
export function errorHandler(
  err: ExtendedError,
  req: express.Request,
  res: express.Response,
  _next: express.NextFunction
): void {
  const cReq = req as CorrelationIdRequest;
  const requestId = cReq.correlationId || cReq.id;

  // Handle DecimalSerializationError (runtime check via name/code)
  if (err.constructor.name === 'DecimalSerializationError' || err.code?.startsWith('DECIMAL_')) {
    SerializationLogger.validationFailed(
      err.field || 'unknown',
      err.rawValue,
      err.code || 'DECIMAL_UNKNOWN',
      requestId
    );

    const response: ApiErrorResponse = {
      error: {
        code: ApiErrorCode.DECIMAL_ERROR,
        message: err.message,
        status: getDecimalErrorStatus(err.code),
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

  // Handle ApiError or standard Express errors with status (415, 404, etc.)
  const statusCode = err.statusCode || err.status || 500;
  const isApiError = err.constructor.name === 'ApiError' || err.statusCode !== undefined || err.status !== undefined;

  if (isApiError) {
    logError(`API or Express error: ${err.message}`, {
      code: err.code,
      statusCode,
      details: err.details,
      requestId,
    });

    const response: ApiErrorResponse = {
      error: {
        code: err.code || (statusCode === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : ApiErrorCode.INTERNAL_ERROR),
        message: err.message,
        status: statusCode,
        details: err.details,
        requestId,
      },
    };

    res.status(statusCode).json(response);
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
      status: 500,
      requestId,
    },
  };

  res.status(500).json(response);
}

/**
 * Async handler wrapper to catch errors in async route handlers
 */
export function asyncHandler(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
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

/**
 * Create a dependency outage error
 */
export function dependencyOutage(message: string, details?: unknown): ApiError {
  return new ApiError(ApiErrorCode.DEPENDENCY_OUTAGE, message, 503, details);
}

/**
 * Create a partial data error
 */
export function partialData(message: string, details?: unknown): ApiError {
  return new ApiError(ApiErrorCode.PARTIAL_DATA, message, 206, details);
}

/**
 * Create a duplicate delivery error
 */
export function duplicateDelivery(message: string, details?: unknown): ApiError {
  return new ApiError(ApiErrorCode.DUPLICATE_DELIVERY, message, 409, details);
}
