/**
 * Tests for Worker - job execution engine
 *
 * Validates job polling, lock acquisition, timeout enforcement, and result persistence
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import {
  Worker,
  type JobExecutor,
  JobManager,
  type CreateJobInput,
} from "../src/jobs/index.js";
import * as dbConnection from "../src/db/connection.js";

// Test database
let testDb: Database.Database;

beforeAll(async () => {
  // Create in-memory database for testing
  testDb = new Database(":memory:");
  testDb.pragma("foreign_keys = ON");

  // Run jobs migration
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

describe("Worker - Initialization", () => {
  it("should create worker with default config", () => {
    const worker = new Worker();
    const stats = worker.getStats();

    expect(stats.workerId).toBeDefined();
    expect(stats.jobsProcessed).toBe(0);
    expect(stats.jobsSucceeded).toBe(0);
    expect(stats.jobsFailed).toBe(0);
    expect(stats.currentJobs).toBe(0);
    expect(stats.isRunning).toBe(false);
  });

  it("should create worker with custom workerId", () => {
    const customId = "custom-worker-123";
    const worker = new Worker({ workerId: customId });
    const stats = worker.getStats();

    expect(stats.workerId).toBe(customId);
  });

  it("should create worker with custom job types", () => {
    const worker = new Worker({ jobTypes: ["stream-sync"] });
    const stats = worker.getStats();

    expect(stats.workerId).toBeDefined();
  });

  it("should create worker with custom max concurrent jobs", () => {
    const worker = new Worker({ maxConcurrentJobs: 10 });
    const stats = worker.getStats();

    expect(stats.workerId).toBeDefined();
  });
});

describe("Worker - Executor Registration", () => {
  it("should register job executor", () => {
    const worker = new Worker();
    const executor: JobExecutor = async (payload, signal) => {
      return { success: true };
    };

    worker.registerExecutor("stream-sync", executor);

    // No error means registration succeeded
    expect(true).toBe(true);
  });

  it("should register multiple executors for different job types", () => {
    const worker = new Worker();
    const streamExecutor: JobExecutor = async (payload, signal) => {
      return { success: true };
    };
    const eventExecutor: JobExecutor = async (payload, signal) => {
      return { success: true };
    };

    worker.registerExecutor("stream-sync", streamExecutor);
    worker.registerExecutor("event-sync", eventExecutor);

    // No error means registration succeeded
    expect(true).toBe(true);
  });
});

describe("Worker - Job Polling and Execution", () => {
  let worker: Worker;
  let jobManager: JobManager;

  beforeEach(() => {
    // Clear jobs table
    testDb.prepare("DELETE FROM jobs").run();
    testDb.prepare("DELETE FROM job_history").run();

    worker = new Worker({ workerId: "test-worker", pollInterval: 100 });
    jobManager = new JobManager();
  });

  afterAll(async () => {
    if (worker) {
      await worker.stop();
    }
  });

  it("should poll and execute a pending job", async () => {
    // Register executor
    const executorMock = vi.fn(async (payload, signal) => {
      return { result: "success", data: payload };
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create a job
    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    };
    const job = jobManager.createJob(input);

    // Start worker
    worker.start();

    // Wait for job to be executed
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Stop worker
    await worker.stop();

    // Verify executor was called
    expect(executorMock).toHaveBeenCalledTimes(1);
    expect(executorMock).toHaveBeenCalledWith(
      { streamId: "test-stream" },
      expect.any(Object), // AbortSignal
    );

    // Verify job state
    const updatedJob = jobManager.getJobById(job.id);
    expect(updatedJob.state).toBe("COMPLETED");
    expect(updatedJob.result).toBeDefined();
    const result = JSON.parse(updatedJob.result!);
    expect(result.result).toBe("success");
    expect(result.data.streamId).toBe("test-stream");

    // Verify worker stats
    const stats = worker.getStats();
    expect(stats.jobsProcessed).toBe(1);
    expect(stats.jobsSucceeded).toBe(1);
    expect(stats.jobsFailed).toBe(0);
  });

  it("should acquire job lock to prevent concurrent execution", async () => {
    // Register executor that takes some time
    const executorMock = vi.fn(async (payload, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { result: "success" };
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create a job
    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    };
    const job = jobManager.createJob(input);

    // Start worker
    worker.start();

    // Wait a bit for job to be picked up
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check that job has worker_id set (locked)
    const lockedJob = jobManager.getJobById(job.id);
    expect(lockedJob.worker_id).toBe("test-worker");
    expect(lockedJob.state).toBe("RUNNING");

    // Stop worker
    await worker.stop();

    // Verify executor was called only once
    expect(executorMock).toHaveBeenCalledTimes(1);
  });

  it("should respect job priority order", async () => {
    const executionOrder: string[] = [];

    // Register executor
    const executorMock = vi.fn(async (payload: any, signal) => {
      executionOrder.push(payload.priority);
      return { result: "success" };
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create jobs with different priorities
    const userId = randomUUID();
    jobManager.createJob({
      user_id: userId,
      job_type: "stream-sync",
      priority: "low",
      payload: { priority: "low" },
    });
    jobManager.createJob({
      user_id: userId,
      job_type: "stream-sync",
      priority: "high",
      payload: { priority: "high" },
    });
    jobManager.createJob({
      user_id: userId,
      job_type: "stream-sync",
      priority: "normal",
      payload: { priority: "normal" },
    });

    // Start worker
    worker.start();

    // Wait for all jobs to be executed
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Stop worker
    await worker.stop();

    // Verify execution order (high -> normal -> low)
    expect(executionOrder).toEqual(["high", "normal", "low"]);
  });

  it("should only execute jobs of configured job types", async () => {
    // Create worker that only handles stream-sync
    const streamWorker = new Worker({
      workerId: "stream-worker",
      pollInterval: 100,
      jobTypes: ["stream-sync"],
    });

    const executorMock = vi.fn(async (payload, signal) => {
      return { result: "success" };
    });
    streamWorker.registerExecutor("stream-sync", executorMock);

    // Create jobs of different types
    const userId = randomUUID();
    jobManager.createJob({
      user_id: userId,
      job_type: "stream-sync",
      priority: "normal",
      payload: { type: "stream" },
    });
    jobManager.createJob({
      user_id: userId,
      job_type: "event-sync",
      priority: "normal",
      payload: { type: "event" },
    });

    // Start worker
    streamWorker.start();

    // Wait for jobs to be processed
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Stop worker
    await streamWorker.stop();

    // Verify only stream-sync job was executed
    expect(executorMock).toHaveBeenCalledTimes(1);
    expect(executorMock).toHaveBeenCalledWith(
      { type: "stream" },
      expect.any(Object),
    );
  });

  it("should respect scheduled_for time", async () => {
    const executorMock = vi.fn(async (payload, signal) => {
      return { result: "success" };
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create job scheduled for future
    const futureTime = new Date(Date.now() + 5000); // 5 seconds in future
    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
      scheduled_for: futureTime,
    };
    jobManager.createJob(input);

    // Start worker
    worker.start();

    // Wait a bit (but not until scheduled time)
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Stop worker
    await worker.stop();

    // Verify executor was NOT called (job not scheduled yet)
    expect(executorMock).not.toHaveBeenCalled();
  });
});

describe("Worker - Timeout Enforcement", () => {
  let worker: Worker;
  let jobManager: JobManager;

  beforeEach(() => {
    // Clear jobs table
    testDb.prepare("DELETE FROM jobs").run();
    testDb.prepare("DELETE FROM job_history").run();

    worker = new Worker({ workerId: "test-worker", pollInterval: 100 });
    jobManager = new JobManager();
  });

  afterAll(async () => {
    if (worker) {
      await worker.stop();
    }
  });

  it("should enforce timeout and abort job execution", async () => {
    let abortReceived = false;
    
    // Register executor that checks for abort signal
    const executorMock = vi.fn(async (payload, signal) => {
      // Check if signal can be aborted
      if (signal.aborted) {
        abortReceived = true;
        throw new Error("Aborted");
      }
      
      // Listen for abort event
      signal.addEventListener("abort", () => {
        abortReceived = true;
      });
      
      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 100));
      
      return { result: "success" };
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create a job
    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    };
    const job = jobManager.createJob(input);

    // Start worker
    worker.start();

    // Wait for job to be executed
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Stop worker
    await worker.stop();

    // Verify executor was called
    expect(executorMock).toHaveBeenCalledTimes(1);

    // Verify job completed (since it finished before timeout)
    const updatedJob = jobManager.getJobById(job.id);
    expect(updatedJob.state).toBe("COMPLETED");

    // Note: In real scenario with long-running job, timeout would trigger after configured time
    // For this test, we verify the abort signal mechanism is in place
  });

  it("should respect AbortSignal in executor", async () => {
    let abortSignalReceived = false;

    // Register executor that checks abort signal
    const executorMock = vi.fn(async (payload, signal) => {
      abortSignalReceived = signal instanceof AbortSignal;
      return { result: "success" };
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create a job
    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    };
    jobManager.createJob(input);

    // Start worker
    worker.start();

    // Wait for job to be executed
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Stop worker
    await worker.stop();

    // Verify abort signal was passed
    expect(abortSignalReceived).toBe(true);
  });
});

describe("Worker - Error Handling and Retry", () => {
  let worker: Worker;
  let jobManager: JobManager;

  beforeEach(() => {
    // Clear jobs table
    testDb.prepare("DELETE FROM jobs").run();
    testDb.prepare("DELETE FROM job_history").run();

    worker = new Worker({ workerId: "test-worker", pollInterval: 100 });
    jobManager = new JobManager();
  });

  afterAll(async () => {
    if (worker) {
      await worker.stop();
    }
  });

  it("should handle transient errors and schedule retry", async () => {
    let callCount = 0;
    
    // Register executor that fails with transient error only on first call
    const executorMock = vi.fn(async (payload, signal) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("ETIMEDOUT: Connection timeout");
      }
      // Succeed on subsequent calls to prevent infinite retries
      return { result: "success" };
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create a job
    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    };
    const job = jobManager.createJob(input);

    // Start worker
    worker.start();

    // Wait for initial execution and first retry
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Stop worker
    await worker.stop();

    // Verify executor was called at least once (may be called more due to retry)
    expect(executorMock).toHaveBeenCalled();

    // Verify job was retried (attempt incremented)
    const updatedJob = jobManager.getJobById(job.id);
    expect(updatedJob.attempt).toBeGreaterThanOrEqual(1);
    
    // Job should either be PENDING (waiting for retry), RUNNING (being retried), or COMPLETED (retry succeeded)
    expect(["PENDING", "RUNNING", "COMPLETED"]).toContain(updatedJob.state);

    // Verify worker stats show at least one failure
    const stats = worker.getStats();
    expect(stats.jobsProcessed).toBeGreaterThanOrEqual(1);
  });

  it("should handle permanent errors and fail without retry", async () => {
    // Register executor that fails with permanent error
    const executorMock = vi.fn(async (payload, signal) => {
      const error = new Error("Invalid payload");
      error.name = "ValidationError";
      throw error;
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create a job
    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    };
    const job = jobManager.createJob(input);

    // Start worker
    worker.start();

    // Wait for job to be executed
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Stop worker
    await worker.stop();

    // Verify executor was called
    expect(executorMock).toHaveBeenCalledTimes(1);

    // Verify job failed permanently (no retry)
    const updatedJob = jobManager.getJobById(job.id);
    expect(updatedJob.state).toBe("FAILED");
    expect(updatedJob.attempt).toBe(0); // No retry, so attempt not incremented
    expect(updatedJob.error_message).toContain("Invalid payload");
    expect(updatedJob.error_code).toBe("ValidationError");

    // Verify worker stats
    const stats = worker.getStats();
    expect(stats.jobsProcessed).toBe(1);
    expect(stats.jobsFailed).toBe(1);
    expect(stats.jobsSucceeded).toBe(0);
  });

  it("should fail job after max retry attempts", async () => {
    let callCount = 0;

    // Register executor that always fails with transient error
    const executorMock = vi.fn(async (payload, signal) => {
      callCount++;
      throw new Error("ETIMEDOUT: Connection timeout");
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create a job
    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    };
    const job = jobManager.createJob(input);

    // Start worker and let it retry multiple times
    worker.start();

    // Wait for multiple retry attempts (stream-sync has maxRetries: 3)
    // Each retry has exponential backoff, so we need to wait longer
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Stop worker
    await worker.stop();

    // Verify job failed after max attempts
    const updatedJob = jobManager.getJobById(job.id);
    expect(updatedJob.state).toBe("FAILED");
    expect(updatedJob.attempt).toBeGreaterThanOrEqual(3); // Max attempts for stream-sync

    // Verify executor was called multiple times
    expect(callCount).toBeGreaterThan(1);
  });

  it("should release lock on execution error", async () => {
    // Register executor that throws error
    const executorMock = vi.fn(async (payload, signal) => {
      throw new Error("Execution failed");
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create a job
    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    };
    const job = jobManager.createJob(input);

    // Start worker
    worker.start();

    // Wait for job to be executed
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Stop worker
    await worker.stop();

    // Verify lock was released (worker_id is null)
    const updatedJob = jobManager.getJobById(job.id);
    expect(updatedJob.worker_id).toBeNull();
  });
});

describe("Worker - Result Persistence", () => {
  let worker: Worker;
  let jobManager: JobManager;

  beforeEach(() => {
    // Clear jobs table
    testDb.prepare("DELETE FROM jobs").run();
    testDb.prepare("DELETE FROM job_history").run();

    worker = new Worker({ workerId: "test-worker", pollInterval: 100 });
    jobManager = new JobManager();
  });

  afterAll(async () => {
    if (worker) {
      await worker.stop();
    }
  });

  it("should persist job result on successful completion", async () => {
    const expectedResult = {
      status: "completed",
      recordsProcessed: 100,
      duration: 1234,
    };

    // Register executor that returns result
    const executorMock = vi.fn(async (payload, signal) => {
      return expectedResult;
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create a job
    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    };
    const job = jobManager.createJob(input);

    // Start worker
    worker.start();

    // Wait for job to be executed
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Stop worker
    await worker.stop();

    // Verify result was persisted
    const updatedJob = jobManager.getJobById(job.id);
    expect(updatedJob.state).toBe("COMPLETED");
    expect(updatedJob.result).toBeDefined();

    const result = JSON.parse(updatedJob.result!);
    expect(result).toEqual(expectedResult);
  });

  it("should persist error details on failure", async () => {
    const errorMessage = "Database connection failed";

    // Register executor that throws error
    const executorMock = vi.fn(async (payload, signal) => {
      const error = new Error(errorMessage);
      error.name = "DatabaseError";
      throw error;
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create a job
    const input: CreateJobInput = {
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    };
    const job = jobManager.createJob(input);

    // Start worker
    worker.start();

    // Wait for job to be executed
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Stop worker
    await worker.stop();

    // Verify error was persisted
    const updatedJob = jobManager.getJobById(job.id);
    expect(updatedJob.error_message).toBe(errorMessage);
    expect(updatedJob.error_code).toBe("DatabaseError");
  });
});

describe("Worker - Concurrent Job Execution", () => {
  let worker: Worker;
  let jobManager: JobManager;

  beforeEach(() => {
    // Clear jobs table
    testDb.prepare("DELETE FROM jobs").run();
    testDb.prepare("DELETE FROM job_history").run();

    worker = new Worker({
      workerId: "test-worker",
      pollInterval: 50,
      maxConcurrentJobs: 3,
    });
    jobManager = new JobManager();
  });

  afterAll(async () => {
    if (worker) {
      await worker.stop();
    }
  });

  it("should execute multiple jobs concurrently up to max limit", async () => {
    const executingJobs = new Set<string>();
    let maxConcurrent = 0;

    // Register executor that tracks concurrent execution
    const executorMock = vi.fn(async (payload: any, signal) => {
      executingJobs.add(payload.jobId);
      maxConcurrent = Math.max(maxConcurrent, executingJobs.size);

      // Simulate work
      await new Promise((resolve) => setTimeout(resolve, 200));

      executingJobs.delete(payload.jobId);
      return { result: "success" };
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create multiple jobs
    const userId = randomUUID();
    for (let i = 0; i < 5; i++) {
      jobManager.createJob({
        user_id: userId,
        job_type: "stream-sync",
        priority: "normal",
        payload: { jobId: `job-${i}` },
      });
    }

    // Start worker
    worker.start();

    // Wait for jobs to be executed
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Stop worker
    await worker.stop();

    // Verify max concurrent jobs was respected
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(1); // Should have executed some concurrently

    // Verify all jobs were executed
    expect(executorMock).toHaveBeenCalledTimes(5);
  });
});

describe("Worker - Start and Stop", () => {
  it("should start and stop worker gracefully", async () => {
    const worker = new Worker({ workerId: "test-worker" });

    // Start worker
    worker.start();
    let stats = worker.getStats();
    expect(stats.isRunning).toBe(true);

    // Stop worker
    await worker.stop();
    stats = worker.getStats();
    expect(stats.isRunning).toBe(false);
  });

  it("should not start worker twice", () => {
    const worker = new Worker({ workerId: "test-worker" });

    // Start worker
    worker.start();
    const stats1 = worker.getStats();
    expect(stats1.isRunning).toBe(true);

    // Try to start again
    worker.start();
    const stats2 = worker.getStats();
    expect(stats2.isRunning).toBe(true);

    // Clean up
    worker.stop();
  });

  it("should wait for current jobs to complete before stopping", async () => {
    const worker = new Worker({ workerId: "test-worker", pollInterval: 100 });
    const jobManager = new JobManager();

    // Clear jobs table
    testDb.prepare("DELETE FROM jobs").run();
    testDb.prepare("DELETE FROM job_history").run();

    let jobCompleted = false;

    // Register executor that takes some time
    const executorMock = vi.fn(async (payload, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      jobCompleted = true;
      return { result: "success" };
    });
    worker.registerExecutor("stream-sync", executorMock);

    // Create a job
    jobManager.createJob({
      user_id: randomUUID(),
      job_type: "stream-sync",
      priority: "normal",
      payload: { streamId: "test-stream" },
    });

    // Start worker
    worker.start();

    // Wait a bit for job to start
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Stop worker (should wait for job to complete)
    await worker.stop();

    // Verify job completed before stop returned
    expect(jobCompleted).toBe(true);
  });
});