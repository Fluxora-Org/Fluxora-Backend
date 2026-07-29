# Contract Event Indexer Documentation

## Overview

The contract event indexer provides efficient replay of historical blockchain events into the `contract_events` table with optimized batch processing and PostgreSQL indexing.

## Features

- **Batch Insert Processing**: Events are inserted in configurable batches to minimize database round-trips
- **Optimized Indexes**: Composite and partial indexes for fast replay queries
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
  event_id VARCHAR(255) PRIMARY KEY,
  contract_id VARCHAR(255) NOT NULL,
  ledger INTEGER NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  event_data JSONB NOT NULL,
  block_height BIGINT NOT NULL,
  transaction_hash VARCHAR(255) NOT NULL,
  ingested_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Indexes

The following indexes are created by migration `001_add_contract_events_replay_indexes`:

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

This is enforced at two layers:
1. **In-process** (`ReplayLock` in `src/indexer/service.ts`): rejects a second concurrent call within the same process instantly, no Redis round-trip required.
2. **Cross-process** (`IndexerLeaderElection` in `src/indexer/leaderElection.ts`): a Redis-backed lease that ensures only one *replica* runs replay at a time in a multi-instance deployment. See "Multi-Replica Leader Election" below.

### Multi-Replica Leader Election

In a multi-replica deployment, every instance shares the same `replay_cursors` table but previously had no way to coordinate *which instance* should actually run a replay — the in-process `ReplayLock` only prevented two concurrent calls on the *same* process. `IndexerLeaderElection` (`src/indexer/leaderElection.ts`) closes that gap with a Redis-backed lease:

- **Acquisition**: `SET NX PX` on a single fixed key (`indexer:leader-election:replay`) — whichever instance sets it first becomes leader for the lease duration (default 15s).
- **Renewal**: the leader renews the lease on a heartbeat (default every `leaseMs / 3`) via `PEXPIRE`, but only after confirming via `GET` that it still holds the key. If another instance's value is found (meaning our lease already lapsed), or the `PEXPIRE` itself fails, we drop leadership immediately.
- **Abort on lease loss**: `replayEvents()` checks `isLeader()` at every batch boundary (the same place it already checks the shutdown `_stopRequested` flag). If leadership is lost mid-replay — most likely because Redis was unreachable for a full lease period — the loop stops cleanly after the in-flight batch's transaction has committed. No connection is left open and no batch is left half-committed.
- **Startup auto-resume**: `resumeIncompleteReplay()` (called once per process on startup) only proceeds if this instance is the leader, so replicas don't all race to resume the same incomplete cursor.
- **Fail-safe default**: when Redis is disabled (`REDIS_ENABLED=false`) or unreachable, `NoOpLeaderElection` is used instead — every instance is always "leader", which is exactly today's single-process behaviour. Multi-replica coordination only activates once Redis is configured.
- **Graceful shutdown**: the lease is released via a `shutdown.ts` hook (`src/app.ts`), after the replay-stop signal is sent but before Redis connections are closed, so another replica can take over promptly instead of waiting out the full lease TTL.

**Operational note — Redis outage**: if Redis becomes unreachable, no instance can acquire or renew the lease, so replay simply does not run anywhere until Redis recovers. This is intentional (fail-safe, not fail-open) — no data is lost, since durable progress lives entirely in `replay_cursors.last_committed_offset`, independent of the lease.

**Security note — non-atomic renew/release**: like the existing `RedisDistributedLock` (`src/state/adminStateLock.ts`), lease renewal and release are check-then-act sequences (`GET` then `PEXPIRE`/`DEL`), not Lua-atomic compare-and-swap. This is an accepted, pre-existing class of risk in this codebase, not a new one introduced here. The worst case is a brief window — bounded by `renewIntervalMs` — where two instances both believe they are leader. Because every batch INSERT already uses `ON CONFLICT (event_id) DO NOTHING` (see "Idempotency" above), a second instance briefly replaying the same range produces no duplicate rows, so this window cannot corrupt data — only cause temporarily duplicated (but harmless) work.

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
- ✅ Duplicate event handling and `HybridDedupCache` downtime fallback
- ✅ Property-based test suite verifying duplicate suppression invariants during Redis downtime
- ✅ Concurrent replay prevention
- ✅ Transaction rollback on errors
- ✅ Progress tracking and estimation
- ✅ Block range filtering
- ✅ SQL injection prevention

## Duplicate Event Suppression & Resiliency

`streamEventService` ingests Soroban RPC streaming events and enforces strict duplicate suppression using an injectable `DedupCache` interface (`InMemoryDedupCache`, `RedisDedupCache`, or `HybridDedupCache`).

### Hybrid Cache & Redis Downtime Fallback

