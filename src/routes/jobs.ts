/**
 * Jobs API Routes
 *
 * Provides endpoints for background job submission, status queries, and management.
 * Implements authentication, validation, idempotency, and rate limiting.
 *
 * @module routes/jobs
 */

import { Router, Request, Response } from "express";
import { JobManager, JobValidationError } from "../jobs/JobManager.js";
import { type CreateJobInput, type JobType, type JobPriority } from "../jobs/types.js";
import { asyncHandler, validationError, ApiError, ApiErrorCode } from "../middleware/errorHandler.js";
import { authenticate, requireAuth } from "../middleware/auth.js";
import { RateLimiter, RateLimitError } from "../jobs/RateLimiter.js";
import { info, warn, error as logError } from "../utils/logger.js";

export const jobsRouter = Router();

// Apply authentication to all job routes
jobsRouter.use(authenticate);
jobsRouter.use(requireAuth);

// Rate limiter for job submissions
const rateLimiter = new RateLimiter();

const jobManager = new JobManager();

/**
 * Validate job type
 */
function isValidJobType(type: string): type is JobType {
  return ["stream-sync", "event-sync", "cleanup"].includes(type);
}

/**
 * Validate job priority
 */
function isValidPriority(priority: string): priority is JobPriority {
  return ["high", "normal", "low"].includes(priority);
}

/**
 * POST /api/jobs
 * Submit a new background job
 *
 * Request body:
 * {
 *   "jobType": "stream-sync",
 *   "priority": "normal",
 *   "payload": { ... },
 *   "idempotencyKey": "optional-uuid"
 * }
 *
 * Response 202 Accepted:
 * {
 *   "jobId": "uuid",
 *   "state": "PENDING",
 *   "createdAt": "2024-01-01T00:00:00Z",
 *   "requestId": "correlation-id"
 * }
 */
jobsRouter.post(
  "/",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const correlationId = req.correlationId;
    const user = req.user!; // requireAuth ensures user is present

    info("Job submission request received", {
      userId: user.address!,
      ...(correlationId && { correlationId }),
    });

    // Validate request body
    const { jobType, priority, payload, idempotencyKey } = req.body;

    // Validate required fields
    if (!jobType) {
      throw validationError("jobType is required", { field: "jobType" });
    }

    if (!priority) {
      throw validationError("priority is required", { field: "priority" });
    }

    if (!payload || typeof payload !== "object") {
      throw validationError("payload is required and must be an object", {
        field: "payload",
      });
    }

    // Validate job type
    if (!isValidJobType(jobType)) {
      throw validationError(
        `Invalid jobType. Must be one of: stream-sync, event-sync, cleanup`,
        {
          field: "jobType",
          providedValue: jobType,
        },
      );
    }

    // Validate priority
    if (!isValidPriority(priority)) {
      throw validationError(
        `Invalid priority. Must be one of: high, normal, low`,
        {
          field: "priority",
          providedValue: priority,
        },
      );
    }

    // Validate idempotency key format if provided
    if (idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
        throw validationError("idempotencyKey must be a non-empty string", {
          field: "idempotencyKey",
        });
      }

      if (idempotencyKey.length > 255) {
        throw validationError("idempotencyKey must not exceed 255 characters", {
          field: "idempotencyKey",
        });
      }
    }

    try {
      // Check rate limits before creating job
      const rateLimitResult = rateLimiter.checkRateLimit(user.address!, jobType);

      if (!rateLimitResult.allowed) {
        warn("Rate limit exceeded", {
          userId: user.address!,
          jobType,
          reason: rateLimitResult.reason,
          retryAfter: rateLimitResult.retryAfter,
          ...(correlationId && { correlationId }),
        });

        // Set rate limit headers
        if (rateLimitResult.rateLimit) {
          res.setHeader(
            "X-RateLimit-Limit",
            rateLimitResult.rateLimit.limit.toString(),
          );
          res.setHeader(
            "X-RateLimit-Remaining",
            rateLimitResult.rateLimit.remaining.toString(),
          );
          res.setHeader(
            "X-RateLimit-Reset",
            rateLimitResult.rateLimit.reset.toString(),
          );
        }

        if (rateLimitResult.retryAfter) {
          res.setHeader("Retry-After", rateLimitResult.retryAfter.toString());
        }

        return res.status(429).json({
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests, please try again later.",
          },
        });
      }

      // Set rate limit headers for successful requests
      if (rateLimitResult.rateLimit) {
        res.setHeader(
          "X-RateLimit-Limit",
          rateLimitResult.rateLimit.limit.toString(),
        );
        res.setHeader(
          "X-RateLimit-Remaining",
          rateLimitResult.rateLimit.remaining.toString(),
        );
        res.setHeader(
          "X-RateLimit-Reset",
          rateLimitResult.rateLimit.reset.toString(),
        );
      }

      // Create job input
      const jobInput: CreateJobInput = {
        user_id: user.address!,
        job_type: jobType,
        priority: priority,
        payload: payload,
        ...(idempotencyKey && { idempotency_key: idempotencyKey }),
        ...(correlationId && { correlation_id: correlationId }),
      };

      // Create job using JobManager
      const job = jobManager.createJob(jobInput);

      info("Job created successfully", {
        jobId: job.id,
        userId: user.address,
        jobType: job.job_type,
        priority: job.priority,
        isIdempotent: !!job.idempotency_key,
        ...(correlationId && { correlationId }),
      });

      // Return 202 Accepted with job details
      res.status(202).json({
        jobId: job.id,
        state: job.state,
        createdAt: job.created_at,
        requestId: correlationId,
      });
    } catch (err) {
      // Handle JobValidationError
      if (err instanceof JobValidationError) {
        logError("Job validation failed", {
          userId: user.address,
          error: err.message,
          ...(correlationId && { correlationId }),
        });
        throw validationError(err.message);
      }

      // Re-throw other errors to be handled by error middleware
      throw err;
    }
  }),
);

