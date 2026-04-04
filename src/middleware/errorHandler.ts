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

import type { Request, Response, NextFunction } from 'express';
import { DecimalSerializationError, DecimalErrorCode } from '../serialization/decimal.js';
import { SerializationLogger, error as logError } from '../utils/logger.js';
import {
  RpcError,
  RpcTimeoutError,
  RpcCircuitOpenError,
  RpcRetryExhaustedError,
  RpcValidationError,
} from '../stellar/errors.js';

/**
 * Standard API error response format
 */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string | undefined;
    correlationId?: string | undefined;
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
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
  METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT',
  BAD_GATEWAY = 'BAD_GATEWAY',
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
 * Express error handler middleware
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = (req as Request & { id?: string }).id ?? (res.locals['requestId'] as string | undefined);

  // Handle RPC errors
  if (err instanceof RpcTimeoutError) {
    logError(`RPC timeout error: ${err.message}`, {
      code: err.code,
      correlationId: err.correlationId,
      requestId,
    });

    const response: ApiErrorResponse = {
      error: {
        code: ApiErrorCode.GATEWAY_TIMEOUT,
        message: err.message,
        details: {
          rpcErrorCode: err.code,
          correlationId: err.correlationId,
        },
        requestId,
        correlationId: err.correlationId,
      },
    };

    res.status(504).json(response);
    return;
  }

  if (err instanceof RpcCircuitOpenError) {
    logError(`RPC circuit open error: ${err.message}`, {
      code: err.code,
      correlationId: err.correlationId,
      requestId,
    });

    const response: ApiErrorResponse = {
      error: {
        code: ApiErrorCode.SERVICE_UNAVAILABLE,
        message: err.message,
        details: {
          rpcErrorCode: err.code,
          correlationId: err.correlationId,
        },
        requestId,
        correlationId: err.correlationId,
      },
    };

    res.status(503).json(response);
    return;
  }

  if (err instanceof RpcRetryExhaustedError) {
    logError(`RPC retry exhausted error: ${err.message}`, {
      code: err.code,
      attempts: err.attempts,
      correlationId: err.correlationId,
      requestId,
    });

    const response: ApiErrorResponse = {
      error: {
        code: ApiErrorCode.SERVICE_UNAVAILABLE,
        message: err.message,
        details: {
          rpcErrorCode: err.code,
          attempts: err.attempts,
          correlationId: err.correlationId,
        },
        requestId,
        correlationId: err.correlationId,
      },
    };

    res.status(503).json(response);
    return;
  }

  if (err instanceof RpcValidationError) {
    logError(`RPC validation error: ${err.message}`, {
      code: err.code,
      field: err.field,
      correlationId: err.correlationId,
      requestId,
    });

    const response: ApiErrorResponse = {
      error: {
        code: ApiErrorCode.VALIDATION_ERROR,
        message: err.message,
        details: {
          rpcErrorCode: err.code,
          field: err.field,
          correlationId: err.correlationId,
        },
        requestId,
        correlationId: err.correlationId,
      },
    };

    res.status(400).json(response);
    return;
  }

  // Handle generic RpcError (502 Bad Gateway)
  if (err instanceof RpcError) {
    logError(`RPC error: ${err.message}`, {
      code: err.code,
      statusCode: err.statusCode,
      correlationId: err.correlationId,
      requestId,
    });

    const response: ApiErrorResponse = {
      error: {
        code: ApiErrorCode.BAD_GATEWAY,
        message: err.message,
        details: {
          rpcErrorCode: err.code,
          correlationId: err.correlationId,
        },
        requestId,
        correlationId: err.correlationId,
      },
    };

    res.status(502).json(response);
    return;
  }

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

    // getDecimalErrorStatus removed, fallback to 400
    res.status(400).json(response);
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

  if ((err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({
      error: { code: ApiErrorCode.PAYLOAD_TOO_LARGE, message: 'Request payload exceeds the configured size limit', requestId },
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
