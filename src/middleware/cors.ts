import { ApiError, ApiErrorCode } from '../errors.js';
import { getRuntimeEnv } from '../config/runtime-env.js';
import { errorResponse } from '../utils/response.js';

export type CorsRequest = {
  method: string;
  header: (name: string) => string | undefined;
};

export type CorsResponse = {
  setHeader: (name: string, value: string) => void;
  removeHeader: (name: string) => void;
  sendStatus: (code: number) => void;
  status: (code: number) => {
    json: (body: unknown) => void;
  };
};

export type CorsNext = (err?: unknown) => void;

export type CorsRejectionReason = 'empty' | 'oversized' | 'malformed';

/**
 * Typed error thrown or passed to next() when CORS input validation fails.
 * Extends ApiError so that standard error-handling infrastructure processes it
 * with the correct HTTP status code and ApiErrorCode.
 */
export class CorsValidationError extends ApiError {
  public readonly reason: CorsRejectionReason;

  constructor(message: string, reason: CorsRejectionReason, details?: unknown) {
    const statusCode = reason === 'oversized' ? 413 : 400;
    const code =
      reason === 'oversized' ? ApiErrorCode.PAYLOAD_TOO_LARGE : ApiErrorCode.VALIDATION_ERROR;
    super(statusCode, code, message, details ?? { reason });
    this.name = 'CorsValidationError';
    this.reason = reason;
  }
}

export const MAX_ORIGIN_LENGTH = 2048;
export const MAX_REQUEST_HEADERS_LENGTH = 2048;
export const MAX_REQUEST_METHOD_LENGTH = 64;

const DEFAULT_ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const DEFAULT_ALLOWED_HEADERS = 'Content-Type,Authorization,X-Correlation-ID';
const CORS_PERMISSION_HEADERS = [
  'Access-Control-Allow-Origin',
  'Access-Control-Allow-Credentials',
  'Access-Control-Allow-Methods',
  'Access-Control-Allow-Headers',
  'Access-Control-Max-Age',
];
const PREFLIGHT_MAX_AGE = '86400'; // 24 hours in seconds

/**
 * Validates an Origin string per RFC 6454.
 * Rejects empty, oversized, or malformed origin inputs with a typed CorsValidationError.
 */
export function validateOrigin(origin: unknown): string {
  if (typeof origin !== 'string') {
    throw new CorsValidationError('Origin header must be a string', 'malformed');
  }

  const trimmed = origin.trim();
  if (trimmed.length === 0) {
    throw new CorsValidationError('Origin header cannot be empty', 'empty');
  }

  if (origin.length > MAX_ORIGIN_LENGTH) {
    throw new CorsValidationError(
      'Origin header exceeds maximum allowed length of ' + MAX_ORIGIN_LENGTH + ' characters',
      'oversized'
    );
  }

  // Reject CRLF injection, null bytes, and non-printable control characters
  if (/[\r\n\0\x00-\x1F\x7F]/.test(origin)) {
    throw new CorsValidationError('Origin header contains forbidden control characters', 'malformed');
  }

  // Origins must not contain whitespace
  if (/\s/.test(origin)) {
    throw new CorsValidationError('Origin header cannot contain whitespace', 'malformed');
  }

  // 'null' is a valid opaque origin per RFC 6454
  if (origin === 'null') {
    return 'null';
  }

  // Parse and validate standard URL origin structure
  try {
    const parsed = new URL(origin);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new CorsValidationError('Origin protocol \'' + parsed.protocol + '\' is not supported', 'malformed');
    }

    if (parsed.username || parsed.password) {
      throw new CorsValidationError('Origin cannot contain user credentials', 'malformed');
    }

    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      throw new CorsValidationError('Origin cannot contain a path', 'malformed');
    }

    if (parsed.search) {
      throw new CorsValidationError('Origin cannot contain query parameters', 'malformed');
    }

    if (parsed.hash) {
      throw new CorsValidationError('Origin cannot contain a fragment', 'malformed');
    }

    // Must match canonical serialization (no trailing slash, normalized lowercase scheme/host)
    if (origin !== parsed.origin) {
      throw new CorsValidationError(
        'Origin must be in canonical format without trailing slash or path',
        'malformed'
      );
    }
  } catch (err) {
    if (err instanceof CorsValidationError) {
      throw err;
    }
    throw new CorsValidationError('Origin header is malformed: ' + (err as Error).message, 'malformed');
  }

  return origin;
}

/**
 * Validates Access-Control-Request-Headers string per RFC 7230.
 */
