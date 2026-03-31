# Design Document: Background Job Queue for Long-Running Sync Tasks

## Overview

The Background Job Queue is a distributed, fault-tolerant system for managing long-running asynchronous tasks in the Fluxora backend. It provides at-least-once execution semantics with idempotency support, comprehensive observability, and graceful handling of failure scenarios. The system is designed to scale horizontally with multiple worker processes while maintaining data consistency and durability.

## Architecture

### Component Structure

```
JobQueue System
├── API Layer (HTTP endpoints for job submission and status queries)
├── Job Manager (job lifecycle management and state transitions)
├── Queue Storage (persistent job queue in database)
├── Worker Pool (background processes executing jobs)
├── Retry Engine (exponential backoff and retry logic)
├── Rate Limiter (abuse prevention and quota enforcement)
├── Metrics Collector (observability and monitoring)
└── Event Notifier (webhooks and real-time updates)
```

### Data Model

#### Job Table Schema

```sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  job_type VARCHAR(50) NOT NULL,
  priority INT DEFAULT 0,
  state VARCHAR(20) NOT NULL,
  payload JSONB NOT NULL,
  result JSONB,
  error_message TEXT,
  error_code VARCHAR(50),
  created_at TIMESTAMP NOT NULL,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  scheduled_for TIMESTAMP,
  timeout_at TIMESTAMP,
  attempt INT DEFAULT 0,
  max_attempts INT DEFAULT 3,
  next_retry_at TIMESTAMP,
  idempotency_key VARCHAR(255),
  correlation_id UUID,
  worker_id VARCHAR(255),
  progress_percent INT DEFAULT 0,
  estimated_completion_at TIMESTAMP,
  UNIQUE(idempotency_key),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX idx_jobs_state ON jobs(state);
CREATE INDEX idx_jobs_priority ON jobs(priority DESC);
CREATE INDEX idx_jobs_user_id ON jobs(user_id);
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX idx_jobs_scheduled_for ON jobs(scheduled_for);
```

#### Job History Table Schema

```sql
CREATE TABLE job_history (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  old_state VARCHAR(20),
  new_state VARCHAR(20) NOT NULL,
  transition_reason TEXT,
  transitioned_at TIMESTAMP NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE INDEX idx_job_history_job_id ON job_history(job_id);
```

### Job States

```
PENDING → RUNNING → COMPLETED
  ↓        ↓
FAILED ← RETRYING
  ↓
CANCELLED
```

**State Definitions:**
- **PENDING**: Job submitted, waiting to be picked up by a worker
- **RUNNING**: Job currently executing on a worker
- **COMPLETED**: Job finished successfully
- **FAILED**: Job failed permanently (max retries exceeded or permanent error)
- **RETRYING**: Job failed with transient error, scheduled for retry
- **CANCELLED**: Job cancelled by user or system

### Job Types and Configuration

```typescript
interface JobTypeConfig {
  name: string;
  timeout: number;           // milliseconds
  maxRetries: number;
  initialBackoff: number;    // milliseconds
  maxBackoff: number;        // milliseconds
  priority: 'high' | 'normal' | 'low';
  rateLimit?: {
    perUser: number;         // max jobs per user per hour
    concurrent: number;      // max concurrent jobs per user
  };
}
```

### API Endpoints

#### Submit Job
```
POST /api/jobs
Content-Type: application/json

{
  "jobType": "stream-sync",
  "priority": "normal",
  "payload": { ... },
  "idempotencyKey": "optional-uuid"
}

Response 202 Accepted:
{
  "jobId": "uuid",
  "state": "PENDING",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

#### Get Job Status
```
GET /api/jobs/{jobId}

Response 200 OK:
{
  "jobId": "uuid",
  "state": "RUNNING",
  "progress": 45,
  "estimatedCompletionAt": "2024-01-01T00:05:00Z",
  "createdAt": "2024-01-01T00:00:00Z",
  "startedAt": "2024-01-01T00:01:00Z",
  "result": null,
  "error": null
}
```

#### List Jobs
```
GET /api/jobs?state=RUNNING&limit=20&offset=0

Response 200 OK:
{
  "jobs": [...],
  "total": 100,
  "limit": 20,
  "offset": 0
}
```

#### Cancel Job
```
DELETE /api/jobs/{jobId}

