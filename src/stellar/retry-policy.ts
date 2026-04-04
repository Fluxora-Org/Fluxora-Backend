import { RpcError, RpcTimeoutError, RpcValidationError } from './errors.js';

/**
 * RetryPolicy implements exponential backoff with jitter for transient error retry logic
 */
export class RetryPolicy {
  constructor(
    private readonly maxRetries: number,
    private readonly initialBackoff: number,
    private readonly maxBackoff: number
  ) {}

  /**
   * Determines if an error should be retried based on attempt count and error type
   * @param attempt Current attempt number (0-indexed)
   * @param error The error that occurred
   * @returns true if the request should be retried, false otherwise
   */
  shouldRetry(attempt: number, error: Error): boolean {
    // Check if we've exceeded max retries
    if (attempt >= this.maxRetries) {
      return false;
    }

    // Classify error as transient or permanent
    return this.isTransientError(error);
  }

  /**
   * Calculates backoff delay with exponential backoff and jitter
   * Formula: min(initialBackoff * (2^attempt), maxBackoff) + jitter
   * Jitter is random value between 0 and 20% of calculated delay
   * @param attempt Current attempt number (0-indexed)
   * @returns Delay in milliseconds
   */
  getBackoffDelay(attempt: number): number {
    // Calculate base delay with exponential backoff
    const baseDelay = Math.min(
      this.initialBackoff * Math.pow(2, attempt),
      this.maxBackoff
    );

    // Add random jitter between 0 and 20% of base delay
    const jitter = Math.random() * baseDelay * 0.2;

    return baseDelay + jitter;
  }

  /**
   * Classifies errors as transient (retry eligible) or permanent (fail fast)
   * @param error The error to classify
   * @returns true if error is transient, false if permanent
   */
  private isTransientError(error: Error): boolean {
    // Check if error is an RpcError with status code
    if (error instanceof RpcError) {
      const statusCode = (error as RpcError).statusCode;

      if (statusCode !== undefined) {
        // Transient HTTP status codes
        const transientStatusCodes = [408, 429, 500, 502, 503, 504];
        if (transientStatusCodes.includes(statusCode)) {
          return true;
        }

        // Permanent HTTP status codes
        const permanentStatusCodes = [400, 401, 403, 404, 405, 422];
        if (permanentStatusCodes.includes(statusCode)) {
          return false;
        }
      }
    }

    // Check for timeout errors (transient)
    if (error instanceof RpcTimeoutError) {
      return true;
    }

    // Check for validation errors (permanent)
    if (error instanceof RpcValidationError) {
      return false;
    }

    // Check for network errors by error code
    if ('code' in error) {
      const errorCode = (error as any).code;
      
      // Network timeout (transient)
      if (errorCode === 'ETIMEDOUT') {
        return true;
      }

      // Connection refused (transient)
      if (errorCode === 'ECONNREFUSED') {
        return true;
      }
    }

    // Check for JSON parsing errors (permanent)
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
      return false;
    }

    // Default to permanent for unknown errors
    return false;
  }
}
