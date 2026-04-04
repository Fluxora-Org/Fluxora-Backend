/**
 * Tests for JobManager - job lifecycle and state management
 *
 * Validates job creation, state transitions, history tracking, and error handling
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import {
  JobManager,
  InvalidStateTransitionError,
  JobNotFoundError,
  JobValidationError,
} from "../src/jobs/JobManager.js";
import type { CreateJobInput, JobState } from "../src/jobs/types.js";
import * as dbConnection from "../src/db/connection.js";

// Test database
let testDb: Database.Database;

beforeAll(async () => {
  // Create in-memory database for testing
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");

  // Run only the jobs migration directly (skip streams migration)
  const { up } = await import("../src/db/migrations/002_create_jobs_tables.js");
  testDb.exec(up);

  // Mock getDatabase to return test database
  vi.spyOn(dbConnection, "getDatabase").mockReturnValue(testDb);
});

afterAll(() => {
  // Restore mocks
  vi.restoreAllMocks();

  // Close test database
  if (testDb) {
    testDb.close();
  }
});

describe("JobManager - Job Creation", () => {
  it("should create a job with valid input", () => {
    const manager = new JobManager();
    const userId = randomUUID();

    const input: CreateJobInput = {
      user_id: userId,
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    };

    const job = manager.createJob(input);

    expect(job.id).toBeDefined();
    expect(job.user_id).toBe(userId);
    expect(job.job_type).toBe("stream-sync");
    expect(job.priority).toBe(1); // normal = 1
    expect(job.state).toBe("PENDING");
    expect(job.payload).toBe(JSON.stringify(input.payload));
    expect(job.attempt).toBe(0);
    expect(job.max_attempts).toBe(3); // from config
    expect(job.progress_percent).toBe(0);
    expect(job.created_at).toBeDefined();
  });

  it("should create a job with high priority", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "event-sync",
      priority: "high",
      payload: { eventId: "test-event" },
    };

    const job = manager.createJob(input);

    expect(job.priority).toBe(2); // high = 2
  });

  it("should create a job with low priority", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "cleanup",
      priority: "low",
      payload: { cleanupType: "old-jobs" },
    };

    const job = manager.createJob(input);

    expect(job.priority).toBe(0); // low = 0
  });

  it("should create a job with idempotency key", () => {
    const manager = new JobManager();
    const idempotencyKey = randomUUID();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
      idempotency_key: idempotencyKey,
    };

    const job = manager.createJob(input);

    expect(job.idempotency_key).toBe(idempotencyKey);
  });

  it("should return existing job for duplicate idempotency key", () => {
    const manager = new JobManager();
    const idempotencyKey = randomUUID();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
      idempotency_key: idempotencyKey,
    };

    const job1 = manager.createJob(input);
    const job2 = manager.createJob(input);

    expect(job1.id).toBe(job2.id);
  });

  it("should create a job with correlation ID", () => {
    const manager = new JobManager();
    const correlationId = randomUUID();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
      correlation_id: correlationId,
    };

    const job = manager.createJob(input);

    expect(job.correlation_id).toBe(correlationId);
  });

  it("should create a job with scheduled_for", () => {
    const manager = new JobManager();
    const scheduledFor = new Date(Date.now() + 3600000); // 1 hour from now

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
      scheduled_for: scheduledFor,
    };

    const job = manager.createJob(input);

    expect(job.scheduled_for).toBe(scheduledFor.toISOString());
  });

  it("should throw error for invalid job type", () => {
    const manager = new JobManager();

    const input = {
      user_id: randomUUID(),
      job_type: "invalid-type" as any,
      priority: "normal" as const,
      payload: {},
    };

    expect(() => manager.createJob(input)).toThrow(JobValidationError);
    expect(() => manager.createJob(input)).toThrow("Invalid job type");
  });

  it("should throw error for invalid priority", () => {
    const manager = new JobManager();

    const input = {
      user_id: randomUUID(),
      job_type: "stream-sync" as const,
      priority: "invalid-priority" as any,
      payload: {},
    };

    expect(() => manager.createJob(input)).toThrow(JobValidationError);
    expect(() => manager.createJob(input)).toThrow("Invalid priority");
  });

  it("should throw error for payload exceeding max size", () => {
    const manager = new JobManager();

    // Create payload larger than 1MB
    const largePayload = { data: "x".repeat(2 * 1024 * 1024) };

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: largePayload,
    };

    expect(() => manager.createJob(input)).toThrow(JobValidationError);
    expect(() => manager.createJob(input)).toThrow("exceeds maximum");
  });

  it("should throw error for scheduled_for in the past", () => {
    const manager = new JobManager();
    const pastDate = new Date(Date.now() - 3600000); // 1 hour ago

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
      scheduled_for: pastDate,
    };

    expect(() => manager.createJob(input)).toThrow(JobValidationError);
    expect(() => manager.createJob(input)).toThrow("must be in the future");
  });

  it("should record initial state in history", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    const history = manager.getJobHistory(job.id);

    expect(history).toHaveLength(1);
    expect(history[0].job_id).toBe(job.id);
    expect(history[0].old_state).toBeNull();
    expect(history[0].new_state).toBe("PENDING");
    expect(history[0].transition_reason).toBe("Job created");
  });
});

describe("JobManager - Get Job", () => {
  it("should get job by ID", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    };

    const createdJob = manager.createJob(input);
    const retrievedJob = manager.getJobById(createdJob.id);

    expect(retrievedJob.id).toBe(createdJob.id);
    expect(retrievedJob.user_id).toBe(createdJob.user_id);
    expect(retrievedJob.state).toBe(createdJob.state);
  });

  it("should throw error for non-existent job", () => {
    const manager = new JobManager();
    const nonExistentId = randomUUID();

    expect(() => manager.getJobById(nonExistentId)).toThrow(JobNotFoundError);
    expect(() => manager.getJobById(nonExistentId)).toThrow(
      `Job not found: ${nonExistentId}`,
    );
  });
});

describe("JobManager - State Transitions", () => {
  it("should transition from PENDING to RUNNING", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    const updatedJob = manager.updateJobState(
      job.id,
      { state: "RUNNING" },
      "Worker picked up job",
    );

    expect(updatedJob.state).toBe("RUNNING");
    expect(updatedJob.started_at).toBeDefined();
  });

  it("should transition from RUNNING to COMPLETED", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    manager.updateJobState(job.id, { state: "RUNNING" });
    const completedJob = manager.updateJobState(
      job.id,
      { state: "COMPLETED", result: { success: true } },
      "Job completed successfully",
    );

    expect(completedJob.state).toBe("COMPLETED");
    expect(completedJob.completed_at).toBeDefined();
    expect(completedJob.result).toBe(JSON.stringify({ success: true }));
  });

  it("should transition from RUNNING to FAILED", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    manager.updateJobState(job.id, { state: "RUNNING" });
    const failedJob = manager.updateJobState(
      job.id,
      {
        state: "FAILED",
        error_message: "Connection timeout",
        error_code: "TIMEOUT",
      },
      "Job failed",
    );

    expect(failedJob.state).toBe("FAILED");
    expect(failedJob.completed_at).toBeDefined();
    expect(failedJob.error_message).toBe("Connection timeout");
    expect(failedJob.error_code).toBe("TIMEOUT");
  });

  it("should transition from RUNNING to RETRYING", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    manager.updateJobState(job.id, { state: "RUNNING" });
    const retryingJob = manager.updateJobState(
      job.id,
      { state: "RETRYING" },
      "Transient error, will retry",
    );

    expect(retryingJob.state).toBe("RETRYING");
  });

  it("should transition from RETRYING to PENDING", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    manager.updateJobState(job.id, { state: "RUNNING" });
    manager.updateJobState(job.id, { state: "RETRYING" });
    const pendingJob = manager.updateJobState(
      job.id,
      { state: "PENDING" },
      "Ready for retry",
    );

    expect(pendingJob.state).toBe("PENDING");
  });

  it("should transition from PENDING to CANCELLED", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    const cancelledJob = manager.updateJobState(
      job.id,
      { state: "CANCELLED" },
      "User cancelled job",
    );

    expect(cancelledJob.state).toBe("CANCELLED");
    expect(cancelledJob.completed_at).toBeDefined();
  });

  it("should transition from FAILED to RETRYING", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    manager.updateJobState(job.id, { state: "RUNNING" });
    manager.updateJobState(job.id, { state: "FAILED" });
    const retryingJob = manager.updateJobState(
      job.id,
      { state: "RETRYING" },
      "Manual retry",
    );

    expect(retryingJob.state).toBe("RETRYING");
  });

  it("should throw error for invalid transition from PENDING to COMPLETED", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);

    expect(() =>
      manager.updateJobState(job.id, { state: "COMPLETED" }),
    ).toThrow(InvalidStateTransitionError);
  });

  it("should throw error for invalid transition from COMPLETED to RUNNING", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    manager.updateJobState(job.id, { state: "RUNNING" });
    manager.updateJobState(job.id, { state: "COMPLETED" });

    expect(() => manager.updateJobState(job.id, { state: "RUNNING" })).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("should throw error for invalid transition from CANCELLED to PENDING", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    manager.updateJobState(job.id, { state: "CANCELLED" });

    expect(() => manager.updateJobState(job.id, { state: "PENDING" })).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("should record state transitions in history", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    manager.updateJobState(job.id, { state: "RUNNING" }, "Worker started");
    manager.updateJobState(
      job.id,
      { state: "COMPLETED" },
      "Job finished successfully",
    );

    const history = manager.getJobHistory(job.id);

    expect(history).toHaveLength(3);
    expect(history[0].old_state).toBeNull();
    expect(history[0].new_state).toBe("PENDING");
    expect(history[1].old_state).toBe("PENDING");
    expect(history[1].new_state).toBe("RUNNING");
    expect(history[1].transition_reason).toBe("Worker started");
    expect(history[2].old_state).toBe("RUNNING");
    expect(history[2].new_state).toBe("COMPLETED");
    expect(history[2].transition_reason).toBe("Job finished successfully");
  });
});

describe("JobManager - Job Updates", () => {
  it("should update worker_id", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    const workerId = "worker-123";
    const updatedJob = manager.updateJobState(
      job.id,
      { state: "RUNNING", worker_id: workerId },
      "Worker assigned",
    );

    expect(updatedJob.worker_id).toBe(workerId);
  });

  it("should update progress_percent", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    manager.updateJobState(job.id, { state: "RUNNING" });
    const updatedJob = manager.updateJobState(job.id, {
      progress_percent: 50,
    });

    expect(updatedJob.progress_percent).toBe(50);
  });

  it("should throw error for invalid progress_percent (negative)", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);

    expect(() =>
      manager.updateJobState(job.id, { progress_percent: -1 }),
    ).toThrow(JobValidationError);
  });

  it("should throw error for invalid progress_percent (over 100)", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);

    expect(() =>
      manager.updateJobState(job.id, { progress_percent: 101 }),
    ).toThrow(JobValidationError);
  });

  it("should update estimated_completion_at", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    const estimatedTime = new Date(Date.now() + 300000); // 5 minutes from now
    const updatedJob = manager.updateJobState(job.id, {
      estimated_completion_at: estimatedTime,
    });

    expect(updatedJob.estimated_completion_at).toBe(
      estimatedTime.toISOString(),
    );
  });

  it("should update multiple fields at once", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    const workerId = "worker-456";
    const estimatedTime = new Date(Date.now() + 300000);

    const updatedJob = manager.updateJobState(
      job.id,
      {
        state: "RUNNING",
        worker_id: workerId,
        progress_percent: 25,
        estimated_completion_at: estimatedTime,
      },
      "Job started with progress tracking",
    );

    expect(updatedJob.state).toBe("RUNNING");
    expect(updatedJob.worker_id).toBe(workerId);
    expect(updatedJob.progress_percent).toBe(25);
    expect(updatedJob.estimated_completion_at).toBe(
      estimatedTime.toISOString(),
    );
  });
});

describe("JobManager - Job History", () => {
  it("should get job history", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    const history = manager.getJobHistory(job.id);

    expect(history).toHaveLength(1);
    expect(history[0].job_id).toBe(job.id);
  });

  it("should return history in chronological order", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    manager.updateJobState(job.id, { state: "RUNNING" });
    manager.updateJobState(job.id, { state: "COMPLETED" });

    const history = manager.getJobHistory(job.id);

    expect(history).toHaveLength(3);
    expect(history[0].new_state).toBe("PENDING");
    expect(history[1].new_state).toBe("RUNNING");
    expect(history[2].new_state).toBe("COMPLETED");

    // Verify chronological order
    const time1 = new Date(history[0].transitioned_at).getTime();
    const time2 = new Date(history[1].transitioned_at).getTime();
    const time3 = new Date(history[2].transitioned_at).getTime();

    expect(time1).toBeLessThanOrEqual(time2);
    expect(time2).toBeLessThanOrEqual(time3);
  });

  it("should throw error for history of non-existent job", () => {
    const manager = new JobManager();
    const nonExistentId = randomUUID();

    expect(() => manager.getJobHistory(nonExistentId)).toThrow(
      JobNotFoundError,
    );
  });
});

describe("JobManager - Attempt Management", () => {
  it("should increment job attempt", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    expect(job.attempt).toBe(0);

    const updatedJob = manager.incrementAttempt(job.id);
    expect(updatedJob.attempt).toBe(1);
  });

  it("should increment attempt multiple times", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);

    manager.incrementAttempt(job.id);
    manager.incrementAttempt(job.id);
    const updatedJob = manager.incrementAttempt(job.id);

    expect(updatedJob.attempt).toBe(3);
  });

  it("should throw error when exceeding max attempts", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    expect(job.max_attempts).toBe(3);

    manager.incrementAttempt(job.id);
    manager.incrementAttempt(job.id);
    manager.incrementAttempt(job.id);

    expect(() => manager.incrementAttempt(job.id)).toThrow(JobValidationError);
    expect(() => manager.incrementAttempt(job.id)).toThrow("exceeds max");
  });

  it("should throw error for incrementing non-existent job", () => {
    const manager = new JobManager();
    const nonExistentId = randomUUID();

    expect(() => manager.incrementAttempt(nonExistentId)).toThrow(
      JobNotFoundError,
    );
  });
});

describe("JobManager - Retry Management", () => {
  it("should set next retry time", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    const nextRetryTime = new Date(Date.now() + 60000); // 1 minute from now

    const updatedJob = manager.setNextRetry(job.id, nextRetryTime);

    expect(updatedJob.next_retry_at).toBe(nextRetryTime.toISOString());
  });

  it("should update next retry time", () => {
    const manager = new JobManager();

    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: {},
    };

    const job = manager.createJob(input);
    const firstRetry = new Date(Date.now() + 60000);
    const secondRetry = new Date(Date.now() + 120000);

    manager.setNextRetry(job.id, firstRetry);
    const updatedJob = manager.setNextRetry(job.id, secondRetry);

    expect(updatedJob.next_retry_at).toBe(secondRetry.toISOString());
  });

  it("should throw error for setting retry on non-existent job", () => {
    const manager = new JobManager();
    const nonExistentId = randomUUID();
    const nextRetryTime = new Date(Date.now() + 60000);

    expect(() => manager.setNextRetry(nonExistentId, nextRetryTime)).toThrow(
      JobNotFoundError,
    );
  });
});
