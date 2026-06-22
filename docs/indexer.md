# Contract Event Indexer Documentation

## Overview

The contract event indexer provides efficient replay of historical blockchain events into the `contract_events` table with optimized batch processing and PostgreSQL indexing.

## Features

- **Batch Insert Processing**: Events are inserted in configurable batches to minimize database round-trips
- **Optimized Indexes**: Composite and partial indexes for fast replay queries
- **Ledger Partitions**: `contract_events` is range-partitioned by ledger for bounded replay scans and cheaper maintenance
- **Retention Guardrails**: Partition retention defaults to dry-run and requires explicit confirmation before detach/drop
- **Progress Tracking**: Real-time progress monitoring with estimated completion times
- **Duplicate Handling**: Automatic deduplication using `ON CONFLICT DO NOTHING`
- **Transaction Safety**: Full ACID compliance with automatic rollback on errors
- **Concurrent Replay Prevention**: Only one replay operation can run at a time

## Configuration

### Environment Variables

Create a `.env` file based on `.env.example`:

```bash
# Database connection string
DATABASE_URL=postgresql://user:password@localhost:5432/indexer_db

# Number of events to insert per batch (default: 1000)
# Tune based on your database performance and memory constraints
REPLAY_BATCH_SIZE=1000

# Server port
PORT=3000
```

### Batch Size Tuning

The `REPLAY_BATCH_SIZE` parameter controls how many events are inserted in a single SQL statement:

- **Small batches (100-500)**: Lower memory usage, more database round-trips
- **Medium batches (1000-2000)**: Balanced performance (recommended)
- **Large batches (5000+)**: Faster for bulk operations, higher memory usage

**Recommendation**: Start with 1000 and adjust based on:
- Available database memory
- Network latency between application and database
- Size of event_data JSONB payloads

## API Endpoints

### POST /internal/indexer/events/replay

Start a replay operation for historical contract events.

**Security**: This is an internal endpoint. In production:
- Add authentication/authorization middleware
- Implement IP whitelisting
- Add rate limiting
- Use API keys or JWT tokens

**Request Body**:
```json
{
  "contract_id": "contract-abc-123",
  "ledger": 1,
  "from_block": 1000,     // optional
  "to_block": 2000        // optional
}
```

**Response** (202 Accepted):
```json
{
  "message": "Replay started",
  "status": {
    "isReplaying": true,
    "rowsReplayed": 0,
    "rowsRemaining": 1500,
    "totalRows": 1500,
    "estimatedCompletion": "2026-05-28T15:30:00.000Z",
    "startedAt": "2026-05-28T15:00:00.000Z",
    "contractId": "contract-abc-123",
    "ledger": 1
  }
}
```

**Error Responses**:
- `400 Bad Request`: Invalid parameters
- `409 Conflict`: Replay already in progress

**Example**:
```bash
curl -X POST http://localhost:3000/internal/indexer/events/replay \
  -H "Content-Type: application/json" \
  -d '{
    "contract_id": "contract-abc-123",
    "ledger": 1,
    "from_block": 1000,
    "to_block": 2000
  }'
```

### GET /internal/indexer/status

Get current replay progress and indexer status.

**Response** (200 OK):
```json
{
  "isReplaying": true,
  "rowsReplayed": 750,
  "rowsRemaining": 750,
  "totalRows": 1500,
  "estimatedCompletion": "2026-05-28T15:30:00.000Z",
  "startedAt": "2026-05-28T15:00:00.000Z",
  "contractId": "contract-abc-123",
  "ledger": 1
}
```

**Fields**:
- `isReplaying`: Whether a replay is currently in progress
- `rowsReplayed`: Number of events successfully inserted
- `rowsRemaining`: Estimated events left to process
- `totalRows`: Total events in the replay operation
- `estimatedCompletion`: Projected completion time (null if not enough data)
- `startedAt`: When the replay started (null if not replaying)
- `contractId`: Contract being replayed (optional)
- `ledger`: Ledger being replayed (optional)

**Example**:
```bash
curl http://localhost:3000/internal/indexer/status
```

### Cursor replay recovery

Consumers that resume from a stored `afterEventId` must treat `STALE_CURSOR`
as a signal that the cursor row was removed, for example by a reorg rollback.
The correct recovery path is to discard that cursor and re-sync from the last
trusted `fromLedger` checkpoint, then continue normal cursor replay from the
new page results.

## Database Schema

### Tables

#### historical_events
Source table containing historical blockchain events.

