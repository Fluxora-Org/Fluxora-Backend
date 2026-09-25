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
  NOT_ACCEPTABLE = 'NOT_ACCEPTABLE',
  PERSISTED_QUERY_INVALID = 'PERSISTED_QUERY_INVALID',
  PERSISTED_QUERY_UNSUPPORTED_VERSION = 'PERSISTED_QUERY_UNSUPPORTED_VERSION',
  PERSISTED_QUERY_INVALID_HASH = 'PERSISTED_QUERY_INVALID_HASH',
  PERSISTED_QUERY_HASH_MISMATCH = 'PERSISTED_QUERY_HASH_MISMATCH',
  PERSISTED_QUERY_NOT_FOUND = 'PERSISTED_QUERY_NOT_FOUND',
  GRAPHQL_PARSE_ERROR = 'GRAPHQL_PARSE_ERROR',
  FEATURE_FLAG_DISABLED = 'FEATURE_FLAG_DISABLED',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  RESTORE_ERROR = 'RESTORE_ERROR',
  PERSISTENCE_ERROR = 'PERSISTENCE_ERROR',
  API_KEY_ERROR = 'API_KEY_ERROR',
  DIAGNOSTICS_ERROR = 'DIAGNOSTICS_ERROR',
  SERVICE_SHUTTING_DOWN = 'SERVICE_SHUTTING_DOWN',
  HEALTH_CHECK_ERROR = 'HEALTH_CHECK_ERROR',
  CONSUMER_SUSPENDED = 'CONSUMER_SUSPENDED',
  ENTRY_ALREADY_REPLAYED = 'ENTRY_ALREADY_REPLAYED',
  INVALID_REQUEST = 'INVALID_REQUEST',
  QUEUE_ERROR = 'QUEUE_ERROR',
  INVALID_DELIVERY_ID = 'INVALID_DELIVERY_ID',
  DELIVERY_NOT_FOUND = 'DELIVERY_NOT_FOUND',
  INVALID_PAGINATION = 'INVALID_PAGINATION',
  INVALID_OUTBOX_FILTER = 'INVALID_OUTBOX_FILTER',
  INVALID_RETRY_REQUEST = 'INVALID_RETRY_REQUEST',
  DLQ_ITEM_NOT_FOUND = 'DLQ_ITEM_NOT_FOUND',
  DLQ_PROCESS_ERROR = 'DLQ_PROCESS_ERROR',
  DLQ_RETRY_ERROR = 'DLQ_RETRY_ERROR',
  INVALID_ENDPOINT_URL = 'INVALID_ENDPOINT_URL',
  OUTBOX_PROCESSING_ERROR = 'OUTBOX_PROCESSING_ERROR',
  INVALID_CLEANUP_REQUEST = 'INVALID_CLEANUP_REQUEST',
  CLEANUP_ERROR = 'CLEANUP_ERROR',
  CORS_ORIGIN_DENIED = 'CORS_ORIGIN_DENIED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  INVALID_ADDRESS = 'INVALID_ADDRESS',
  ERASURE_FAILED = 'ERASURE_FAILED',
  INTERNAL_CALLER_ADDRESS_MISSING = 'INTERNAL_CALLER_ADDRESS_MISSING',
  UNSUPPORTED_MEDIA_TYPE_LOWER = 'unsupported_media_type',
  PAYLOAD_TOO_LARGE_LOWER = 'payload_too_large',
  INVALID_ENCODING = 'invalid_encoding',
  PAYLOAD_TOO_DEEP = 'payload_too_deep',
  INVALID_JSON = 'invalid_json',
  MISSING_SECRET = 'missing_secret',
  MISSING_DELIVERY_ID = 'missing_delivery_id',
  MISSING_TIMESTAMP = 'missing_timestamp',
  MISSING_SIGNATURE = 'missing_signature',
  INVALID_TIMESTAMP = 'invalid_timestamp',
  TIMESTAMP_OUTSIDE_TOLERANCE = 'timestamp_outside_tolerance',
  PREVIOUS_SECRET_EXPIRED = 'previous_secret_expired',
  SIGNATURE_MISMATCH = 'signature_mismatch',
  DUPLICATE_DELIVERY = 'duplicate_delivery',
  UNSUPPORTED_VERSION = 'UNSUPPORTED_VERSION',
  IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT',
}

const apiErrorCodeValues = new Set<string>(Object.values(ApiErrorCode));

export function isApiErrorCode(code: string): code is ApiErrorCode {
  return apiErrorCodeValues.has(code);
}

export function toApiErrorCode(code: string | undefined): ApiErrorCode {
  return code !== undefined && isApiErrorCode(code) ? code : ApiErrorCode.INTERNAL_ERROR;
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