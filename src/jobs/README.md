# Background Job Queue System

This module provides a distributed, fault-tolerant system for managing long-running asynchronous tasks with at-least-once execution semantics, idempotency support, and comprehensive observability.

## Components

### JobManager
Handles job lifecycle operations with state machine validation. Manages job creation, state transitions, and history tracking.

```typescript
import { JobManager } from './jobs';

const jobManager = new JobManager();

// Create a job
const job = jobManager.createJob({
  user_id: 'user-123',
  job_type: 'stream-sync',
  priority: 'normal',
  payload: { streamId: 'stream-456' },
  idempotency_key: 'unique-key-123',
});

// Update job state
jobManager.updateJobState(job.id, {
  state: 'RUNNING',
  worker_id: 'worker-1',
});

// Get job history
const history = jobManager.getJobHistory(job.id);
```

### RetryEngine
Implements retry logic with exponential backoff, jitter, and error classification. Distinguishes between transient errors (retry eligible) and permanent errors (fail fast).

```typescript
import { RetryEngine } from './jobs';

const retryEngine = new RetryEngine();

// Determine if a job should be retried
const decision = retryEngine.shouldRetry(
  'stream-sync',  // job type
  2,              // current attempt (0-indexed)
  3,              // max attempts
  new Error('Network timeout')
);

if (decision.shouldRetry) {
  console.log(`Retrying in ${decision.backoffMs}ms`);
  console.log(`Next retry at: ${decision.nextRetryAt}`);
  
  // Schedule retry
  jobManager.setNextRetry(jobId, decision.nextRetryAt);
  jobManager.updateJobState(jobId, { state: 'RETRYING' });
} else {
  console.log(`Not retrying: ${decision.reason}`);
  jobManager.updateJobState(jobId, {
    state: 'FAILED',
    error_message: error.message,
  });
}
```

### Error Classification

The RetryEngine automatically classifies errors as transient or permanent:

**Transient Errors (will retry):**
- Network timeouts (ETIMEDOUT, ECONNREFUSED, ENOTFOUND)
- Database busy/locked errors (SQLITE_BUSY, SQLITE_LOCKED)
- Rate limits (HTTP 429, 503, 504)
- Server errors (HTTP 500, 502)

**Permanent Errors (fail fast):**
- Validation errors (HTTP 400, 422)
- Authorization failures (HTTP 401, 403)
- Resource not found (HTTP 404)
- Method not allowed (HTTP 405)

```typescript
// Classify an error
const errorType = retryEngine.classifyError(error);

if (errorType === 'permanent') {
  // Don't retry - fail immediately
  jobManager.updateJobState(jobId, {
    state: 'FAILED',
    error_message: error.message,
    error_code: 'PERMANENT_ERROR',
  });
}
```

### Exponential Backoff

The RetryEngine uses exponential backoff with jitter to prevent thundering herd:

```
baseDelay = min(initialBackoff * (2^attempt), maxBackoff)
jitter = random(0, baseDelay * 0.2)
delay = baseDelay + jitter
```

Example delays for stream-sync (initialBackoff: 1000ms, maxBackoff: 60000ms):
- Attempt 0: ~1000ms (1s)
- Attempt 1: ~2000ms (2s)
- Attempt 2: ~4000ms (4s)
- Attempt 3: ~8000ms (8s)
- Attempt 4: ~16000ms (16s)
- Attempt 5: ~32000ms (32s)
- Attempt 6+: ~60000ms (60s, capped)

### RateLimiter
Enforces rate limits on job submissions to prevent abuse.

```typescript
import { RateLimiter } from './jobs';

const rateLimiter = new RateLimiter();

// Check if user can submit a job
const canSubmit = rateLimiter.canSubmitJob('user-123', 'stream-sync');

if (!canSubmit) {
  throw new Error('Rate limit exceeded');
}

// Check concurrent job limit
const canRun = rateLimiter.canRunJob('user-123', 'stream-sync');
```