/**
 * GET /api/jobs/{jobId}
 * Get job status by ID
 *
 * Response 200 OK:
 * {
 *   "jobId": "uuid",
 *   "state": "RUNNING",
 *   "progress": 45,
 *   "estimatedCompletionAt": "2024-01-01T00:05:00Z",
 *   "createdAt": "2024-01-01T00:00:00Z",
 *   "startedAt": "2024-01-01T00:01:00Z",
 *   "completedAt": null,
 *   "result": null,
 *   "error": null,
 *   "history": [...]
 * }
 */
jobsRouter.get(
  "/:jobId",
  asyncHandler(async (req: Request, res: Response) => {
    const correlationId = req.correlationId;
    const user = req.user!; // requireAuth ensures user is present
    const { jobId } = req.params;

    info("Job status query received", {
      jobId,
      userId: user.address,
      ...(correlationId && { correlationId }),
    });

    // Validate jobId format (UUID)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(jobId)) {
      throw validationError("Invalid jobId format. Must be a valid UUID", {
        field: "jobId",
      });
    }

    try {
      // Get job
      const job = jobManager.getJobById(jobId);

      // Authorization check: users can only see their own jobs, admins can see all
      const isAdmin = user.role === "admin";
      const isOwner = job.user_id === user.address!;

      if (!isAdmin && !isOwner) {
        warn("Unauthorized job access attempt", {
          jobId,
          userId: user.address!,
          jobOwnerId: job.user_id,
          ...(correlationId && { correlationId }),
        });

        throw new ApiError(
          ApiErrorCode.FORBIDDEN,
          "You do not have permission to access this job",
          403,
        );
      }

      // Get job history
      const history = jobManager.getJobHistory(jobId);

      // Parse JSON fields
      const payload = JSON.parse(job.payload);
      const result = job.result ? JSON.parse(job.result) : null;

      // Build response
      const response = {
        jobId: job.id,
        userId: job.user_id,
        jobType: job.job_type,
        priority: job.priority === 2 ? "high" : job.priority === 1 ? "normal" : "low",
        state: job.state,
        payload,
        result,
        error: job.error_message
          ? {
              message: job.error_message,
              code: job.error_code,
            }
          : null,
        createdAt: job.created_at,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        scheduledFor: job.scheduled_for,
        attempt: job.attempt,
        maxAttempts: job.max_attempts,
        nextRetryAt: job.next_retry_at,
        workerId: job.worker_id,
        progress: job.progress_percent,
        estimatedCompletionAt: job.estimated_completion_at,
        history: history.map((h) => ({
          oldState: h.old_state,
          newState: h.new_state,
          reason: h.transition_reason,
          transitionedAt: h.transitioned_at,
        })),
        requestId: correlationId,
      };

      info("Job status retrieved successfully", {
        jobId,
        state: job.state,
        userId: user.address,
        ...(correlationId && { correlationId }),
      });

      res.status(200).json(response);
    } catch (err) {
      // Handle JobNotFoundError
      if (err instanceof Error && err.name === "JobNotFoundError") {
        throw new ApiError(
          ApiErrorCode.NOT_FOUND,
          `Job not found: ${jobId}`,
          404,
        );
      }

      // Re-throw other errors
      throw err;
    }
  }),
);

