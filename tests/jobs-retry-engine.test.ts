/**
 * Unit tests for RetryEngine
 *
 * Tests retry logic, exponential backoff, jitter, and error classification.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RetryEngine } from "../src/jobs/RetryEngine.js";
import type { JobType } from "../src/jobs/types.js";

describe("RetryEngine", () => {
  let retryEngine: RetryEngine;

  beforeEach(() => {
    retryEngine = new RetryEngine();
  });

  describe("shouldRetry", () => {
    it("should retry transient errors within max attempts", () => {
      const error = new Error("Network timeout ETIMEDOUT");
      const decision = retryEngine.shouldRetry("stream-sync", 0, 3, error);

      expect(decision.shouldRetry).toBe(true);
      expect(decision.errorType).toBe("transient");
      expect(decision.reason).toContain("Transient error");
      expect(decision.nextRetryAt).not.toBeNull();
      expect(decision.backoffMs).toBeGreaterThan(0);
    });

    it("should not retry when max attempts exceeded", () => {
      const error = new Error("Network timeout");
      const decision = retryEngine.shouldRetry("stream-sync", 3, 3, error);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain("Max retry attempts");
      expect(decision.nextRetryAt).toBeNull();
      expect(decision.backoffMs).toBeNull();
    });

    it("should not retry permanent errors", () => {
      const error = new Error("Validation failed: invalid input");
      const decision = retryEngine.shouldRetry("stream-sync", 0, 3, error);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.errorType).toBe("permanent");
      expect(decision.reason).toContain("Permanent error");
      expect(decision.nextRetryAt).toBeNull();
      expect(decision.backoffMs).toBeNull();
    });

    it("should handle string errors", () => {
      const error = "Connection refused ECONNREFUSED";
      const decision = retryEngine.shouldRetry("stream-sync", 0, 3, error);

      expect(decision.shouldRetry).toBe(true);
      expect(decision.errorType).toBe("transient");
    });

    it("should include attempt count in reason", () => {
      const error = new Error("Timeout");
      const decision = retryEngine.shouldRetry("stream-sync", 1, 3, error);

      expect(decision.reason).toContain("retry attempt 2/3");
    });
  });

  describe("calculateBackoff", () => {
    it("should calculate exponential backoff correctly", () => {
      const initialBackoff = 1000;
      const maxBackoff = 60000;

      // Attempt 0: 1000ms base
      const delay0 = retryEngine.calculateBackoff(0, initialBackoff, maxBackoff);
      expect(delay0).toBeGreaterThanOrEqual(1000);
      expect(delay0).toBeLessThanOrEqual(1200); // 1000 + 20% jitter

      // Attempt 1: 2000ms base
      const delay1 = retryEngine.calculateBackoff(1, initialBackoff, maxBackoff);
      expect(delay1).toBeGreaterThanOrEqual(2000);
      expect(delay1).toBeLessThanOrEqual(2400);

      // Attempt 2: 4000ms base
      const delay2 = retryEngine.calculateBackoff(2, initialBackoff, maxBackoff);
      expect(delay2).toBeGreaterThanOrEqual(4000);
      expect(delay2).toBeLessThanOrEqual(4800);

      // Attempt 3: 8000ms base
      const delay3 = retryEngine.calculateBackoff(3, initialBackoff, maxBackoff);
      expect(delay3).toBeGreaterThanOrEqual(8000);
      expect(delay3).toBeLessThanOrEqual(9600);
    });

    it("should respect max backoff limit", () => {
      const initialBackoff = 1000;
      const maxBackoff = 5000;

      // Attempt 10 would be 1024000ms without cap
      const delay = retryEngine.calculateBackoff(10, initialBackoff, maxBackoff);
      expect(delay).toBeGreaterThanOrEqual(5000);
      expect(delay).toBeLessThanOrEqual(6000); // 5000 + 20% jitter
    });

    it("should add jitter to prevent thundering herd", () => {
      const initialBackoff = 1000;
      const maxBackoff = 60000;

      // Calculate multiple delays for same attempt
      const delays = Array.from({ length: 10 }, () =>
        retryEngine.calculateBackoff(2, initialBackoff, maxBackoff),
      );

      // All delays should be different (jitter is random)
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);

      // All delays should be within expected range
      delays.forEach((delay) => {
        expect(delay).toBeGreaterThanOrEqual(4000); // Base delay
        expect(delay).toBeLessThanOrEqual(4800); // Base + 20% jitter
      });
    });

    it("should return integer milliseconds", () => {
      const delay = retryEngine.calculateBackoff(1, 1000, 60000);
      expect(Number.isInteger(delay)).toBe(true);
    });
  });

  describe("classifyError", () => {
    describe("transient errors", () => {
      it("should classify network timeout errors as transient", () => {
        expect(retryEngine.classifyError(new Error("ETIMEDOUT"))).toBe("transient");
        expect(retryEngine.classifyError(new Error("Request timeout"))).toBe("transient");
        expect(retryEngine.classifyError(new Error("Operation timed out"))).toBe("transient");
        
        const timeoutError = new Error("Timeout");
        timeoutError.name = "TimeoutError";
        expect(retryEngine.classifyError(timeoutError)).toBe("transient");
      });

      it("should classify connection errors as transient", () => {
        expect(retryEngine.classifyError(new Error("ECONNREFUSED"))).toBe("transient");
        expect(retryEngine.classifyError(new Error("ENOTFOUND"))).toBe("transient");
        expect(retryEngine.classifyError(new Error("ECONNRESET"))).toBe("transient");
        expect(retryEngine.classifyError(new Error("connection refused"))).toBe("transient");
        expect(retryEngine.classifyError(new Error("connection reset"))).toBe("transient");
      });

      it("should classify database busy errors as transient", () => {
        expect(retryEngine.classifyError(new Error("SQLITE_BUSY"))).toBe("transient");
        expect(retryEngine.classifyError(new Error("SQLITE_LOCKED"))).toBe("transient");
        expect(retryEngine.classifyError(new Error("database is locked"))).toBe("transient");
      });

      it("should classify rate limit errors as transient", () => {
        expect(retryEngine.classifyError(new Error("HTTP 429 Too Many Requests"))).toBe("transient");
        expect(retryEngine.classifyError(new Error("Status code 503"))).toBe("transient");
        expect(retryEngine.classifyError(new Error("Error 504 Gateway Timeout"))).toBe("transient");
      });

      it("should classify server errors as transient", () => {
        expect(retryEngine.classifyError(new Error("HTTP 500 Internal Server Error"))).toBe("transient");
        expect(retryEngine.classifyError(new Error("Status 502 Bad Gateway"))).toBe("transient");
      });
    });

    describe("permanent errors", () => {
      it("should classify validation errors as permanent", () => {
        expect(retryEngine.classifyError(new Error("Validation failed"))).toBe("permanent");
        expect(retryEngine.classifyError(new Error("Invalid input"))).toBe("permanent");
        expect(retryEngine.classifyError(new Error("HTTP 400 Bad Request"))).toBe("permanent");
        expect(retryEngine.classifyError(new Error("Status 422 Unprocessable Entity"))).toBe("permanent");
        
        const validationError = new Error("Invalid data");
        validationError.name = "ValidationError";
        expect(retryEngine.classifyError(validationError)).toBe("permanent");
        
        const jobValidationError = new Error("Invalid job");
        jobValidationError.name = "JobValidationError";
        expect(retryEngine.classifyError(jobValidationError)).toBe("permanent");
      });

      it("should classify authorization errors as permanent", () => {
        expect(retryEngine.classifyError(new Error("Unauthorized"))).toBe("permanent");
        expect(retryEngine.classifyError(new Error("Forbidden"))).toBe("permanent");
        expect(retryEngine.classifyError(new Error("Not authorized"))).toBe("permanent");
        expect(retryEngine.classifyError(new Error("HTTP 401 Unauthorized"))).toBe("permanent");
        expect(retryEngine.classifyError(new Error("Status 403 Forbidden"))).toBe("permanent");
        
        const unauthorizedError = new Error("Access denied");
        unauthorizedError.name = "UnauthorizedError";
        expect(retryEngine.classifyError(unauthorizedError)).toBe("permanent");
        
        const forbiddenError = new Error("Access denied");
        forbiddenError.name = "ForbiddenError";
        expect(retryEngine.classifyError(forbiddenError)).toBe("permanent");
      });

      it("should classify not found errors as permanent", () => {
        expect(retryEngine.classifyError(new Error("Resource not found"))).toBe("permanent");
        expect(retryEngine.classifyError(new Error("HTTP 404 Not Found"))).toBe("permanent");
        expect(retryEngine.classifyError(new Error("Status 405 Method Not Allowed"))).toBe("permanent");
        
        const notFoundError = new Error("Missing");
        notFoundError.name = "NotFoundError";
        expect(retryEngine.classifyError(notFoundError)).toBe("permanent");
        
        const jobNotFoundError = new Error("Job missing");
        jobNotFoundError.name = "JobNotFoundError";
        expect(retryEngine.classifyError(jobNotFoundError)).toBe("permanent");
      });
    });

    it("should default to transient for unknown errors", () => {
      expect(retryEngine.classifyError(new Error("Unknown error"))).toBe("transient");
      expect(retryEngine.classifyError(new Error("Something went wrong"))).toBe("transient");
      expect(retryEngine.classifyError("Generic error string")).toBe("transient");
    });

    it("should handle errors with no message", () => {
      const error = new Error();
      expect(retryEngine.classifyError(error)).toBe("transient");
    });
  });

  describe("calculateNextRetryTime", () => {
    it("should calculate next retry time for stream-sync job", () => {
      const before = Date.now();
      const nextRetryAt = retryEngine.calculateNextRetryTime("stream-sync", 0);
      const after = Date.now();

      // Should be in the future
      expect(nextRetryAt.getTime()).toBeGreaterThan(before);

      // Should be within expected range (1000ms + 20% jitter)
      const delay = nextRetryAt.getTime() - before;
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1200);
    });

    it("should calculate next retry time for event-sync job", () => {
      const before = Date.now();
      const nextRetryAt = retryEngine.calculateNextRetryTime("event-sync", 0);
      const after = Date.now();

      // Should be in the future
      expect(nextRetryAt.getTime()).toBeGreaterThan(before);

      // Should be within expected range (2000ms + 20% jitter)
      const delay = nextRetryAt.getTime() - before;
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(2400);
    });

    it("should calculate next retry time for cleanup job", () => {
      const before = Date.now();
      const nextRetryAt = retryEngine.calculateNextRetryTime("cleanup", 0);
      const after = Date.now();

      // Should be in the future
      expect(nextRetryAt.getTime()).toBeGreaterThan(before);

      // Should be within expected range (5000ms + 20% jitter)
      const delay = nextRetryAt.getTime() - before;
      expect(delay).toBeGreaterThanOrEqual(5000);
      expect(delay).toBeLessThanOrEqual(6000);
    });

    it("should increase delay with attempt number", () => {
      const retry0 = retryEngine.calculateNextRetryTime("stream-sync", 0);
      const retry1 = retryEngine.calculateNextRetryTime("stream-sync", 1);
      const retry2 = retryEngine.calculateNextRetryTime("stream-sync", 2);

      const now = Date.now();
      const delay0 = retry0.getTime() - now;
      const delay1 = retry1.getTime() - now;
      const delay2 = retry2.getTime() - now;

      // Each delay should be approximately double the previous (with jitter)
      expect(delay1).toBeGreaterThan(delay0 * 1.5);
      expect(delay2).toBeGreaterThan(delay1 * 1.5);
    });
  });

  describe("integration scenarios", () => {
    it("should handle complete retry flow for transient error", () => {
      const jobType: JobType = "stream-sync";
      const maxAttempts = 3;

      // Attempt 0: Should retry
      const decision0 = retryEngine.shouldRetry(
        jobType,
        0,
        maxAttempts,
        new Error("Network timeout"),
      );
      expect(decision0.shouldRetry).toBe(true);
      expect(decision0.nextRetryAt).not.toBeNull();

      // Attempt 1: Should retry
      const decision1 = retryEngine.shouldRetry(
        jobType,
        1,
        maxAttempts,
        new Error("Network timeout"),
      );
      expect(decision1.shouldRetry).toBe(true);
      expect(decision1.backoffMs).toBeGreaterThan(decision0.backoffMs!);

      // Attempt 2: Should retry
      const decision2 = retryEngine.shouldRetry(
        jobType,
        2,
        maxAttempts,
        new Error("Network timeout"),
      );
      expect(decision2.shouldRetry).toBe(true);
      expect(decision2.backoffMs).toBeGreaterThan(decision1.backoffMs!);

      // Attempt 3: Max attempts exceeded
      const decision3 = retryEngine.shouldRetry(
        jobType,
        3,
        maxAttempts,
        new Error("Network timeout"),
      );
      expect(decision3.shouldRetry).toBe(false);
      expect(decision3.reason).toContain("Max retry attempts");
    });

    it("should fail fast on permanent error", () => {
      const jobType: JobType = "stream-sync";
      const maxAttempts = 3;

      // Attempt 0: Should not retry (permanent error)
      const decision = retryEngine.shouldRetry(
        jobType,
        0,
        maxAttempts,
        new Error("Validation failed: invalid payload"),
      );

      expect(decision.shouldRetry).toBe(false);
      expect(decision.errorType).toBe("permanent");
      expect(decision.nextRetryAt).toBeNull();
    });

    it("should handle different job types with different configs", () => {
      const error = new Error("Timeout");

      // stream-sync: initialBackoff 1000ms
      const streamDecision = retryEngine.shouldRetry("stream-sync", 0, 3, error);
      expect(streamDecision.backoffMs).toBeGreaterThanOrEqual(1000);
      expect(streamDecision.backoffMs).toBeLessThanOrEqual(1200);

      // event-sync: initialBackoff 2000ms
      const eventDecision = retryEngine.shouldRetry("event-sync", 0, 5, error);
      expect(eventDecision.backoffMs).toBeGreaterThanOrEqual(2000);
      expect(eventDecision.backoffMs).toBeLessThanOrEqual(2400);

      // cleanup: initialBackoff 5000ms
      const cleanupDecision = retryEngine.shouldRetry("cleanup", 0, 2, error);
      expect(cleanupDecision.backoffMs).toBeGreaterThanOrEqual(5000);
      expect(cleanupDecision.backoffMs).toBeLessThanOrEqual(6000);
    });
  });
});
