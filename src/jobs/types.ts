/**
 * Type definitions for the background job queue system.
 *
 * This module defines all types for jobs, states, configurations, and related entities.
 * All monetary amounts and numeric values preserve precision using appropriate types.
 *
 * @module jobs/types
 */

/**
 * Job state values - represents the lifecycle of a job
 */
export type JobState =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "RETRYING"
  | "CANCELLED";

/**
 * Job priority levels
 */
export type JobPriority = "high" | "normal" | "low";

/**
 * Job type identifiers
 */
export type JobType = "stream-sync" | "event-sync" | "cleanup";

/**
 * Error classification for retry logic
 */
export type ErrorType = "transient" | "permanent";

/**
 * Job record from the database
 */
export interface JobRecord {
  /** Unique job identifier (UUID) */
  id: string;

  /** User who submitted the job */
  user_id: string;

  /** Type of job to execute */
  job_type: JobType;

  /** Job priority (0 = low, 1 = normal, 2 = high) */
  priority: number;

  /** Current job state */
  state: JobState;

  /** Job parameters as JSON string */
  payload: string;

  /** Job result as JSON string (null until completed) */
  result: string | null;

  /** Error message if job failed */
  error_message: string | null;

  /** Error code for categorization */
  error_code: string | null;

  /** When the job was created */
  created_at: string;

  /** When the job started executing (null if not started) */
  started_at: string | null;

  /** When the job completed (null if not completed) */
  completed_at: string | null;

  /** When the job should be executed (for scheduled jobs) */
  scheduled_for: string | null;

  /** When the job will timeout (null if not running) */
  timeout_at: string | null;

  /** Current attempt number (0-indexed) */
  attempt: number;

  /** Maximum retry attempts allowed */
  max_attempts: number;

  /** When the next retry should occur (null if not retrying) */
  next_retry_at: string | null;

  /** Idempotency key for duplicate detection (null if not provided) */
  idempotency_key: string | null;

  /** Correlation ID for request tracing */
  correlation_id: string | null;

  /** Worker ID currently executing the job (null if not running) */
  worker_id: string | null;

  /** Job progress percentage (0-100) */
  progress_percent: number;

  /** Estimated completion time (null if not available) */
  estimated_completion_at: string | null;
}

/**
 * Job history record tracking state transitions
 */
export interface JobHistoryRecord {
  /** Unique history entry identifier (UUID) */
  id: string;

  /** Job this history entry belongs to */
  job_id: string;

  /** Previous state (null for initial creation) */
  old_state: JobState | null;

  /** New state after transition */
  new_state: JobState;

  /** Reason for the state transition */
  transition_reason: string | null;

  /** When the transition occurred */
  transitioned_at: string;
}

/**
 * Input for creating a new job
 */
export interface CreateJobInput {
  user_id: string;
  job_type: JobType;
  priority: JobPriority;
  payload: Record<string, unknown>;
  idempotency_key?: string;
  correlation_id?: string;
  scheduled_for?: Date;
}

/**
 * Input for updating job state
 */
export interface UpdateJobStateInput {
  state: JobState;
  error_message?: string;
  error_code?: string;
  result?: Record<string, unknown>;
  worker_id?: string | null;
  progress_percent?: number;
  estimated_completion_at?: Date;
}

/**
 * Job type configuration
 */
export interface JobTypeConfig {
  /** Job type identifier */
  name: JobType;

  /** Timeout in milliseconds */
  timeout: number;

  /** Maximum retry attempts */
  maxRetries: number;

  /** Initial backoff delay in milliseconds */
  initialBackoff: number;

  /** Maximum backoff delay in milliseconds */
  maxBackoff: number;

  /** Default priority */
  priority: JobPriority;

  /** Rate limiting configuration */
  rateLimit?: {
    /** Maximum jobs per user per hour */
    perUser: number;

    /** Maximum concurrent jobs per user */
    concurrent: number;
  };
}

/**
 * Job filter options for queries
 */
export interface JobFilter {
  user_id?: string;
  job_type?: JobType;
  state?: JobState;
  priority?: JobPriority;
  created_after?: Date;
  created_before?: Date;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  limit: number;
  offset: number;
}

/**
 * Paginated job results
 */
export interface PaginatedJobs {
  jobs: JobRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Job state machine - valid transitions
 */
export const JOB_STATE_TRANSITIONS: Record<JobState, JobState[]> = {
  PENDING: ["RUNNING", "CANCELLED"],
  RUNNING: ["COMPLETED", "FAILED", "RETRYING", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["RETRYING"],
  RETRYING: ["PENDING"],
  CANCELLED: [],
};

/**
 * Priority to numeric value mapping
 */
export const PRIORITY_VALUES: Record<JobPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
};

/**
 * Numeric value to priority mapping
 */
export const VALUE_TO_PRIORITY: Record<number, JobPriority> = {
  0: "low",
  1: "normal",
  2: "high",
};

/**
 * Default job type configurations
 */
export const DEFAULT_JOB_CONFIGS: Record<JobType, JobTypeConfig> = {
  "stream-sync": {
    name: "stream-sync",
    timeout: 300000, // 5 minutes
    maxRetries: 3,
    initialBackoff: 1000, // 1 second
    maxBackoff: 60000, // 1 minute
    priority: "normal",
    rateLimit: {
      perUser: 100,
      concurrent: 10,
    },
  },
  "event-sync": {
    name: "event-sync",
    timeout: 600000, // 10 minutes
    maxRetries: 5,
    initialBackoff: 2000, // 2 seconds
    maxBackoff: 120000, // 2 minutes
    priority: "high",
    rateLimit: {
      perUser: 50,
      concurrent: 5,
    },
  },
  cleanup: {
    name: "cleanup",
    timeout: 180000, // 3 minutes
    maxRetries: 2,
    initialBackoff: 5000, // 5 seconds
    maxBackoff: 300000, // 5 minutes
    priority: "low",
    rateLimit: {
      perUser: 20,
      concurrent: 2,
    },
  },
};

/**
 * Job queue invariants - guarantees about data correctness
 */
export const JOB_INVARIANTS = {
  /** Valid state transitions */
  validTransitions: JOB_STATE_TRANSITIONS,

  /** Priority constraints */
  priorityConstraints: {
    min: 0,
    max: 2,
  },

  /** Attempt constraints */
  attemptConstraints: {
    min: 0,
    max: 10,
  },

  /** Progress constraints */
  progressConstraints: {
    min: 0,
    max: 100,
  },

  /** Payload size limit (1MB) */
  maxPayloadSize: 1024 * 1024,

  /** Idempotency key expiration (24 hours) */
  idempotencyKeyTTL: 24 * 60 * 60 * 1000,
} as const;
