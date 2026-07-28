import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export class ApiError extends Error {
  /**
   * HTTP status code returned to the client.
   */
  public readonly statusCode: number;

  /**
   * Application-specific error code.
   */
  public readonly code?: string;

  /**
   * Optional structured details that may be exposed to the client.
   */
  public readonly details?: unknown;

  /**
   * Indicates whether details may be exposed to clients.
   *
   * expose=true:
   * - validation errors
   * - user-facing business rule failures
   *
   * expose=false:
   * - internal errors
   * - database failures
   * - infrastructure failures
   */
  public readonly expose: boolean;

  constructor(
    statusCode: number,
    code: string | undefined,
    message: string,
    details?: unknown,
    expose = true,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }
}

export function serviceUnavailable(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(503, 'service_unavailable', message, details);
}

export function unauthorizedError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(401, 'unauthorized', message, details);
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.header('x-request-id') ?? randomUUID();
  res.locals['requestId'] = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new ApiError(404, 'not_found', `No route matches ${req.method} ${req.originalUrl}`));
}

function normalizeExpressError(error: unknown): ApiError {
  const candidate = error as { status?: number; type?: string };

  if (candidate?.type === 'entity.parse.failed') {
    return new ApiError(400, 'invalid_json', 'Request body must be valid JSON');
  }
  if (candidate?.type === 'entity.too.large' || candidate?.status === 413) {
    return new ApiError(413, 'payload_too_large', 'Request body exceeds the 256 KiB limit');
  }
  if (error instanceof ApiError) return error;

  return new ApiError(500, 'internal_error', 'Internal server error', undefined, false);
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const normalized = normalizeExpressError(error);
  const requestId = res.locals['requestId'] as string | undefined;

  const log = {
    requestId,
    statusCode: normalized.statusCode,
    code: normalized.code,
    method: req.method,
    path: req.originalUrl,
    message: error instanceof Error ? error.message : normalized.message,
    details: normalized.details,
  };

  if (normalized.statusCode >= 500) {
    console.error('API error', log);
  } else {
    console.warn('API error', log);
  }

  const errorBody: Record<string, unknown> = {
    code: normalized.code,
    message: normalized.message,
    statusCode: normalized.statusCode,
    requestId,
  };
  if (normalized.details !== undefined) {
    errorBody['details'] = normalized.details;
  }

  res.status(normalized.statusCode).json({ error: errorBody });
}
