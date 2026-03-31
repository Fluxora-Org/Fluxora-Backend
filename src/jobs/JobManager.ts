/**
 * Job Manager - Core job lifecycle and state management
 *
 * Manages job creation, state transitions, and history tracking with
 * validation against the job state machine. Ensures data consistency
 * and durability through database transactions.
 *
 * @module jobs/JobManager
 */

import { getDatabase } from "../db/connection.js";
import { randomUUID } from "crypto";
import {
  type JobRecord,
  type JobHistoryRecord,
  type CreateJobInput,
  type UpdateJobStateInput,
  type JobState,
  JOB_STATE_TRANSITIONS,
  PRIORITY_VALUES,
  DEFAULT_JOB_CONFIGS,
  JOB_INVARIANTS,
} from "./types.js";

/**
 * Error thrown when an invalid state transition is attempted
 */
export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly currentState: JobState,
    public readonly targetState: JobState,
  ) {
    super(
      `Invalid state transition from ${currentState} to ${targetState}. Valid transitions: ${JOB_STATE_TRANSITIONS[currentState].join(", ")}`,
    );
    this.name = "InvalidStateTransitionError";
  }
}

/**
 * Error thrown when a job is not found
 */
export class JobNotFoundError extends Error {
  constructor(public readonly jobId: string) {
    super(`Job not found: ${jobId}`);
    this.name = "JobNotFoundError";
  }
}

/**
 * Error thrown when job validation fails
 */
export class JobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobValidationError";
  }
}

/**
 * JobManager handles job lifecycle operations with state machine validation
 */
export class JobManager {
  /**
   * Validate state transition according to the job state machine
   */
  private validateStateTransition(
    currentState: JobState,
    targetState: JobState,
  ): void {
    const validTransitions = JOB_STATE_TRANSITIONS[currentState];

    if (!validTransitions.includes(targetState)) {
      throw new InvalidStateTransitionError(currentState, targetState);
    }
  }

  /**
   * Validate job creation input
   */
  private validateCreateInput(input: CreateJobInput): void {
    // Validate job type
    if (!DEFAULT_JOB_CONFIGS[input.job_type]) {
      throw new JobValidationError(`Invalid job type: ${input.job_type}`);
    }

    // Validate priority
    if (PRIORITY_VALUES[input.priority] === undefined) {
      throw new JobValidationError(`Invalid priority: ${input.priority}`);
    }

    // Validate payload size
    const payloadSize = JSON.stringify(input.payload).length;
    if (payloadSize > JOB_INVARIANTS.maxPayloadSize) {
      throw new JobValidationError(
        `Payload size ${payloadSize} exceeds maximum ${JOB_INVARIANTS.maxPayloadSize}`,
      );
    }

    // Validate scheduled_for if provided
    if (input.scheduled_for) {
      const scheduledTime = input.scheduled_for.getTime();
      const now = Date.now();
      if (scheduledTime < now) {
        throw new JobValidationError(
          "scheduled_for must be in the future",
        );
      }
    }
  }

