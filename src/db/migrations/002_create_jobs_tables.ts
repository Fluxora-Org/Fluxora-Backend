/**
 * Database migration: Create jobs and job_history tables
 *
 * This migration creates the background job queue tables for managing
 * long-running asynchronous tasks with comprehensive state tracking.
 *
 * MIGRATION: 002_create_jobs_tables
 * APPLIED_AT: Will be set by migration runner
 *
 * @module db/migrations/002_create_jobs_tables
 */

export const up = `
/**
 * Jobs table - manages background job queue
 * 
 * Indexes:
 * - idx_jobs_state: For filtering by state
 * - idx_jobs_priority: For priority-based queue ordering
 * - idx_jobs_user_id: For user-specific job queries
 * - idx_jobs_created_at: For time-based queries
 * - idx_jobs_scheduled_for: For scheduled job execution
 * - idx_jobs_idempotency_key: For duplicate detection
 * - idx_jobs_correlation_id: For request tracing
 */
CREATE TABLE IF NOT EXISTS jobs (
  -- Primary identifier (UUID)
  id TEXT PRIMARY KEY,
  
  -- User who submitted the job
  user_id TEXT NOT NULL,
  
  -- Job type and priority
  job_type TEXT NOT NULL CHECK (
    job_type IN ('stream-sync', 'event-sync', 'cleanup')
  ),
  priority INTEGER NOT NULL DEFAULT 1 CHECK (priority >= 0 AND priority <= 2),
  
  -- Job state
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    state IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED')
  ),
  
  -- Job data (stored as JSON strings)
  payload TEXT NOT NULL,
  result TEXT,
  
  -- Error information
  error_message TEXT,
  error_code TEXT,
  
  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  scheduled_for TEXT,
  timeout_at TEXT,
  
  -- Retry configuration
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 0),
  next_retry_at TEXT,
  
  -- Idempotency and tracing
  idempotency_key TEXT,
  correlation_id TEXT,
  
  -- Worker assignment
  worker_id TEXT,
  
  -- Progress tracking
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent >= 0 AND progress_percent <= 100),
  estimated_completion_at TEXT,
  
  -- Constraints
  CONSTRAINT idx_jobs_unique_idempotency UNIQUE (idempotency_key)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs(priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_for ON jobs(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_jobs_correlation_id ON jobs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_jobs_job_type ON jobs(job_type);

/**
 * Job history table - tracks job state transitions
 * 
 * Indexes:
 * - idx_job_history_job_id: For retrieving history by job
 * - idx_job_history_transitioned_at: For time-based queries
 */
CREATE TABLE IF NOT EXISTS job_history (
  -- Primary identifier (UUID)
  id TEXT PRIMARY KEY,
  
  -- Job this history entry belongs to
  job_id TEXT NOT NULL,
  
  -- State transition
  old_state TEXT CHECK (
    old_state IS NULL OR 
    old_state IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED')
  ),
  new_state TEXT NOT NULL CHECK (
    new_state IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED')
  ),
  
  -- Transition metadata
  transition_reason TEXT,
  transitioned_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  -- Foreign key constraint
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

-- Indexes for job history queries
CREATE INDEX IF NOT EXISTS idx_job_history_job_id ON job_history(job_id);
CREATE INDEX IF NOT EXISTS idx_job_history_transitioned_at ON job_history(transitioned_at DESC);
`;

export const down = `
DROP TABLE IF EXISTS job_history;
DROP TABLE IF EXISTS jobs;
`;
