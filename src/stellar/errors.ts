/**
 * Base RPC error class
 */
export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly correlationId?: string
  ) {
    super(message);
    this.name = 'RpcError';
    Object.setPrototypeOf(this, RpcError.prototype);
  }
}

/**
 * Error thrown when request times out
 */
export class RpcTimeoutError extends RpcError {
  constructor(message: string, correlationId?: string) {
    super(message, 'RPC_TIMEOUT', 504, correlationId);
    this.name = 'RpcTimeoutError';
    Object.setPrototypeOf(this, RpcTimeoutError.prototype);
  }
}

/**
 * Retry attempt history entry
 */
export interface RetryAttempt {
  attempt: number;
  error: Error;
  timestamp: number;
  backoffDelay?: number;
}

/**
 * Error thrown when retry attempts are exhausted
 */
export class RpcRetryExhaustedError extends RpcError {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError: Error,
    public readonly retryHistory: RetryAttempt[],
    correlationId?: string
  ) {
    super(message, 'RPC_RETRY_EXHAUSTED', 503, correlationId);
    this.name = 'RpcRetryExhaustedError';
    Object.setPrototypeOf(this, RpcRetryExhaustedError.prototype);
  }
}

/**
 * Error thrown when circuit breaker is open
 */
export class RpcCircuitOpenError extends RpcError {
  constructor(message: string, correlationId?: string) {
    super(message, 'RPC_CIRCUIT_OPEN', 503, correlationId);
    this.name = 'RpcCircuitOpenError';
    Object.setPrototypeOf(this, RpcCircuitOpenError.prototype);
  }
}

/**
 * Error thrown when validation fails
 */
export class RpcValidationError extends RpcError {
  constructor(
    message: string,
    public readonly field: string,
    correlationId?: string
  ) {
    super(message, 'RPC_VALIDATION_ERROR', 400, correlationId);
    this.name = 'RpcValidationError';
    Object.setPrototypeOf(this, RpcValidationError.prototype);
  }
}
