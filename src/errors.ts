import { randomUUID } from 'node:crypto';

import type { ErrorRequestHandler, RequestHandler } from 'express';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
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

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const requestId = req.header('x-request-id') || randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
};

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new ApiError(404, 'not_found', `No route matches ${req.method} ${req.originalUrl}`));
};

function normalizeExpressError(error: unknown) {
  const candidate = error as {
    status?: number;
    type?: string;
    message?: string;
  };

  if (candidate?.type === 'entity.parse.failed') {
    return new ApiError(400, 'invalid_json', 'Request body must be valid JSON');
  }

  if (candidate?.type === 'entity.too.large' || candidate?.status === 413) {
    return new ApiError(413, 'payload_too_large', 'Request body exceeds the 256 KiB limit');
  }

  if (error instanceof ApiError) {
    return error;
  }

  return new ApiError(500, 'internal_error', 'Internal server error', undefined, false);
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const normalized = normalizeExpressError(error);
  const requestId = res.locals.requestId as string;

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

  const body: Record<string, unknown> = {
    error: {
      code: normalized.code,
      message: normalized.message,
      status: normalized.status,
      requestId,
    },
  };

  if (normalized.details) {
    (body.error as Record<string, unknown>).details = normalized.details;
  }

  res.status(normalized.status).json(body);
};
