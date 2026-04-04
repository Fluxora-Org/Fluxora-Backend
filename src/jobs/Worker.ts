/**
 * Worker - Job execution engine with polling, locking, and timeout enforcement
 *
 * Implements the worker pool pattern for background job execution. Each worker
 * polls the job queue, acquires locks to prevent concurrent execution, enforces
 * timeouts, and persists results. Integrates with JobManager for state management
 * and RetryEngine for failure handling.
 *
 * @module jobs/Worker
 */

import { randomUUID } from "crypto";
import { getDatabase } from "../db/connection.js";
import { JobManager } from "./JobManager.js";
import { RetryEngine } from "./RetryEngine.js";
import type { JobRecord, JobType } from "./types.js";
import { DEFAULT_JOB_CONFIGS } from "./types.js";

/**
 * Job executor function type
 */
export type JobExecutor = (
  payload: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;

/**
 * Worker configuration
 */
export interface WorkerConfig {
  /** Unique worker identifier */
  workerId?: string;

  /** Polling interval in milliseconds */
  pollInterval?: number;

  /** Job types this worker can execute */
  jobTypes?: JobType[];

  /** Maximum concurrent jobs */
  maxConcurrentJobs?: number;
}

/**
 * Worker statistics
 */
export interface WorkerStats {
  workerId: string;
  jobsProcessed: number;
  jobsSucceeded: number;
  jobsFailed: number;
  currentJobs: number;
  isRunning: boolean;
}

/**
 * Worker handles job execution with polling, locking, and timeout enforcement
 */
export class Worker {
  private readonly workerId: string;
  private readonly pollInterval: number;
  private readonly jobTypes: JobType[];
  private readonly maxConcurrentJobs: number;
  private readonly jobManager: JobManager;
  private readonly retryEngine: RetryEngine;
  private readonly executors: Map<JobType, JobExecutor>;
  private isRunning: boolean;
  private pollTimer: NodeJS.Timeout | null;
  private currentJobs: Set<string>;
  private stats: {
    jobsProcessed: number;
    jobsSucceeded: number;
    jobsFailed: number;
  };

  constructor(config: WorkerConfig = {}) {
    this.workerId = config.workerId || `worker-${randomUUID()}`;
    this.pollInterval = config.pollInterval || 1000; // 1 second default
    this.jobTypes = config.jobTypes || ["stream-sync", "event-sync", "cleanup"];
    this.maxConcurrentJobs = config.maxConcurrentJobs || 5;
    this.jobManager = new JobManager();
    this.retryEngine = new RetryEngine();
    this.executors = new Map();
    this.isRunning = false;
    this.pollTimer = null;
    this.currentJobs = new Set();
    this.stats = {
      jobsProcessed: 0,
      jobsSucceeded: 0,
      jobsFailed: 0,
    };
  }

  /**
   * Register a job executor for a specific job type
   *
   * @param jobType - Type of job to handle
   * @param executor - Function to execute the job
   */
  registerExecutor(jobType: JobType, executor: JobExecutor): void {
    this.executors.set(jobType, executor);
  }

  /**
   * Start the worker polling loop
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.poll();
  }

  /**
   * Stop the worker polling loop
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for current jobs to complete
    while (this.currentJobs.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Poll the job queue for pending jobs
   */
  private poll(): void {
    if (!this.isRunning) {
      return;
    }

    // Check if we can accept more jobs
    if (this.currentJobs.size >= this.maxConcurrentJobs) {
      this.schedulePoll();
      return;
    }

    try {
      // Get next pending job
      const job = this.getNextJob();

      if (job) {
        // Execute job asynchronously
        this.executeJob(job).catch((error) => {
          console.error(`Worker ${this.workerId} job execution error:`, error);
        });
      }
    } catch (error) {
      console.error(`Worker ${this.workerId} polling error:`, error);
    }

    this.schedulePoll();
  }

  /**
   * Schedule next poll
   */
  private schedulePoll(): void {
    if (this.isRunning) {
      this.pollTimer = setTimeout(() => this.poll(), this.pollInterval);
    }
  }

  /**
   * Get next pending job from queue with lock acquisition
   *
   * @returns Next job to execute, or null if none available
   */
  private getNextJob(): JobRecord | null {
    const db = getDatabase();

    // Use transaction to atomically get and lock a job
    const transaction = db.transaction(() => {
      // Find next pending job that:
      // 1. Is in PENDING state
      // 2. Is one of the job types this worker handles
      // 3. Is scheduled for now or earlier (or not scheduled)
      // 4. Is not already locked by another worker
      const job = db
        .prepare(
          `SELECT * FROM jobs 
           WHERE state = 'PENDING'
           AND job_type IN (${this.jobTypes.map(() => "?").join(",")})
           AND (scheduled_for IS NULL OR scheduled_for <= datetime('now'))
           AND worker_id IS NULL
           ORDER BY priority DESC, created_at ASC
           LIMIT 1`,
        )
        .get(...this.jobTypes) as JobRecord | undefined;

      if (!job) {
        return null;
      }

      // Acquire lock by setting worker_id
      db.prepare("UPDATE jobs SET worker_id = ? WHERE id = ?").run(
        this.workerId,
        job.id,
      );

      return job;
    });

    return transaction();
  }

  /**
   * Execute a job with timeout enforcement
   *
   * @param job - Job to execute
   */
  private async executeJob(job: JobRecord): Promise<void> {
    this.currentJobs.add(job.id);

    try {
      // Get job executor
      const executor = this.executors.get(job.job_type);
      if (!executor) {
        throw new Error(`No executor registered for job type: ${job.job_type}`);
      }

      // Transition to RUNNING state
      this.jobManager.updateJobState(
        job.id,
        { state: "RUNNING", worker_id: this.workerId },
        `Worker ${this.workerId} started execution`,
      );

      // Get job configuration
      const config = DEFAULT_JOB_CONFIGS[job.job_type];

      // Create AbortController for timeout enforcement
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, config.timeout);

      try {
        // Parse payload
        const payload = JSON.parse(job.payload) as Record<string, unknown>;

        // Execute job with timeout
        const result = await executor(payload, abortController.signal);

        // Clear timeout
        clearTimeout(timeoutId);

        // Job completed successfully
        this.jobManager.updateJobState(
          job.id,
          { state: "COMPLETED", result, worker_id: null },
          `Worker ${this.workerId} completed execution`,
        );

        this.stats.jobsProcessed++;
        this.stats.jobsSucceeded++;
      } catch (error) {
        // Clear timeout
        clearTimeout(timeoutId);

        // Check if job was aborted due to timeout
        if (abortController.signal.aborted) {
          await this.handleJobTimeout(job);
        } else {
          await this.handleJobError(job, error as Error);
        }
      }
    } catch (error) {
      console.error(
        `Worker ${this.workerId} failed to execute job ${job.id}:`,
        error,
      );

      // Release lock
      try {
        const db = getDatabase();
        db.prepare("UPDATE jobs SET worker_id = NULL WHERE id = ?").run(job.id);
      } catch (releaseError) {
        console.error(
          `Worker ${this.workerId} failed to release lock for job ${job.id}:`,
          releaseError,
        );
      }
    } finally {
      this.currentJobs.delete(job.id);
    }
  }

  /**
   * Handle job timeout
   *
   * @param job - Job that timed out
   */
  private async handleJobTimeout(job: JobRecord): Promise<void> {
    const config = DEFAULT_JOB_CONFIGS[job.job_type];
    const timeoutError = new Error(
      `Job execution timed out after ${config.timeout}ms`,
    );
    timeoutError.name = "TimeoutError";

    // Classify error and determine retry
    const decision = this.retryEngine.shouldRetry(
      job.job_type,
      job.attempt,
      job.max_attempts,
      timeoutError,
    );

    if (decision.shouldRetry) {
      // Increment attempt
      this.jobManager.incrementAttempt(job.id);

      // Set next retry time
      this.jobManager.setNextRetry(job.id, decision.nextRetryAt!);

      // Transition to RETRYING state
      this.jobManager.updateJobState(
        job.id,
        {
          state: "RETRYING",
          error_message: timeoutError.message,
          error_code: "TIMEOUT",
          worker_id: null,
        },
        decision.reason,
      );

      // Transition to PENDING state for retry
      this.jobManager.updateJobState(
        job.id,
        { state: "PENDING" },
        `Scheduled for retry at ${decision.nextRetryAt!.toISOString()}`,
      );
    } else {
      // Mark as FAILED
      this.jobManager.updateJobState(
        job.id,
        {
          state: "FAILED",
          error_message: timeoutError.message,
          error_code: "TIMEOUT",
          worker_id: null,
        },
        decision.reason,
      );
    }

    this.stats.jobsProcessed++;
    this.stats.jobsFailed++;
  }

  /**
   * Handle job execution error
   *
   * @param job - Job that failed
   * @param error - Error that occurred
   */
  private async handleJobError(job: JobRecord, error: Error): Promise<void> {
    // Classify error and determine retry
    const decision = this.retryEngine.shouldRetry(
      job.job_type,
      job.attempt,
      job.max_attempts,
      error,
    );

    if (decision.shouldRetry) {
      // Increment attempt
      this.jobManager.incrementAttempt(job.id);

      // Set next retry time
      this.jobManager.setNextRetry(job.id, decision.nextRetryAt!);

      // Transition to RETRYING state
      this.jobManager.updateJobState(
        job.id,
        {
          state: "RETRYING",
          error_message: error.message,
          error_code: error.name,
          worker_id: null,
        },
        decision.reason,
      );

      // Transition to PENDING state for retry
      this.jobManager.updateJobState(
        job.id,
        { state: "PENDING" },
        `Scheduled for retry at ${decision.nextRetryAt!.toISOString()}`,
      );
    } else {
      // Mark as FAILED
      this.jobManager.updateJobState(
        job.id,
        {
          state: "FAILED",
          error_message: error.message,
          error_code: error.name,
          worker_id: null,
        },
        decision.reason,
      );
    }

    this.stats.jobsProcessed++;
    this.stats.jobsFailed++;
  }

  /**
   * Get worker statistics
   *
   * @returns Worker statistics
   */
  getStats(): WorkerStats {
    return {
      workerId: this.workerId,
      jobsProcessed: this.stats.jobsProcessed,
      jobsSucceeded: this.stats.jobsSucceeded,
      jobsFailed: this.stats.jobsFailed,
      currentJobs: this.currentJobs.size,
      isRunning: this.isRunning,
    };
  }
}