/**
 * GET /api/jobs
 * List jobs with filtering and pagination
 *
 * Query parameters:
 * - jobType: Filter by job type (stream-sync, event-sync, cleanup)
 * - state: Filter by state (PENDING, RUNNING, COMPLETED, FAILED, RETRYING, CANCELLED)
 * - priority: Filter by priority (high, normal, low)
 * - createdAfter: Filter by creation date (ISO 8601)
 * - createdBefore: Filter by creation date (ISO 8601)
 * - limit: Number of results per page (default: 20, max: 100)
 * - offset: Offset for pagination (default: 0)
 *
 * Response 200 OK:
 * {
 *   "jobs": [...],
 *   "total": 100,
 *   "limit": 20,
 *   "offset": 0,
 *   "hasMore": true
 * }
 */
jobsRouter.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const correlationId = req.correlationId;
    const user = req.user!; // requireAuth ensures user is present

    info("Job list query received", {
      userId: user.address,
      query: req.query,
      ...(correlationId && { correlationId }),
    });

    // Parse and validate query parameters
    const {
      jobType,
      state,
      priority,
      createdAfter,
      createdBefore,
      limit = "20",
      offset = "0",
    } = req.query;

    // Validate and parse limit
    const parsedLimit = parseInt(limit as string, 10);
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw validationError("limit must be between 1 and 100", {
        field: "limit",
      });
    }

    // Validate and parse offset
    const parsedOffset = parseInt(offset as string, 10);
    if (isNaN(parsedOffset) || parsedOffset < 0) {
      throw validationError("offset must be a non-negative integer", {
        field: "offset",
      });
    }

    // Build filter
    const filter: import("../jobs/types.js").JobFilter = {};

    // Authorization: users can only see their own jobs, admins can see all
    const isAdmin = user.role === "admin";
    if (!isAdmin) {
      filter.user_id = user.address;
    }

    // Validate and add jobType filter
    if (jobType) {
      if (!isValidJobType(jobType as string)) {
        throw validationError(
          "Invalid jobType. Must be one of: stream-sync, event-sync, cleanup",
          {
            field: "jobType",
            providedValue: jobType,
          },
        );
      }
      filter.job_type = jobType as import("../jobs/types.js").JobType;
    }

    // Validate and add state filter
    if (state) {
      const validStates = [
        "PENDING",
        "RUNNING",
        "COMPLETED",
        "FAILED",
        "RETRYING",
        "CANCELLED",
      ];
      if (!validStates.includes(state as string)) {
        throw validationError(
          `Invalid state. Must be one of: ${validStates.join(", ")}`,
          {
            field: "state",
            providedValue: state,
          },
        );
      }
      filter.state = state as import("../jobs/types.js").JobState;
    }

    // Validate and add priority filter
    if (priority) {
      if (!isValidPriority(priority as string)) {
        throw validationError(
          "Invalid priority. Must be one of: high, normal, low",
          {
            field: "priority",
            providedValue: priority,
          },
        );
      }
      filter.priority = priority as import("../jobs/types.js").JobPriority;
    }

    // Validate and add date filters
    if (createdAfter) {
      const date = new Date(createdAfter as string);
      if (isNaN(date.getTime())) {
        throw validationError("createdAfter must be a valid ISO 8601 date", {
          field: "createdAfter",
        });
      }
      filter.created_after = date;
    }

    if (createdBefore) {
      const date = new Date(createdBefore as string);
      if (isNaN(date.getTime())) {
        throw validationError("createdBefore must be a valid ISO 8601 date", {
          field: "createdBefore",
        });
      }
      filter.created_before = date;
    }

    // Query jobs
    const result = jobManager.listJobs(filter, {
      limit: parsedLimit,
      offset: parsedOffset,
    });

    // Format jobs for response
    const jobs = result.jobs.map((job) => {
      const payload = JSON.parse(job.payload);
      const jobResult = job.result ? JSON.parse(job.result) : null;

      return {
        jobId: job.id,
        userId: job.user_id,
        jobType: job.job_type,
        priority: job.priority === 2 ? "high" : job.priority === 1 ? "normal" : "low",
        state: job.state,
        payload,
        result: jobResult,
        error: job.error_message
          ? {
              message: job.error_message,
              code: job.error_code,
            }
          : null,
        createdAt: job.created_at,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        progress: job.progress_percent,
        estimatedCompletionAt: job.estimated_completion_at,
      };
    });

    const response = {
      jobs,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: result.hasMore,
      requestId: correlationId,
    };

    info("Job list retrieved successfully", {
      userId: user.address,
      count: jobs.length,
      total: result.total,
      ...(correlationId && { correlationId }),
    });

    res.status(200).json(response);
  }),
);

