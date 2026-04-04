/**
 * Retry Engine - Exponential backoff and retry scheduling for jobs
 *
 * Implements retry logic with exponential backoff, jitter, and error classification.
 * Distinguishes between transient errors (retry eligible) and permanent errors (fail fast).
 *
 * @module jobs/RetryEngine
 */

import { DEFAULT_JOB_CONFIGS, type JobType } from "./types.js";

/**
 * Error classification for retry decisions
 */
export type ErrorClassification = "transient" | "permanent";

/**
 * Result of retry decision
 */
export interface RetryDecision {
  /** Whether the job should be retried */
  shouldRetry: boolean;

  /** Reason for the decision */
  reason: string;

  /** Error classification */
  errorType: ErrorClassification;

  /** Next retry time (null if not retrying) */
  nextRetryAt: Date | null;

  /** Backoff delay in milliseconds (null if not retrying) */
  backoffMs: number | null;
}

/**
 * RetryEngine handles retry logic with exponential backoff and error classification
 */
export class RetryEngine {
  /**
   * Determine if a job should be retried based on attempt count and error
   *
   * @param jobType - Type of job
   * @param attempt - Current attempt number (0-indexed)
   * @param maxAttempts - Maximum retry attempts allowed
   * @param error - Error that occurred
   * @returns Retry decision with next retry time
   */
  shouldRetry(
    jobType: JobType,
    attempt: number,
    maxAttempts: number,
    error: Error | string,
  ): RetryDecision {
    const config = DEFAULT_JOB_CONFIGS[jobType];

    // Check if max attempts exceeded
    if (attempt >= maxAttempts) {
      return {
        shouldRetry: false,
        reason: `Max retry attempts (${maxAttempts}) exceeded`,
        errorType: this.classifyError(error),
        nextRetryAt: null,
        backoffMs: null,
      };
    }

    // Classify error
    const errorType = this.classifyError(error);

    // Don't retry permanent errors
    if (errorType === "permanent") {
      return {
        shouldRetry: false,
        reason: "Permanent error - will not retry",
        errorType,
        nextRetryAt: null,
        backoffMs: null,
      };
    }

    // Calculate backoff delay
    const backoffMs = this.calculateBackoff(
      attempt,
      config.initialBackoff,
      config.maxBackoff,
    );

    // Calculate next retry time
    const nextRetryAt = new Date(Date.now() + backoffMs);

    return {
      shouldRetry: true,
      reason: `Transient error - retry attempt ${attempt + 1}/${maxAttempts}`,
      errorType,
      nextRetryAt,
      backoffMs,
    };
  }

  /**
   * Calculate exponential backoff delay with jitter
   *
   * Formula: baseDelay = min(initialBackoff * (2^attempt), maxBackoff)
   *          jitter = random(0, baseDelay * 0.2)
   *          delay = baseDelay + jitter
   *
   * @param attempt - Current attempt number (0-indexed)
   * @param initialBackoff - Initial backoff delay in milliseconds
   * @param maxBackoff - Maximum backoff delay in milliseconds
   * @returns Backoff delay in milliseconds
   */
  calculateBackoff(
    attempt: number,
    initialBackoff: number,
    maxBackoff: number,
  ): number {
    // Calculate base delay with exponential backoff
    const baseDelay = Math.min(
      initialBackoff * Math.pow(2, attempt),
      maxBackoff,
    );

    // Add random jitter between 0 and 20% of base delay
    // This prevents thundering herd problem
    const jitter = Math.random() * baseDelay * 0.2;

    return Math.floor(baseDelay + jitter);
  }

  /**
   * Classify error as transient (retry eligible) or permanent (fail fast)
   *
   * Transient errors:
   * - Network timeouts (ETIMEDOUT, ECONNREFUSED, ENOTFOUND)
   * - Database connection errors (SQLITE_BUSY, SQLITE_LOCKED)
   * - Rate limits (HTTP 429, 503, 504)
   * - Temporary server errors (HTTP 500, 502)
   *
   * Permanent errors:
   * - Validation errors (HTTP 400, 422)
   * - Authorization failures (HTTP 401, 403)
   * - Resource not found (HTTP 404)
   * - Method not allowed (HTTP 405)
   *
   * @param error - Error to classify
   * @returns Error classification
   */
  classifyError(error: Error | string): ErrorClassification {
    const errorMessage =
      typeof error === "string" ? error : error.message || "";
    const errorName = typeof error === "string" ? "" : error.name || "";
    const errorMessageLower = errorMessage.toLowerCase();

    // Check for validation errors (check before HTTP status codes)
    if (
      errorMessageLower.includes("validation") ||
      errorMessageLower.includes("invalid") ||
      errorName === "ValidationError" ||
      errorName === "JobValidationError"
    ) {
      return "permanent";
    }

    // Check for authorization errors (check before HTTP status codes)
    if (
      errorMessageLower.includes("unauthorized") ||
      errorMessageLower.includes("forbidden") ||
      errorMessageLower.includes("not authorized") ||
      errorName === "UnauthorizedError" ||
      errorName === "ForbiddenError"
    ) {
      return "permanent";
    }

    // Check for not found errors (check before HTTP status codes)
    if (
      errorMessageLower.includes("not found") ||
      errorName === "NotFoundError" ||
      errorName === "JobNotFoundError"
    ) {
      return "permanent";
    }

    // Check for HTTP status codes in error message
    const statusCodeMatch = errorMessage.match(/\b(4\d{2}|5\d{2})\b/);
    if (statusCodeMatch && statusCodeMatch[1]) {
      const statusCode = parseInt(statusCodeMatch[1], 10);

      // Transient HTTP status codes
      if ([429, 500, 502, 503, 504].includes(statusCode)) {
        return "transient";
      }

      // Permanent HTTP status codes
      if ([400, 401, 403, 404, 405, 422].includes(statusCode)) {
        return "permanent";
      }
    }

    // Check for network timeout errors
    if (
      errorMessage.includes("ETIMEDOUT") ||
      errorMessageLower.includes("timeout") ||
      errorMessageLower.includes("timed out") ||
      errorName === "TimeoutError"
    ) {
      return "transient";
    }

    // Check for connection errors
    if (
      errorMessage.includes("ECONNREFUSED") ||
      errorMessage.includes("ENOTFOUND") ||
      errorMessage.includes("ECONNRESET") ||
      errorMessageLower.includes("connection refused") ||
      errorMessageLower.includes("connection reset")
    ) {
      return "transient";
    }

    // Check for database busy/locked errors
    if (
      errorMessage.includes("SQLITE_BUSY") ||
      errorMessage.includes("SQLITE_LOCKED") ||
      errorMessageLower.includes("database is locked")
    ) {
      return "transient";
    }

    // Default to transient for unknown errors
    // This is safer as it allows retry for unexpected issues
    return "transient";
  }

  /**
   * Calculate next retry time for a job
   *
   * @param jobType - Type of job
   * @param attempt - Current attempt number (0-indexed)
   * @returns Next retry time
   */
  calculateNextRetryTime(jobType: JobType, attempt: number): Date {
    const config = DEFAULT_JOB_CONFIGS[jobType];
    const backoffMs = this.calculateBackoff(
      attempt,
      config.initialBackoff,
      config.maxBackoff,
    );
    return new Date(Date.now() + backoffMs);
  }
}
