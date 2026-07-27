/**
 * Typed SDK exception hierarchy.
 *
 * Generated from `openapi.yaml` by `scripts/generate-sdk-ts.mjs`.
 * Do not edit by hand — run `pnpm generate:sdk:ts` instead.
 *
 * ## Hierarchy
 * ```
 * Error
 * └─ FluxoraClientError            (base for all SDK errors)
 *    ├─ FluxoraApiError             (non-2xx HTTP response)
 *    │  └─ IdempotencyConflictError (409 IDEMPOTENCY_CONFLICT)
 *    └─ ValidationError             (client-side input validation failure)
 * ```
 *
 * All classes call `Object.setPrototypeOf(this, new.target.prototype)` to
 * ensure correct `instanceof` behaviour after TypeScript transpilation.
 *
 * @module @fluxora/sdk/errors
 */

// ── Base ──────────────────────────────────────────────────────────────────────

/**
 * Base class for all errors thrown by the Fluxora TypeScript SDK.
 * Catch this type to handle both API errors and client-side validation failures.
 */
export class FluxoraClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FluxoraClientError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── API Error ─────────────────────────────────────────────────────────────────

/**
 * Thrown when the Fluxora API returns a non-2xx HTTP response.
 *
 * @example
 * ```typescript
 * try {
 *   await client.getStream('missing-id');
 * } catch (err) {
 *   if (err instanceof FluxoraApiError) {
 *     console.error(`HTTP ${err.statusCode} [${err.code}]: ${err.message}`);
 *     if (err.requestId) console.error('Request ID:', err.requestId);
 *   }
 * }
 * ```
 */
export class FluxoraApiError extends FluxoraClientError {
  /** HTTP status code (e.g. `400`, `404`, `503`). */
  public readonly statusCode: number;
  /** Machine-readable error code (e.g. `'VALIDATION_ERROR'`, `'NOT_FOUND'`). */
  public readonly code: string;
  /** Additional error context from the server response. */
  public readonly details?: unknown;
  /**
   * Correlation ID (`X-Request-ID` header) for tracing.
   * Include in support tickets to correlate with server logs.
   */
  public readonly requestId?: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
    requestId?: string,
  ) {
    super(`[${statusCode}] ${code}: ${message}`);
    this.name = 'FluxoraApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Idempotency Conflict ──────────────────────────────────────────────────────

/**
 * Thrown when the server returns HTTP 409 with code `IDEMPOTENCY_CONFLICT`.
 * The same `Idempotency-Key` was previously used with a **different** body.
 *
 * ## Resolution
 * - Generate a fresh idempotency key for the new request, **or**
 * - Retry with the original request body and the same key.
 *
 * @example
 * ```typescript
 * try {
 *   await client.createStream(payload, 'my-key');
 * } catch (err) {
 *   if (err instanceof IdempotencyConflictError) {
 *     console.error('Payload mismatch!');
 *     console.error('Stored hash:   ', err.storedHash);
 *     console.error('Incoming hash: ', err.incomingHash);
 *   }
 * }
 * ```
 */
export class IdempotencyConflictError extends FluxoraApiError {
  /** SHA-256 fingerprint of the **original** request body stored for this key. */
  public readonly storedHash?: string;
  /** SHA-256 fingerprint of the **current** (conflicting) request body. */
  public readonly incomingHash?: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    storedHash?: string,
    incomingHash?: string,
    details?: unknown,
    requestId?: string,
  ) {
    super(statusCode, code, message, details, requestId);
    this.name = 'IdempotencyConflictError';
    this.storedHash = storedHash;
    this.incomingHash = incomingHash;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Validation Error ──────────────────────────────────────────────────────────

/**
 * Thrown when **client-side** input validation rejects a parameter before any
 * HTTP request is dispatched.
 *
 * This is distinct from `FluxoraApiError` with `code = 'VALIDATION_ERROR'`,
 * which indicates a server-side rejection.
 *
 * @example
 * ```typescript
 * try {
 *   await client.getStream('');
 * } catch (err) {
 *   if (err instanceof ValidationError) {
 *     console.error('Bad input:', err.message);
 *   }
 * }
 * ```
 */
export class ValidationError extends FluxoraClientError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