/**
 * DELETE /api/jobs/{jobId}
 * Cancel a job
 *
 * Authorization: Only job owners or admins can cancel jobs
 *
 * Response 204 No Content
 */
jobsRouter.delete(
  "/:jobId",
  asyncHandler(async (req: Request, res: Response) => {
    const correlationId = req.correlationId;
    const user = req.user!; // requireAuth ensures user is present
    const { jobId } = req.params;

    info("Job cancellation request received", {
      jobId,
      userId: user.address!,
      ...(correlationId && { correlationId }),
    });

    // Validate jobId format (UUID)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(jobId)) {
      throw validationError("Invalid jobId format. Must be a valid UUID", {
        field: "jobId",
      });
    }

    try {
      // Get job
      const job = jobManager.getJobById(jobId);

      // Authorization check: users can only cancel their own jobs, admins can cancel all
      const isAdmin = user.role === "admin";
      const isOwner = job.user_id === user.address!;

      if (!isAdmin && !isOwner) {
        warn("Unauthorized job cancellation attempt", {
          jobId,
          userId: user.address!,
          jobOwnerId: job.user_id,
          ...(correlationId && { correlationId }),
        });

        throw new ApiError(
          ApiErrorCode.FORBIDDEN,
          "You do not have permission to cancel this job",
          403,
        );
      }

      // Cancel job
      jobManager.cancelJob(jobId, "Cancelled by user");

      info("Job cancelled successfully", {
        jobId,
        userId: user.address!,
        ...(correlationId && { correlationId }),
      });

      res.status(204).send();
    } catch (err) {
      // Handle JobNotFoundError
      if (err instanceof Error && err.name === "JobNotFoundError") {
        throw new ApiError(
          ApiErrorCode.NOT_FOUND,
          `Job not found: ${jobId}`,
          404,
        );
      }

      // Handle InvalidStateTransitionError
      if (err instanceof Error && err.name === "InvalidStateTransitionError") {
        throw new ApiError(
          ApiErrorCode.VALIDATION_ERROR,
          err.message,
          400,
        );
      }

      // Re-throw other errors
      throw err;
    }
  }),
);

