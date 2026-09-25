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
  UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE',
  GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT',
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

export function serviceUnavailable(message: string, details?: unknown): ApiError {
  return new ApiError(503, ApiErrorCode.SERVICE_UNAVAILABLE, message, details);
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