```sql
CREATE TABLE historical_events (
  event_id VARCHAR(255) PRIMARY KEY,
  contract_id VARCHAR(255) NOT NULL,
  ledger INTEGER NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  event_data JSONB NOT NULL,
  block_height BIGINT NOT NULL,
  transaction_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### contract_events
Destination table for replayed events.

```sql
CREATE TABLE contract_events (
  event_id VARCHAR(255) NOT NULL,
  contract_id VARCHAR(255) NOT NULL,
  ledger INTEGER NOT NULL,
  event_type VARCHAR(100),
  event_data JSONB,
  block_height BIGINT,
  transaction_hash VARCHAR(255),
  topic TEXT,
  tx_hash TEXT,
  tx_index INTEGER,
  operation_index INTEGER,
  event_index INTEGER,
  payload JSONB,
  happened_at TIMESTAMPTZ,
  ledger_hash TEXT,
  ingested_at TIMESTAMP,
  ingestion_state TEXT GENERATED ALWAYS AS (
    CASE WHEN ingested_at IS NULL THEN 'pending' ELSE 'ingested' END
  ) STORED,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ledger, event_id)
) PARTITION BY RANGE (ledger);
```

`ingested_at` is the ingestion lifecycle marker:

- `NULL` means the event is pending downstream ingestion.
- A timestamp means the event has been ingested.
- The lifecycle trigger prevents updates that clear `ingested_at` or move it to an earlier timestamp.
- `ingestion_state` is generated from `ingested_at` so operators can filter `pending` versus `ingested` without duplicating state.

Fresh databases create `contract_events` as a ledger range-partitioned table with a default partition. Existing non-partitioned databases receive a `contract_events_partitioned` shadow table and the `ensure_contract_events_partition(start_ledger, end_ledger)` helper so operators can backfill in batches and swap during a controlled maintenance window.

### Indexes

The following indexes are created on the parent table and by the partition helper on each range partition:

#### 1. Composite Index for Replay Queries
```sql
CREATE INDEX idx_contract_events_contract_ledger
ON contract_events (contract_id, ledger, block_height, event_id);
```

**Purpose**: Optimizes the primary replay query pattern that filters by `contract_id` and `ledger`, then orders by `block_height` and `event_id`.

**Query Pattern**:
```sql
SELECT * FROM contract_events
WHERE contract_id = ? AND ledger = ?
ORDER BY block_height, event_id;
```

#### 2. Partial Index for Pending Ingestion
```sql
CREATE INDEX idx_contract_events_pending_ingestion
ON contract_events (contract_id, ledger, block_height)
WHERE ingested_at IS NULL;
```

**Purpose**: Efficiently identifies events that haven't been fully processed (where `ingested_at IS NULL`). This partial index is smaller and faster than a full index.

**Query Pattern**:
```sql
SELECT COUNT(*) FROM contract_events
WHERE contract_id = ? AND ledger = ? AND ingested_at IS NULL;
```

#### 3. Historical Events Replay Index
```sql
CREATE INDEX idx_historical_events_replay
ON historical_events (contract_id, ledger, block_height, event_id);
```

**Purpose**: Speeds up batch fetching from the source table during replay operations.

**Note**: All indexes are created with `CONCURRENTLY` to avoid locking the table during index creation.

### Partition Operations

Create the next ledger partition before a replay enters that range:

```sql
SELECT ensure_contract_events_partition(1000000, 1100000);
```

Recommended rotation:

1. Keep a default partition so unexpected ledger ranges do not fail ingestion.
2. Create the next range partition before replay jobs cross the boundary.
3. Backfill legacy rows into `contract_events_partitioned` in ledger windows, then swap names in a maintenance window.
4. Run retention in dry-run mode first, review the partition list, then detach old partitions after backup verification.

Retention is provided by `enforceContractEventsRetention()` from `src/scripts/db-ops.ts`. It defaults to dry-run:

```typescript
await enforceContractEventsRetention({
  databaseUrl: process.env.DATABASE_URL!,
  retainLedgers: 500000,
});
```

Live detach requires `dryRun: false` and `confirm: true`. Permanent drop additionally requires `backupConfirmed: true`; detach is preferred for routine operations because it preserves the partition table for S3 backup or manual re-attachment.

## Performance Characteristics

### Batch Insert Performance

With `REPLAY_BATCH_SIZE=1000`:
- **Single inserts**: ~100-200 events/second
- **Batch inserts**: ~5,000-10,000 events/second

**50x improvement** in throughput for large replay operations.

### Index Impact

- **Without indexes**: Full table scans, O(n) query time
- **With indexes**: Index scans, O(log n) query time

For a table with 10M events:
- Unindexed query: ~30-60 seconds
- Indexed query: ~10-50 milliseconds

## Security Considerations

### SQL Injection Prevention

All queries use **parameterized statements**:

```typescript
// ✅ SAFE - Parameterized query
await client.query(
  'SELECT * FROM contract_events WHERE contract_id = $1',
  [contractId]
);