When configured with `HybridDedupCache`:
1. **Primary Cache**: Interacts with Redis (`RedisDedupCache`) to track event keys (`fluxora:dedup:<streamId>:<eventId>`) across server restarts.
2. **Fallback Cache**: Local in-memory cache (`InMemoryDedupCache`) tracking event arrivals.
3. **Outage State Transitions (`available` → `unavailable` → `recovered`)**:
   - **Normal Operation (`available`)**: Events are checked/added in Redis. On new additions, `HybridDedupCache` syncs to the local in-memory fallback cache.
   - **Redis Outage (`unavailable`)**: If Redis throws connection errors mid-sequence, `HybridDedupCache` catches the error, logs a throttled fallback warning (`dedup:fallback`), increments Prometheus metric `dedup_redis_fallback_total`, and seamlessly uses the in-memory cache. Replay continues without throwing errors or dropping events.
   - **Redis Recovery (`recovered`)**: When Redis becomes reachable again, `HybridDedupCache` checks the fallback cache first. Any event processed during the outage remains suppressed, preventing duplicate database writes upon Redis reconnection. New events sync to both primary and fallback caches.

### Core Invariants

The deduplication layer guarantees the following invariant regardless of event arrival order, duplicate burst frequency, or intermittent Redis downtime timing:

> **"Each distinct `(transactionHash, eventIndex)` pair triggers at most one database write operation (upsert/update) and at most one WebSocket broadcast."**

### Property-Based Testing