  /**
   * Create a new job and persist to database
   *
   * @param input - Job creation parameters
   * @returns Created job record
   * @throws JobValidationError if input validation fails
   */
  createJob(input: CreateJobInput): JobRecord {
    // Validate input
    this.validateCreateInput(input);

    const db = getDatabase();
    const jobId = randomUUID();
    const now = new Date().toISOString();
    const config = DEFAULT_JOB_CONFIGS[input.job_type];
    const priorityValue = PRIORITY_VALUES[input.priority];

    // Check for duplicate idempotency key
    if (input.idempotency_key) {
      const existing = db
        .prepare(
          `SELECT id, state, created_at FROM jobs 
           WHERE idempotency_key = ? 
           AND created_at > datetime('now', '-24 hours')`,
        )
        .get(input.idempotency_key) as
        | Pick<JobRecord, "id" | "state" | "created_at">
        | undefined;

      if (existing) {
        // Return existing job (idempotent)
        return this.getJobById(existing.id);
      }
    }

    // Use transaction for atomicity
    const transaction = db.transaction(() => {
      // Insert job record
      db.prepare(
        `INSERT INTO jobs (
          id, user_id, job_type, priority, state, payload,
          created_at, scheduled_for, attempt, max_attempts,
          idempotency_key, correlation_id, progress_percent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        jobId,
        input.user_id,
        input.job_type,
        priorityValue,
        "PENDING",
        JSON.stringify(input.payload),
        now,
        input.scheduled_for?.toISOString() || null,
        0,
        config.maxRetries,
        input.idempotency_key || null,
        input.correlation_id || null,
        0,
      );

      // Record initial state in history
      this.recordStateTransition(jobId, null, "PENDING", "Job created");
    });

    transaction();

    return this.getJobById(jobId);
  }

  /**
   * Get job by ID
   *
   * @param jobId - Job identifier
   * @returns Job record
   * @throws JobNotFoundError if job doesn't exist
   */
  getJobById(jobId: string): JobRecord {
    const db = getDatabase();

    const job = db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(jobId) as JobRecord | undefined;

    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    return job;
  }

  /**
   * Update job state with validation and history tracking
   *
   * @param jobId - Job identifier
   * @param input - State update parameters
   * @param transitionReason - Reason for state transition
   * @returns Updated job record
   * @throws JobNotFoundError if job doesn't exist
   * @throws InvalidStateTransitionError if transition is invalid
   */
  updateJobState(
    jobId: string,
    input: UpdateJobStateInput,
    transitionReason?: string,
  ): JobRecord {
    const db = getDatabase();

    // Get current job state
    const currentJob = this.getJobById(jobId);

    // Validate state transition if state is being updated
    if (input.state) {
      this.validateStateTransition(currentJob.state, input.state);
    }

    const now = new Date().toISOString();

    // Build update query dynamically based on provided fields
    const updates: string[] = [];
    const values: unknown[] = [];

    if (input.state) {
      updates.push("state = ?");
      values.push(input.state);

      // Set timestamps based on state
      if (input.state === "RUNNING" && !currentJob.started_at) {
        updates.push("started_at = ?");
        values.push(now);
      }

      if (
        (input.state === "COMPLETED" ||
          input.state === "FAILED" ||
          input.state === "CANCELLED") &&
        !currentJob.completed_at
      ) {
        updates.push("completed_at = ?");
        values.push(now);
      }
    }

    if (input.error_message !== undefined) {
      updates.push("error_message = ?");
      values.push(input.error_message);
    }

    if (input.error_code !== undefined) {
      updates.push("error_code = ?");
      values.push(input.error_code);
    }

    if (input.result !== undefined) {
      updates.push("result = ?");
      values.push(JSON.stringify(input.result));
    }

    if (input.worker_id !== undefined) {
      updates.push("worker_id = ?");
      values.push(input.worker_id);
    }

    if (input.progress_percent !== undefined) {
      // Validate progress range
      if (
        input.progress_percent < JOB_INVARIANTS.progressConstraints.min ||
        input.progress_percent > JOB_INVARIANTS.progressConstraints.max
      ) {
        throw new JobValidationError(
          `Progress must be between ${JOB_INVARIANTS.progressConstraints.min} and ${JOB_INVARIANTS.progressConstraints.max}`,
        );
      }
      updates.push("progress_percent = ?");
      values.push(input.progress_percent);
    }

    if (input.estimated_completion_at !== undefined) {
      updates.push("estimated_completion_at = ?");
      values.push(input.estimated_completion_at.toISOString());
    }

    // Use transaction for atomicity
    const transaction = db.transaction(() => {
      // Update job record
      if (updates.length > 0) {
        const query = `UPDATE jobs SET ${updates.join(", ")} WHERE id = ?`;
        db.prepare(query).run(...values, jobId);
      }

      // Record state transition in history if state changed
      if (input.state) {
        this.recordStateTransition(
          jobId,
          currentJob.state,
          input.state,
          transitionReason || null,
        );
      }
    });

    transaction();

    return this.getJobById(jobId);
  }

  /**
   * Record state transition in job history
   *
   * @param jobId - Job identifier
   * @param oldState - Previous state (null for initial creation)
   * @param newState - New state
   * @param reason - Reason for transition
   */
  private recordStateTransition(
    jobId: string,
    oldState: JobState | null,
    newState: JobState,
    reason: string | null,
  ): void {
    const db = getDatabase();
    const historyId = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO job_history (
        id, job_id, old_state, new_state, transition_reason, transitioned_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(historyId, jobId, oldState, newState, reason, now);
  }

  /**
   * Get job history
   *
   * @param jobId - Job identifier
   * @returns Array of history records ordered by transition time
   * @throws JobNotFoundError if job doesn't exist
   */
  getJobHistory(jobId: string): JobHistoryRecord[] {
    // Verify job exists
    this.getJobById(jobId);

    const db = getDatabase();

    const history = db
      .prepare(
        `SELECT * FROM job_history 
         WHERE job_id = ? 
         ORDER BY transitioned_at ASC`,
      )
      .all(jobId) as JobHistoryRecord[];

    return history;
  }

  /**
   * Increment job attempt counter
   *
   * @param jobId - Job identifier
   * @returns Updated job record
   * @throws JobNotFoundError if job doesn't exist
   */
  incrementAttempt(jobId: string): JobRecord {
    const db = getDatabase();
    const currentJob = this.getJobById(jobId);

    const newAttempt = currentJob.attempt + 1;

    // Validate attempt doesn't exceed max
    if (newAttempt > currentJob.max_attempts) {
      throw new JobValidationError(
        `Attempt ${newAttempt} exceeds max attempts ${currentJob.max_attempts}`,
      );
    }

    db.prepare("UPDATE jobs SET attempt = ? WHERE id = ?").run(
      newAttempt,
      jobId,
    );

    return this.getJobById(jobId);
  }

  /**
   * Set next retry time for a job
   *
   * @param jobId - Job identifier
   * @param nextRetryAt - When to retry the job
   * @returns Updated job record
   * @throws JobNotFoundError if job doesn't exist
   */
  setNextRetry(jobId: string, nextRetryAt: Date): JobRecord {
    const db = getDatabase();

    db.prepare("UPDATE jobs SET next_retry_at = ? WHERE id = ?").run(
      nextRetryAt.toISOString(),
      jobId,
    );

    return this.getJobById(jobId);
  }

  /**
   * List jobs with filtering and pagination
   *
   * @param filter - Filter criteria
   * @param pagination - Pagination options
   * @returns Paginated job results
   */
  listJobs(
    filter: import("./types.js").JobFilter,
    pagination: import("./types.js").PaginationOptions,
  ): import("./types.js").PaginatedJobs {
    const db = getDatabase();

    // Build WHERE clause dynamically
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.user_id) {
      conditions.push("user_id = ?");
      params.push(filter.user_id);
    }

    if (filter.job_type) {
      conditions.push("job_type = ?");
      params.push(filter.job_type);
    }

    if (filter.state) {
      conditions.push("state = ?");
      params.push(filter.state);
    }

    if (filter.priority !== undefined) {
      const priorityValue = PRIORITY_VALUES[filter.priority];
      conditions.push("priority = ?");
      params.push(priorityValue);
    }

    if (filter.created_after) {
      conditions.push("created_at >= ?");
      params.push(filter.created_after.toISOString());
    }

    if (filter.created_before) {
      conditions.push("created_at <= ?");
      params.push(filter.created_before.toISOString());
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM jobs ${whereClause}`;
    const countResult = db.prepare(countQuery).get(...params) as {
      count: number;
    };
    const total = countResult.count;

    // Get paginated jobs
    const jobsQuery = `
      SELECT * FROM jobs 
      ${whereClause}
      ORDER BY priority DESC, created_at DESC
      LIMIT ? OFFSET ?
    `;
    const jobs = db
      .prepare(jobsQuery)
      .all(...params, pagination.limit, pagination.offset) as JobRecord[];

    return {
      jobs,
      total,
      limit: pagination.limit,
      offset: pagination.offset,
      hasMore: pagination.offset + jobs.length < total,
    };
  }

  /**
   * Cancel a job
   *
   * @param jobId - Job identifier
   * @param reason - Reason for cancellation
   * @returns Updated job record
   * @throws JobNotFoundError if job doesn't exist
   * @throws InvalidStateTransitionError if job cannot be cancelled
   */
  cancelJob(jobId: string, reason?: string): JobRecord {
    const currentJob = this.getJobById(jobId);

    // Validate that job can be cancelled (PENDING or RUNNING)
    if (currentJob.state !== "PENDING" && currentJob.state !== "RUNNING") {
      throw new InvalidStateTransitionError(currentJob.state, "CANCELLED");
    }

    // Update job state to CANCELLED
    return this.updateJobState(
      jobId,
      { state: "CANCELLED" },
      reason || "Job cancelled by user",
    );
  }

  /**
   * Retry a failed job
   *
   * @param jobId - Job identifier
   * @param parameterOverride - Optional parameter overrides (priority, payload)
   * @returns Updated job record
   * @throws JobNotFoundError if job doesn't exist
   * @throws InvalidStateTransitionError if job is not in FAILED state
   */
  retryJob(
    jobId: string,
    parameterOverride?: {
      priority?: import("./types.js").JobPriority;
      payload?: Record<string, unknown>;
    },
  ): JobRecord {
    const db = getDatabase();
    const currentJob = this.getJobById(jobId);

    // Validate that job is in FAILED state
    if (currentJob.state !== "FAILED") {
      throw new InvalidStateTransitionError(currentJob.state, "RETRYING");
    }

    // Use transaction for atomicity
    const transaction = db.transaction(() => {
      // Apply parameter overrides if provided
      if (parameterOverride) {
        const updates: string[] = [];
        const values: unknown[] = [];

        if (parameterOverride.priority !== undefined) {
          const priorityValue = PRIORITY_VALUES[parameterOverride.priority];
          updates.push("priority = ?");
          values.push(priorityValue);
        }

        if (parameterOverride.payload !== undefined) {
          updates.push("payload = ?");
          values.push(JSON.stringify(parameterOverride.payload));
        }

        if (updates.length > 0) {
          const query = `UPDATE jobs SET ${updates.join(", ")} WHERE id = ?`;
          db.prepare(query).run(...values, jobId);
        }
      }

      // Transition to RETRYING state
      this.updateJobState(
        jobId,
        { state: "RETRYING" },
        "Manual retry requested",
      );

      // Transition to PENDING state
      this.updateJobState(
        jobId,
        { state: "PENDING", error_message: null, error_code: null },
        "Job queued for retry",
      );
    });

    transaction();

    return this.getJobById(jobId);
  }
}
