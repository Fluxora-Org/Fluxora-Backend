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