Deduplication behavior and outage recovery are verified using property-based testing powered by `fast-check` in [streamEventService.dedup.test.ts](file:///c:/Users/ICT%20LASIEC/Fluxora-Backend/tests/services/streamEventService.dedup.test.ts):

- **Randomized Replay Sequences**: Generates sequences of `StreamCreated`, `StreamUpdated`, and `StreamCancelled` events with randomized `transactionHash` and `eventIndex`.
- **Dynamic Outage Simulation**: Mocks `HybridDedupCache` under fluctuating Redis states (`available`, `unavailable`, `recovered`) and interleaved duplicate bursts.
- **Deterministic CI Configuration**: Configured with a fixed seed (`seed: 42`) and bounded runs (`numRuns: 100`) to ensure 100% reproducible test outcomes in CI without flaky behavior.
- **Explicit Edge Case Coverage**: Includes unit tests for empty replays, single events, all duplicates, all unique events, duplicate bursts, alternating duplicates, pre-start outages, mid-sequence outages, full outages, and post-outage recoveries.

## Deployment

### Database Migrations

Run migrations before deploying:

```bash
pnpm run migrate
```

This will:
1. Create the initial schema (tables)
2. Add replay optimization indexes

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

### Catch-up Telemetry

When the indexer falls behind the Stellar RPC ledger tip (after a restart or extended stall), the following telemetry provides visibility into catch-up progress:

#### Prometheus Metrics

- **`indexer_ledger_lag`** (Gauge): Current ledger lag in ledgers (tip - last_indexed_ledger). 0 when caught up.
- **`indexer_catchup_eta_seconds`** (Gauge): Estimated seconds until catch-up completion. 0 when not lagging or insufficient data.

#### Health Endpoint Response

The `/health` endpoint includes catch-up telemetry in the response:

```json
{
  "status": "ok",
  "service": "fluxora-backend",
  "timestamp": "2026-07-29T18:30:00.000Z",
  "indexer": {
    "status": "healthy",
    "stalled": false,
    "thresholdMs": 300000,
    "lastSuccessfulSyncAt": "2026-07-29T18:29:00.000Z",
    "lagMs": 60000,
    "summary": "Indexer checkpoint is within the allowed freshness threshold"
  },
  "dependencies": {
    "indexer": {
      "dependency": "healthy",
      "store": "memory",
      "lastSuccessfulIngestAt": "2026-07-29T18:29:00.000Z",
      "isReplaying": false,
      "catchupTelemetry": {
        "ledgerLag": 50,
        "catchupEtaSeconds": 300,
        "lastIndexedLedger": 950,
        "lastLedgerLagUpdateAt": "2026-07-29T18:30:00.000Z"
      }
    }
  },
  "catchupTelemetry": {
    "ledgerLag": 50,
    "catchupEtaSeconds": 300,
    "lastIndexedLedger": 950,
    "lastLedgerLagUpdateAt": "2026-07-29T18:30:00.000Z"
  }
}
```

#### Fields

- **`ledgerLag`**: Number of ledgers the indexer is behind the Stellar RPC tip
- **`catchupEtaSeconds`**: Estimated seconds until catch-up completion (null if not lagging or insufficient data)
- **`lastIndexedLedger`**: The last ledger sequence number successfully indexed
- **`lastLedgerLagUpdateAt`**: ISO-8601 timestamp of the last ledger lag computation

#### ETA Estimation

The ETA is computed using a rolling average of recently indexed ledgers/second (last 10 samples), not a naive linear extrapolation from a single sample. This provides more accurate estimates that smooth out temporary throughput variations.

**Note**: ETA is `null` when:
- The indexer is caught up (ledgerLag = 0)
- Insufficient throughput data exists (first ingest after restart)
- RPC calls fail (graceful degradation - keeps last known values)

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
4. Consider partitioning large replays by block range

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
3. Consider vacuuming the table: `VACUUM ANALYZE contract_events;`

### Concurrent Replay Error

**Symptoms**: "Replay operation already in progress" error

**Solutions**:
1. Wait for current replay to complete
2. Check status endpoint: `GET /internal/indexer/status`
3. If stuck, restart the application (state is in-memory)

## Future Enhancements

- [x] Persistent replay state (Redis/database) for multi-instance deployments — see "Multi-Replica Leader Election" above
- [ ] Pause/resume replay operations
- [ ] Replay queue for multiple contracts
- [ ] Webhook notifications on replay completion
- [ ] Metrics export (Prometheus format)
- [ ] Automatic retry on transient failures


---

## gRPC Transcoding Gateway

The optional gRPC gateway (`src/indexer/grpcGateway.ts`) exposes the same
replay and ingest operations as the HTTP routes, but over a binary gRPC
transport.  It is designed for **in-cluster service-to-service** calls where
lower overhead and strong typing are preferred.

### Enabling the gateway

The gateway is **off by default** so existing HTTP-only deployments are
unaffected.  Set the following environment variables to enable it:

| Variable | Default | Description |
|---|---|---|
| `GRPC_GATEWAY_ENABLED` | `false` | Set to `true` to start the gateway |
| `GRPC_GATEWAY_PORT` | `50052` | Port the gRPC server binds to |

```bash
GRPC_GATEWAY_ENABLED=true
GRPC_GATEWAY_PORT=50052
```

> **Note:** The gateway must **not** be exposed outside the cluster.
> It binds to `0.0.0.0` and relies on network-level isolation (Kubernetes
> NetworkPolicies, VPC security groups, etc.) for perimeter security.

### Authentication

Every RPC must include a `worker_token` metadata header containing the same
secret as `INDEXER_WORKER_TOKEN`.  Tokens are compared with a **constant-time
equality check** to prevent timing-oracle attacks.

```bash
# grpcurl example
grpcurl \
  -plaintext \
  -H 'worker_token: <INDEXER_WORKER_TOKEN>' \
  -d '{}' \
  localhost:50052 \
  fluxora.indexer.v1.IndexerService/GetReplayStatus
```

### Service definition (proto)

The proto schema is kept inline in `src/indexer/grpcGateway.ts` (same pattern
as `src/health/grpcHealth.ts`) so the production Docker image does not need to
ship `.proto` files.

```protobuf
syntax = "proto3";
package fluxora.indexer.v1;

service IndexerService {
  // Ingest a batch of contract events from the chain worker.
  rpc IngestContractEvents(IngestContractEventsRequest)
      returns (IngestContractEventsResponse);

  // Replay stored events with optional filtering.
  rpc GetEvents(GetEventsRequest) returns (GetEventsResponse);

  // Trigger a historical DB backfill for a given contract/ledger range.
  rpc ReplayEvents(ReplayEventsRequest) returns (ReplayEventsResponse);

  // Return current replay progress.
  rpc GetReplayStatus(GetReplayStatusRequest) returns (GetReplayStatusResponse);
}
```

### RPC reference

#### `IngestContractEvents`

Ingests a batch of on-chain contract events.  Delegates to
`indexerIngestionService.ingest()` — the same handler as
`POST /internal/indexer/contract-events`.

**Metadata:** `worker_token` required.

#### `GetEvents`

Paginated read of stored events.  Supports both cursor-based pagination
(`after_event_id`) and offset-based pagination (`limit` / `offset`).
Delegates to `indexerIngestionService.getEvents()`.

**Metadata:** `worker_token` required.

#### `ReplayEvents`

Triggers a historical DB backfill.  The RPC returns immediately with the
current progress snapshot; the actual replay runs asynchronously in the
background, mirroring the fire-and-forget behaviour of
`POST /internal/indexer/events/replay`.

**Metadata:** `worker_token` required.

#### `GetReplayStatus`

Returns the extended replay progress (reads from the `replay_cursors` DB table
when available, falls back to in-memory state).  Delegates to
`indexerService.getReplayProgressExtended()`.

**Metadata:** `worker_token` required.

### Security considerations

- The gateway **re-uses all existing validation and business logic** — no
  duplicated code paths.
- Input validation for `ReplayEvents` uses the same `ReplayRequestSchema` Zod
  schema as the HTTP route; invalid input is rejected with
  `INVALID_ARGUMENT`.
- Token comparison is constant-time (`XOR` over char codes) to prevent
  timing attacks.
- The server binds with `ServerCredentials.createInsecure()`.  In-cluster
  mTLS should be enforced at the service mesh layer (Istio / Linkerd) rather
  than at the application level.

### Shutdown

The gateway participates in graceful shutdown via `stopGrpcGatewayServer()`,
which mirrors the force-close fallback in `src/health/grpcHealth.ts`:
in-flight calls have up to 5 s to drain before a forced shutdown.