/**
 * POST /api/jobs/{jobId}/retry
 * Manually retry a failed job
 *
 * Authorization: Only job owners or admins can retry jobs
 *
 * Request body (optional):
 * {
 *   "priority": "high",
 *   "payload": { ... }
 * }
 *
 * Response 202 Accepted:
 * {
 *   "jobId": "uuid",
 *   "state": "PENDING",
 *   "attempt": 2
 * }
 */
jobsRouter.post(
  "/:jobId/retry",
  asyncHandler(async (req: Request, res: Response) => {
    const correlationId = req.correlationId;
    const user = req.user!; // requireAuth ensures user is present
    const { jobId } = req.params;

    info("Job retry request received", {
      jobId,
      userId: user.address!,
      ...(correlationId && { correlationId }),
    });

    // Validate jobId format (UUID)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(jobId)) {
      throw validationError("Invalid jobId format. Must be a valid UUID", {
        field: "jobId",
      });
    }

    // Parse optional parameter overrides
    const { priority, payload } = req.body || {};

    // Validate priority if provided
    if (priority !== undefined && !isValidPriority(priority)) {
      throw validationError(
        "Invalid priority. Must be one of: high, normal, low",
        {
          field: "priority",
          providedValue: priority,
        },
      );
    }

    // Validate payload if provided
    if (payload !== undefined && typeof payload !== "object") {
      throw validationError("payload must be an object", {
        field: "payload",
      });
    }

    try {
      // Get job
      const job = jobManager.getJobById(jobId);

      // Authorization check: users can only retry their own jobs, admins can retry all
      const isAdmin = user.role === "admin";
      const isOwner = job.user_id === user.address!;

      if (!isAdmin && !isOwner) {
        warn("Unauthorized job retry attempt", {
          jobId,
          userId: user.address!,
          jobOwnerId: job.user_id,
          ...(correlationId && { correlationId }),
        });

        throw new ApiError(
          ApiErrorCode.FORBIDDEN,
          "You do not have permission to retry this job",
          403,
        );
      }

      // Build parameter override
      const parameterOverride: {
        priority?: import("../jobs/types.js").JobPriority;
        payload?: Record<string, unknown>;
      } = {};

      if (priority !== undefined) {
        parameterOverride.priority = priority;
      }

      if (payload !== undefined) {
        parameterOverride.payload = payload;
      }

      // Retry job
      const updatedJob = jobManager.retryJob(
        jobId,
        Object.keys(parameterOverride).length > 0
          ? parameterOverride
          : undefined,
      );

      info("Job retry successful", {
        jobId,
        userId: user.address,
        newState: updatedJob.state,
        attempt: updatedJob.attempt,
        ...(correlationId && { correlationId }),
      });

      res.status(202).json({
        jobId: updatedJob.id,
        state: updatedJob.state,
        attempt: updatedJob.attempt,
        requestId: correlationId,
      });
    } catch (err) {
      // Handle JobNotFoundError
      if (err instanceof Error && err.name === "JobNotFoundError") {
        throw new ApiError(
          ApiErrorCode.NOT_FOUND,
          `Job not found: ${jobId}`,
          404,
        );
      }

      // Handle InvalidStateTransitionError
      if (err instanceof Error && err.name === "InvalidStateTransitionError") {
        throw new ApiError(
          ApiErrorCode.VALIDATION_ERROR,
          err.message,
          400,
        );
      }

      // Re-throw other errors
      throw err;
    }
  }),
);