## Job Types and Configuration

Each job type has specific configuration for timeout, retries, and backoff:

```typescript
{
  "stream-sync": {
    timeout: 300000,        // 5 minutes
    maxRetries: 3,
    initialBackoff: 1000,   // 1 second
    maxBackoff: 60000,      // 1 minute
    priority: "normal",
    rateLimit: {
      perUser: 100,         // 100 jobs/hour
      concurrent: 10        // 10 concurrent jobs
    }
  },
  "event-sync": {
    timeout: 600000,        // 10 minutes
    maxRetries: 5,
    initialBackoff: 2000,   // 2 seconds
    maxBackoff: 120000,     // 2 minutes
    priority: "high",
    rateLimit: {
      perUser: 50,
      concurrent: 5
    }
  },
  "cleanup": {
    timeout: 180000,        // 3 minutes
    maxRetries: 2,
    initialBackoff: 5000,   // 5 seconds
    maxBackoff: 300000,     // 5 minutes
    priority: "low",
    rateLimit: {
      perUser: 20,
      concurrent: 2
    }
  }
}
```

## Worker Integration (Example)

Here's how a Worker would use the RetryEngine:

```typescript
import { JobManager, RetryEngine } from './jobs';

class Worker {
  private jobManager = new JobManager();
  private retryEngine = new RetryEngine();

  async executeJob(jobId: string): Promise<void> {
    const job = this.jobManager.getJobById(jobId);
    
    try {
      // Update to RUNNING
      this.jobManager.updateJobState(jobId, {
        state: 'RUNNING',
        worker_id: this.workerId,
      });

      // Execute job logic
      const result = await this.performWork(job);

      // Mark as COMPLETED
      this.jobManager.updateJobState(jobId, {
        state: 'COMPLETED',
        result,
      });
    } catch (error) {
      // Determine if we should retry
      const decision = this.retryEngine.shouldRetry(
        job.job_type,
        job.attempt,
        job.max_attempts,
        error
      );

      if (decision.shouldRetry) {
        // Schedule retry
        this.jobManager.incrementAttempt(jobId);
        this.jobManager.setNextRetry(jobId, decision.nextRetryAt);
        this.jobManager.updateJobState(jobId, {
          state: 'RETRYING',
          error_message: error.message,
        });
        
        // Transition back to PENDING for retry
        this.jobManager.updateJobState(jobId, {
          state: 'PENDING',
        });
      } else {
        // Permanent failure
        this.jobManager.updateJobState(jobId, {
          state: 'FAILED',
          error_message: error.message,
          error_code: decision.errorType === 'permanent' 
            ? 'PERMANENT_ERROR' 
            : 'MAX_RETRIES_EXCEEDED',
        });
      }
    }
  }
}
```

## State Machine

Jobs follow a strict state machine:

```
PENDING → RUNNING → COMPLETED
  ↓        ↓
FAILED ← RETRYING
  ↓
CANCELLED
```

Valid transitions:
- PENDING → RUNNING, CANCELLED
- RUNNING → COMPLETED, FAILED, RETRYING, CANCELLED
- FAILED → RETRYING
- RETRYING → PENDING
- COMPLETED → (terminal)
- CANCELLED → (terminal)

## Testing

Comprehensive unit tests are provided for all components:

```bash
# Run all job queue tests
npm test -- tests/jobs-*.test.ts

# Run specific test suites
npm test -- tests/jobs-retry-engine.test.ts
npm test -- tests/jobs-rate-limiter.test.ts
npm test -- tests/jobs-cancel-retry.test.ts
```

## API Endpoints

- `POST /api/jobs` - Submit a new job
- `GET /api/jobs/{jobId}` - Get job status
- `GET /api/jobs` - List jobs with filtering
- `DELETE /api/jobs/{jobId}` - Cancel a job
- `POST /api/jobs/{jobId}/retry` - Retry a failed job

See the OpenAPI documentation for detailed API specifications.