// ❌ UNSAFE - String concatenation
await client.query(
  `SELECT * FROM contract_events WHERE contract_id = '${contractId}'`
);
```

### Input Validation

All replay requests are validated:
- `contract_id`: Must be non-empty string
- `ledger`: Must be non-negative integer
- `from_block`: Must be non-negative integer (if provided)
- `to_block`: Must be non-negative integer (if provided)
- `from_block` must be ≤ `to_block`

### Concurrent Operation Prevention

Only one replay can run at a time to prevent:
- Database connection exhaustion
- Memory pressure from multiple large operations
- Conflicting progress tracking

### Transaction Safety

All replay operations run in transactions:
- **Success**: Changes are committed atomically
- **Failure**: All changes are rolled back automatically

### Endpoint Security

The `/internal/indexer/*` endpoints should be protected:

```typescript
// Example: Add authentication middleware
import { authenticate } from './middleware/auth';

app.use('/internal', authenticate);
app.use('/internal/indexer', indexerRouter);
```

## Testing

### Run Tests

```bash
# Run all tests
pnpm test

# Run with coverage
pnpm test:coverage

# Run specific test file
pnpm test tests/indexer/service.replay.test.ts
```

### Test Coverage

The test suite covers:
- ✅ Input validation (invalid contract_id, ledger, blocks)
- ✅ Empty replay sets
- ✅ Batch processing with various sizes
- ✅ Batch boundary alignment
- ✅ Duplicate event handling
- ✅ Concurrent replay prevention
- ✅ Transaction rollback on errors
- ✅ Progress tracking and estimation
- ✅ Block range filtering
- ✅ SQL injection prevention

## Deployment

### Database Migrations

Run migrations before deploying:

```bash
pnpm run migrate
```

This will:
1. Create the initial schema (tables)
2. Add replay optimization indexes
3. Install contract event partition helpers and retention guardrails

### Production Checklist

- [ ] Set `DATABASE_URL` environment variable
- [ ] Configure `REPLAY_BATCH_SIZE` based on load testing
- [ ] Run database migrations
- [ ] Add authentication to `/internal/*` endpoints
- [ ] Set up monitoring for replay operations
- [ ] Configure connection pool size based on load
- [ ] Enable query logging for debugging
- [ ] Set up alerts for failed replays

## Monitoring

### Key Metrics to Track

1. **Replay Duration**: Time to complete full replay
2. **Throughput**: Events processed per second
3. **Error Rate**: Failed replay operations
4. **Database Load**: CPU, memory, connection count during replay
5. **Query Performance**: Slow query log analysis

### Example Monitoring Query

```sql
-- Check replay progress
SELECT 
  COUNT(*) as total_events,
  COUNT(*) FILTER (WHERE ingested_at IS NOT NULL) as ingested,
  COUNT(*) FILTER (WHERE ingested_at IS NULL) as pending
FROM contract_events
WHERE contract_id = 'contract-abc-123' AND ledger = 1;
```

## Troubleshooting

### Replay Times Out

**Symptoms**: Replay operation doesn't complete, database becomes unresponsive

**Solutions**:
1. Reduce `REPLAY_BATCH_SIZE`
2. Add more database resources (CPU, memory)
3. Run replay during off-peak hours
4. Create the next ledger partition before large replays cross a range boundary

### High Memory Usage

**Symptoms**: Application or database runs out of memory

**Solutions**:
1. Reduce `REPLAY_BATCH_SIZE`
2. Increase application heap size
3. Optimize JSONB event_data size

### Slow Queries

**Symptoms**: Replay is slow even with indexes

**Solutions**:
1. Run `ANALYZE contract_events;` to update statistics
2. Check index usage with `EXPLAIN ANALYZE`
3. Run `VACUUM ANALYZE contract_events;` or target the affected ledger partition
4. Verify old partitions are detached or dropped according to the retention policy

### Concurrent Replay Error

**Symptoms**: "Replay operation already in progress" error

**Solutions**:
1. Wait for current replay to complete
2. Check status endpoint: `GET /internal/indexer/status`
3. If stuck, restart the application (state is in-memory)

## Future Enhancements

- [ ] Persistent replay state (Redis/database) for multi-instance deployments
- [ ] Pause/resume replay operations
- [ ] Replay queue for multiple contracts
- [ ] Webhook notifications on replay completion
- [ ] Metrics export (Prometheus format)
- [ ] Automatic retry on transient failures