export function validateRequestHeaders(headers: unknown): string | undefined {
  if (headers === undefined) {
    return undefined;
  }

  if (typeof headers !== 'string') {
    throw new CorsValidationError('Access-Control-Request-Headers must be a string', 'malformed');
  }

  const trimmed = headers.trim();
  if (trimmed.length === 0) {
    throw new CorsValidationError('Access-Control-Request-Headers cannot be empty', 'empty');
  }

  if (headers.length > MAX_REQUEST_HEADERS_LENGTH) {
    throw new CorsValidationError(
      'Access-Control-Request-Headers exceeds maximum allowed length of ' + MAX_REQUEST_HEADERS_LENGTH + ' characters',
      'oversized'
    );
  }

  if (/[\r\n\0\x00-\x1F\x7F]/.test(headers)) {
    throw new CorsValidationError(
      'Access-Control-Request-Headers contains forbidden control characters',
      'malformed'
    );
  }

  const tokens = headers.split(',').map((h) => h.trim());
  for (const token of tokens) {
    if (token.length === 0) {
      throw new CorsValidationError(
        'Access-Control-Request-Headers contains empty header entry',
        'malformed'
      );
    }
    // RFC 7230 1*tchar token pattern
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(token)) {
      throw new CorsValidationError(
        'Access-Control-Request-Headers contains malformed header name \'' + token + '\'',
        'malformed'
      );
    }
  }

  return headers;
}

/**
 * Validates Access-Control-Request-Method token.
 */
export function validateRequestMethod(method: unknown): string | undefined {
  if (method === undefined) {
    return undefined;
  }

  if (typeof method !== 'string') {
    throw new CorsValidationError('Access-Control-Request-Method must be a string', 'malformed');
  }

  const trimmed = method.trim();
  if (trimmed.length === 0) {
    throw new CorsValidationError('Access-Control-Request-Method cannot be empty', 'empty');
  }

  if (method.length > MAX_REQUEST_METHOD_LENGTH) {
    throw new CorsValidationError(
      'Access-Control-Request-Method exceeds maximum allowed length of ' + MAX_REQUEST_METHOD_LENGTH + ' characters',
      'oversized'
    );
  }

  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(method)) {
    throw new CorsValidationError(
      'Access-Control-Request-Method contains malformed method name \'' + method + '\'',
      'malformed'
    );
  }

  return method;
}

export function isOriginAllowed(origin: string, allowedOrigins: Set<string>): boolean {
  validateOrigin(origin);
  return origin !== 'null' && !origin.includes('*') && allowedOrigins.has(origin);
}

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

function isProduction(): boolean {
  return getRuntimeEnv().NODE_ENV === 'production';
}

function clearCorsPermissionHeaders(res: CorsResponse): void {
  for (const header of CORS_PERMISSION_HEADERS) {
    res.removeHeader(header);
  }
}

function allowOrigin(
  req: CorsRequest,
  res: CorsResponse,
  origin: string,
  useWildcard: boolean
): void {
  clearCorsPermissionHeaders(res);
  if (useWildcard) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', DEFAULT_ALLOWED_METHODS);

  // Echo back the requested headers if present, otherwise use defaults.
  const requestedHeaders = req.header('Access-Control-Request-Headers');
  res.setHeader('Access-Control-Allow-Headers', requestedHeaders ?? DEFAULT_ALLOWED_HEADERS);
}

function isPreflight(req: CorsRequest): boolean {
  return req.method === 'OPTIONS' && Boolean(req.header('Origin'));
}

export function corsAllowlistMiddleware(req: CorsRequest, res: CorsResponse, next: CorsNext): void {
  const origin = req.header('Origin');

  // Validate Origin before any state or headers are written
  if (origin !== undefined) {
    try {
      validateOrigin(origin);
    } catch (err) {
      return next(err);
    }
  }

  // Validate Access-Control-Request-Headers before any state is written
  const requestHeaders = req.header('Access-Control-Request-Headers');
  if (requestHeaders !== undefined) {
    try {
      validateRequestHeaders(requestHeaders);
    } catch (err) {
      return next(err);
    }
  }

  // Validate Access-Control-Request-Method before any state is written
  const requestMethod = req.header('Access-Control-Request-Method');
  if (requestMethod !== undefined) {
    try {
      validateRequestMethod(requestMethod);
    } catch (err) {
      return next(err);
    }
  }

  // Non-browser or same-origin requests do not carry Origin.
  if (!origin) {
    clearCorsPermissionHeaders(res);
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
    return;
  }

  const allowedOrigins = parseAllowedOrigins(getRuntimeEnv().CORS_ALLOWED_ORIGINS);
  const allowAnyOrigin = !isProduction() && (allowedOrigins.size === 0 || allowedOrigins.has('*'));
  const isAllowed = allowAnyOrigin || isOriginAllowed(origin, allowedOrigins);

  if (isAllowed) {
    allowOrigin(req, res, origin, allowAnyOrigin);
    if (isPreflight(req)) {
      res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
      res.sendStatus(204);
      return;
    }
    next();
    return;
  }

  clearCorsPermissionHeaders(res);
  if (isPreflight(req)) {
    res.status(403).json(errorResponse('CORS_ORIGIN_DENIED', 'Origin is not allowed by CORS policy'));
    return;
  }

  next();
}
