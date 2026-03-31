import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { ApiError as MiddlewareApiError } from './middleware/errorHandler.js';

export class ApiError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown> | undefined;
  expose: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    expose = true,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }
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

  // Also handle ApiError from middleware/errorHandler (streams route)
  if (error instanceof MiddlewareApiError) {
    return new ApiError(error.statusCode, error.code, error.message, undefined, true);
  }

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
    status: normalized.status,
    code: normalized.code,
    method: req.method,
    path: req.originalUrl,
    message: error instanceof Error ? error.message : normalized.message,
    details: normalized.details,
  };

  if (normalized.status >= 500) {
    console.error('API error', log);
  } else {
    console.warn('API error', log);
  }

  const errorBody: Record<string, unknown> = {
    code: normalized.code,
    message: normalized.message,
    status: normalized.status,
    requestId,
  };
  if (normalized.details !== undefined) {
    errorBody['details'] = normalized.details;
  }

  res.status(normalized.status).json({ error: errorBody });
}