Response 204 No Content
```

#### Retry Job
```
POST /api/jobs/{jobId}/retry

Response 202 Accepted:
{
  "jobId": "uuid",
  "state": "PENDING",
  "attempt": 2
}
```

### Worker Implementation

**Worker Responsibilities:**
1. Poll job queue for pending jobs
2. Acquire job lock to prevent concurrent execution
3. Execute job with timeout enforcement
4. Update job state and result
5. Handle errors and schedule retries
6. Release job lock on completion

**Worker Lifecycle:**
```
Start → Poll Queue → Acquire Lock → Execute → Update State → Release Lock → Poll Queue
                                        ↓
                                    Error → Retry Logic
```

### Retry Logic

**Exponential Backoff Formula:**
```
baseDelay = min(initialBackoff * (2^attempt), maxBackoff)
jitter = random(0, baseDelay * 0.2)
nextRetryTime = now + baseDelay + jitter
```

**Error Classification:**
- **Transient Errors**: Network timeouts, database connection errors, rate limits (HTTP 429, 503, 504)
- **Permanent Errors**: Validation errors, authorization failures, resource not found (HTTP 400, 401, 403, 404)

### Rate Limiting

**Rate Limit Enforcement:**
1. Per-user job submission rate (e.g., 100 jobs/hour)
2. Per-user concurrent job limit (e.g., 10 concurrent jobs)
3. Per-user total queued job limit (e.g., 1000 queued jobs)
4. Global queue depth limit (e.g., 100,000 total jobs)

**Rate Limit Response:**
```
HTTP 429 Too Many Requests
Retry-After: 60
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1704067200
```

### Idempotency

**Idempotency Key Handling:**
1. Client provides optional `idempotencyKey` with job submission
2. Server checks if job with same key already exists
3. If exists, return existing job ID (idempotent response)
4. If not exists, create new job and store key
5. Idempotency key expires after 24 hours

### Observability

**Metrics:**
- `jobs_submitted_total`: Total jobs submitted
- `jobs_completed_total`: Total jobs completed successfully
- `jobs_failed_total`: Total jobs failed
- `jobs_retried_total`: Total job retries
- `job_duration_seconds`: Job execution duration (histogram)
- `queue_depth`: Current number of pending jobs
- `queue_processing_rate`: Jobs processed per second
- `worker_count`: Number of active workers

**Logging:**
- Job submission with user ID and correlation ID
- Job state transitions with reason
- Job execution start and completion
- Job failures with error details
- Retry attempts with backoff delay
- Worker health and availability

**Health Check:**
```
GET /health/queue

Response 200 OK:
{
  "status": "healthy",
  "queueDepth": 150,
  "processingRate": 10.5,
  "workerCount": 3,
  "failureRate": 0.02
}
```

### Security Considerations

**Authentication & Authorization:**
- All job endpoints require authentication
- Users can only access their own jobs
- Admins can access all jobs
- Rate limits enforced per user

**Input Validation:**
- Job payload size limited (e.g., 1MB)
- Job type validated against allowed types
- Priority validated against allowed values
- Idempotency key format validated

**Abuse Prevention:**
- Rate limiting on job submissions
- Concurrent job limits per user
- Queue depth limits
- Automatic blocking of abusive users
- Audit logging of all operations

## Correctness Properties

### Property 1: At-Least-Once Execution
Every job submitted to the queue will be executed at least once, even in the presence of worker failures or network issues.

### Property 2: Idempotent Processing
Jobs with the same idempotency key will produce the same result, regardless of how many times they are submitted.

### Property 3: State Consistency
Job state transitions follow the defined state machine, and no invalid transitions are possible.

### Property 4: Durability
All job submissions are persisted to the database before returning success to the client.

### Property 5: Timeout Enforcement
No job will execute longer than its configured timeout without being forcibly terminated.

### Property 6: Rate Limit Enforcement
No user will exceed their configured rate limits for job submissions or concurrent execution.

### Property 7: Failure Isolation
Failure of one job does not affect the execution of other jobs.

### Property 8: Worker Availability
If a worker fails, its jobs will be reassigned to another worker or marked as failed after timeout.
