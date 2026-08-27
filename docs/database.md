# Database Connection Pool

## Overview

Fluxora Backend uses a `pg.Pool` (node-postgres) for all database access. The pool is configured via environment variables and includes proactive exhaustion detection to prevent unbounded request queuing.

## Typed Row Mapping

`pg.Pool.query<T>()` / `PoolClient.query<T>()` constrain `T` to `QueryResultRow` (an index signature). **Do not** pass bare domain interfaces (`ReplayCursor`, `ContractEvent`, `VacuumRow`, `StreamRecord`, …) as that generic — they fail `tsc` with `TS2344`.

**Required pattern** (already used in `streamRepository`, `apiKeyRepository`, `dlqRepository`):

1. Query with `Record<string, unknown>` (or omit the generic).
2. Map each row through an explicit `rowToX()` helper into the domain type.

```ts
const result = await client.query<Record<string, unknown>>(sql, params);
return result.rows.map(rowToReplayCursor);
```

Full convention: [`src/db/repositories/README.md`](../src/db/repositories/README.md).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `DB_POOL_MIN` | `2` | Minimum idle connections kept alive |
| `DB_POOL_MAX` | `10` | Maximum total connections |
| `DB_CONNECTION_TIMEOUT` | `5000` | ms to wait for a connection before timing out |
| `DB_IDLE_TIMEOUT` | `30000` | ms before an idle connection is closed |
| `POOL_QUEUE_LIMIT` | `50` | Max requests allowed to queue before fast-failing with 503 |
| `STATEMENT_TIMEOUT_MS` | `5000` | Per-connection statement timeout in ms. Set to `0` to disable. |

## Statement Timeout

### How it works

On every new physical connection, the pool's `connect` event fires `SET statement_timeout = $1` with the value of `STATEMENT_TIMEOUT_MS`. This applies a session-level limit so any query that runs longer than the configured duration is automatically canceled by PostgreSQL with error code `57014` (`query_canceled`).

```
new connection established
       │
       ▼
SET statement_timeout = STATEMENT_TIMEOUT_MS
       │
       ▼
connection ready for queries
       │
       ▼
query exceeds timeout?
       │
      YES ──► PG error 57014 → QueryTimeoutError → HTTP 504 Gateway Timeout
       │
       NO
       │
       ▼
  result returned normally
```

### Disabling the timeout

Set `STATEMENT_TIMEOUT_MS=0` to skip the `SET statement_timeout` call entirely. This is useful for long-running maintenance scripts or migrations that should not be interrupted.

### Error mapping

| PG error code | Error class | HTTP status |
|---|---|---|
| `57014` (query_canceled) | `QueryTimeoutError` | `504 Gateway Timeout` |

### Security note

Using a parameterized query (`SET statement_timeout = $1`) prevents SQL injection. The timeout value is validated as a non-negative integer by the `integerEnv` schema helper before it reaches the pool.

## Pool Exhaustion Detection

### How it works

When a query is submitted, the pool checks `pool.waitingCount` against `POOL_QUEUE_LIMIT` **before** attempting to acquire a connection. If the waiting queue has reached the limit, the request is rejected immediately with a `PoolExhaustedError` rather than queuing indefinitely.

```
incoming request
       │
       ▼
waitingCount >= POOL_QUEUE_LIMIT?
       │
      YES ──► PoolExhaustedError (503) + log pool_exhausted + increment counter
       │
       NO
       │
       ▼
  acquire connection → execute query
```

### Why queue-limit instead of total-count

Checking `waitingCount >= POOL_QUEUE_LIMIT` is more accurate than checking `totalCount >= max`. A full pool with zero waiting requests is healthy — all connections are actively serving queries. The queue length is the real saturation signal.

## Structured Logging

Every exhaustion event emits a structured `warn` log:

```json
{
  "timestamp": "2026-05-28T13:00:00.000Z",
  "level": "warn",
  "message": "Postgres pool exhausted",
  "event": "pool_exhausted",
  "total": 10,
  "idle": 0,
  "waiting": 50,
  "queueLimit": 50
}
```

## Prometheus Metrics

Four metrics are exposed via the `/metrics` endpoint:

| Metric | Type | Description |
|---|---|---|
| `db_pool_active_connections` | Gauge | Checked-out (in-use) connections |
| `db_pool_idle_connections` | Gauge | Idle connections in the pool |
| `db_pool_waiting_requests` | Gauge | Requests waiting for a connection |
| `db_pool_exhausted_total` | Counter | Total requests rejected due to queue limit |

Gauges are updated on every `connect`, `acquire`, and `remove` pool event.

## Pool Events

| Event | Trigger | Action |
|---|---|---|
| `connect` | New physical connection opened | Apply `statement_timeout`, sync gauges, debug log |
| `acquire` | Connection checked out | Sync gauges |
| `remove` | Connection closed/removed | Sync gauges, debug log |
| `error` | Idle client error | Error log |

## Caller Behaviour

`PoolExhaustedError` should be mapped to an HTTP `503 Service Unavailable` response. `QueryTimeoutError` should be mapped to an HTTP `504 Gateway Timeout` response. Both are handled automatically by the error handler in `src/middleware/errorHandler.ts`.

## Operator Runbook

### Symptoms

- `db_pool_exhausted_total` counter is increasing
- `db_pool_waiting_requests` gauge is consistently at or near `POOL_QUEUE_LIMIT`
- API returning `503` responses on database-backed routes

### Triage steps

1. Check `db_pool_active_connections` — if it equals `DB_POOL_MAX`, the pool is fully saturated.
2. Check for slow queries: look for `"message": "Slow postgres query"` in logs.
3. Consider increasing `DB_POOL_MAX` if the database server can handle more connections.
4. Consider increasing `POOL_QUEUE_LIMIT` if bursts are short-lived and acceptable to queue.
5. Check for connection leaks: if `db_pool_active_connections` stays high after traffic drops, a caller may not be releasing connections.

### Partition Management

The `contract_events` table is partitioned by `happened_at` to ensure bounded growth. Partition management must be performed periodically to drop old data:
1. Ensure `dropOldPartitions` from `src/scripts/db-ops.ts` is scheduled via cron or a periodic job.
2. The function should be invoked with the retention period (e.g., 30 days).
3. The job must run with a database role that has permissions to execute `DROP TABLE`.
4. Validate that detached partitions are backed up per the existing S3 retention policy before actually dropping them.
5. Run the function in `dryRun = true` mode initially to audit partitions that will be dropped.

### Partition Pre-creation

To avoid rows landing in the unindexed `DEFAULT` partition, the background job `src/jobs/partitionMaintenance.ts` pre-creates monthly partitions ahead of schedule for every range-partitioned table it manages.

#### Managed tables

| Table | Managed today? | Notes |
|---|---|---|
| `contract_events` | Yes | Range-partitioned since `20260627000000_contract_events_partitioning.ts` |
| `audit_logs` | Not yet | Currently a plain table (see `1774715200000_audit-and-webhook-outbox.ts`). The job detects partitioning automatically at runtime — once `audit_logs` is migrated to `PARTITION BY RANGE`, this job starts managing it with no code change required. |

The job checks each table via `pg_class.relkind = 'p'` + `pg_partitioned_table.partstrat = 'r'` before touching it; a table that is not range-partitioned is skipped silently (logged at `debug`, not an error).

#### Partition naming

Monthly partitions are named `<table>_y<YYYY>m<MM>` (e.g. `contract_events_y2026m07`), matching the convention already used by `tests/db/contractEvents.partitionPruning.test.ts` and `tests/db/vacuumCollector.collect.test.ts`. Month boundaries are computed in **UTC** (`Date.UTC(...)`) to avoid off-by-one errors near midnight on a server running in a non-UTC timezone.

#### Schedule and idempotency

1. The job runs on a daily cron schedule (`0 0 * * *`) and once immediately at process startup (`src/jobs/queue.ts`), pre-creating the current month plus the next `monthsAhead` months (default `3`, see `DEFAULT_MONTHS_AHEAD` in `src/jobs/partitionMaintenance.ts`).
2. It acquires a single **non-blocking** advisory lock (`pg_try_advisory_lock(123456789)`, exported as `PARTITION_MAINTENANCE_LOCK_ID`) before doing any work. If another instance already holds the lock, the run is a no-op — it does not wait or retry, so overlapping cron + manual invocations across multiple app instances never race to create the same partition.
3. Every `CREATE TABLE` uses `IF NOT EXISTS`, so re-running the job when all partitions already exist performs zero DDL and is always a safe no-op — the defining idempotency property required of this job.
4. The lock is released in a `finally` block, so a failure partway through (e.g. one table's DDL fails) never leaves the lock held for subsequent runs.

#### Behind-schedule alerting

Every run checks whether the **current month's** partition already existed *before* this run created it. Since the job pre-creates months in advance, the current month's partition should already exist by the time it becomes current — if it's still missing, an earlier scheduled run was missed or failed, and rows for today may have already been landing in the unindexed `DEFAULT` partition.

When this happens, the job:

- Emits a structured `error`-level log:
  ```json
  {
    "event": "partition_maintenance_behind_schedule",
    "table": "contract_events",
    "partition": "contract_events_y2026m07",
    "level": "error",
    "message": "Partition maintenance fell behind schedule: current-month partition was missing"
  }
  ```
- Increments the `fluxora_partition_maintenance_behind_schedule_total{table="..."}` counter.
- Still creates the missing partition immediately afterward (self-healing) — the alert reports a `DEFAULT`-partition risk window that already occurred, it does not prevent the fix.

##### Recommended alert

```yaml
- alert: PartitionMaintenanceBehindSchedule
  expr: increase(fluxora_partition_maintenance_behind_schedule_total[1d]) > 0
  severity: critical
  annotations:
    summary: "A scheduled partition pre-creation run was missed — rows may have landed in the DEFAULT partition"
```

#### Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `fluxora_partitions_created_total` | Counter | `table` | Incremented once per partition actually created (idempotent no-ops are not counted) |
| `fluxora_partition_maintenance_behind_schedule_total` | Counter | `table` | Incremented when the current-month partition was found missing (see above) |

#### Security

- Table names come exclusively from the developer-controlled `CANDIDATE_TABLES` constant, never from user input.
- Partition names are derived deterministically from the table name and a UTC year/month, and are additionally passed through `quoteIdentifier()` before being interpolated into DDL (defence-in-depth against a future change widening the input surface).
- Partition bound literals are ISO-8601 UTC timestamps produced by `Date#toISOString()`, validated against a strict regex before interpolation — the `pg` driver cannot parameterize DDL bound expressions, so this validation substitutes for parameterization.
- The job's DB principal needs `CREATE` on the parent table only; no superuser privileges are required.

#### Tests

`tests/jobs/partitionMaintenance.test.ts` covers: lock acquisition/skip/release (including release-on-throw), input validation, per-table managed/unmanaged gating, idempotent re-runs, partition naming (including year rollover and UTC boundary edge cases), behind-schedule detection and metrics, and identifier-quoting security checks — all against a mocked `Pool`, no live database required.

```bash
pnpm test tests/jobs/partitionMaintenance.test.ts
```

### Recommended alert thresholds

```yaml
# Alert when exhaustion events occur
- alert: DbPoolExhausted
  expr: increase(db_pool_exhausted_total[5m]) > 0
  severity: warning

# Alert when waiting queue is consistently high
- alert: DbPoolQueueHigh
  expr: db_pool_waiting_requests > 20
  for: 2m
  severity: warning
```

## Logical Replication for contract_events

### Overview & Architecture

Fluxora provides PostgreSQL logical replication as an enterprise streaming mechanism for external consumers to tail real-time chain events directly from the database. Logical replication provides a high-throughput, push-based alternative to polling `GET /internal/indexer/events` (`src/routes/indexer.ts`).

Migration: `migrations/20260723180000_contract_events_logical_replication.ts`
Tests: `tests/db/logicalReplication.test.ts`

### Publication Scope & Security

The publication `fluxora_contract_events_pub` is narrowly scoped to ensure data isolation and security:

- **Single Table Scope**: Scoped exclusively to the `contract_events` table. Tables containing Personally Identifiable Information (PII) or sensitive tokens (such as `streams`, `api_keys`, or `webhook_outbox`) are explicitly excluded from replication.
- **Append-Only Operations**: Configured with `WITH (publish = 'insert')`. Since `contract_events` is an append-only event ledger, restricting publication strictly to `INSERT` operations eliminates unnecessary WAL replication overhead for table maintenance and prevents exposing operational updates or deletes.

### Partition Awareness

`contract_events` is a range-partitioned table (`PARTITION BY RANGE happened_at`). The publication uses `FOR TABLE contract_events` — **without `ONLY`** — so that INSERT changes from all child partitions (e.g., `contract_events_y2026m07`, `contract_events_default`) flow through the publication automatically as new monthly partitions are created.

> [!NOTE]
> Using `FOR TABLE ONLY contract_events` would silently publish nothing because all rows live in child partitions, not the parent table. Never add `ONLY` to this publication.

By default (PostgreSQL 15+), `publish_via_partition_root = true` causes the WAL decoder to report all partition rows under the parent `contract_events` table identity. This simplifies consumer schema management — consumers see a single `contract_events` stream regardless of which monthly partition holds the row. For PostgreSQL 12–14, rows are reported under their respective child partition names.

### Prerequisites & Server Configuration

To support logical replication, the primary PostgreSQL instance must be configured with the following parameters in `postgresql.conf`:

| Parameter | Required Value | Description |
|---|---|---|
| `wal_level` | `logical` | Enables logical decoding and WAL retention for replication slots. *Requires database server restart.* |
| `max_replication_slots` | `>= 5` | Maximum number of concurrent replication slots supported by the server. |
| `max_wal_senders` | `>= 5` | Maximum number of concurrent WAL sender processes. |

Additionally, external streaming consumers require a database role with the `REPLICATION` attribute (or membership in `pg_read_all_data` along with table-level `SELECT` permissions on `contract_events`).

### Operational Steps to Attach a Replication Slot

#### 1. Validate Server Configuration

Ensure `wal_level` is set to `logical`:

```sql
SHOW wal_level;
-- Expected output: logical
```

#### 2. Create the Logical Replication Slot

Connect to the primary database as an administrative or replication user and create a replication slot using the standard `pgoutput` plugin:

```sql
SELECT pg_create_logical_replication_slot('fluxora_contract_events_slot', 'pgoutput');
```

#### 3. Connect External Streaming Consumer

Configure your streaming consumer (e.g., Debezium, Kafka Connect Postgres Source, or custom `pgoutput` consumer) with the following connection properties:

- **Publication Name**: `fluxora_contract_events_pub`
- **Replication Slot Name**: `fluxora_contract_events_slot`
- **Plugin**: `pgoutput`
- **Tables**: `contract_events`

#### 4. Monitor Active Connections

Verify that the consumer has attached and is actively consuming WAL streams:

```sql
SELECT
  pid,
  usename,
  application_name,
  client_addr,
  state,
  sync_state,
  sent_lsn,
  write_lsn,
  flush_lsn,
  replay_lsn
FROM pg_stat_replication;
```

### Operational Impact & Primary Health Monitoring

#### Slot Lag & Disk Growth Risk

A PostgreSQL logical replication slot guarantees zero data loss by preserving write-ahead logs (WAL) on the primary database until the consumer confirms receipt (`confirmed_flush_lsn`). 

> [!WARNING]
> If a streaming consumer disconnects or fails to acknowledge WAL data, PostgreSQL will retain all unconsumed WAL segments on disk. If left unmonitored, an inactive slot can lead to rapid primary disk growth and eventual disk space exhaustion.

#### Monitoring Slot Lag in Bytes

Operators must monitor replication lag via `pg_replication_slots`:

```sql
SELECT
  slot_name,
  plugin,
  active,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS lag_bytes,
  pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes_raw
FROM pg_replication_slots
WHERE slot_name = 'fluxora_contract_events_slot';
```

#### Stale Slot Cleanup Runbook

If a consumer is decommissioned or experiences an extended outage and lag exceeds safety thresholds (e.g., > 10 GB):

1. Check if the slot is active: `SELECT active FROM pg_replication_slots WHERE slot_name = 'fluxora_contract_events_slot';`
2. If `active = false` and disk usage is critical, drop the slot to free retained WAL segments:
   ```sql
   SELECT pg_drop_replication_slot('fluxora_contract_events_slot');
   ```
3. *Note*: Dropping a slot requires the external consumer to perform a full re-snapshot when re-attaching.

#### Recommended Prometheus Alerts

```yaml
# Alert when a replication slot falls behind by more than 5 GB
- alert: PostgresReplicationSlotLagHigh
  expr: pg_replication_slots_bytes_behind{slot_name="fluxora_contract_events_slot"} > 5368709120
  for: 5m
  severity: warning

# Alert when a replication slot is inactive while lag accumulates
- alert: PostgresReplicationSlotInactive
  expr: pg_replication_slots_active{slot_name="fluxora_contract_events_slot"} == 0
  for: 10m
  severity: warning
```

### Running the Live Integration Tests

The test suite in `tests/db/logicalReplication.test.ts` contains both offline unit tests (always run) and live-DB integration tests (require a real Postgres instance with `wal_level=logical`).

Live tests are guarded by `INTEGRATION_DB=true` so they are **never triggered accidentally** by the test setup placeholder `DATABASE_URL`:

```bash
# Run live DB tests against a real database
INTEGRATION_DB=true \
DATABASE_URL=postgresql://indexer_user:indexer_password@localhost:5432/indexer_db \
pnpm test tests/db/logicalReplication.test.ts
```

The live suite verifies:
- `fluxora_contract_events_pub` exists in `pg_publication` with `pubinsert=true`, `pubupdate=false`, `pubdelete=false`, `pubtruncate=false`
- The publication is attached **solely** to `contract_events` (verified via `pg_publication_tables`)
- `down()` fully removes the publication; `up()` re-applies it cleanly (rollback/re-apply cycle)

---

## PgBouncer / PgCat Transaction-Pooling Compatibility (issue #754)

At higher connection scale operators commonly front PostgreSQL with
[PgBouncer](https://www.pgbouncer.org/) or
[PgCat](https://github.com/levkk/pgcat) in **transaction-pooling mode**
(`pool_mode = transaction`). This mode returns the server connection to the
pooler after every transaction rather than keeping it pinned for the
lifetime of the client connection, enabling many more app connections than
Postgres server connections.

### Why transaction-pooling is incompatible with the default pool setup

Two features of a plain `pg.Pool` are session-scoped and silently break under
transaction pooling:

| Feature | Session mode | Transaction mode |
|---|---|---|
| `SET statement_timeout = $1` on `connect` | ✅ Works — persists for connection lifetime | ❌ Silently lost — pooler resets session on each transaction boundary |
| pg driver prepared-statement cache | ✅ Works | ❌ PgBouncer rejects `PREPARE` / `EXECUTE` |

### ⚠ Silent failure mode

If you are running behind a transaction pooler but `POOL_MODE` is **not** set
to `transaction`, the `SET statement_timeout` call succeeds from the app's
perspective but is silently discarded by PgBouncer. Queries run **without
any application-side timeout**. This is not a crash — it is a silent
correctness failure. Setting `POOL_MODE=transaction` explicitly acknowledges
and handles this condition.

### Configuration

Set the `POOL_MODE` environment variable:

```bash
# Session pooling (default — direct Postgres connection or session pooler)
POOL_MODE=session

# Transaction pooling — use when PgBouncer/PgCat is in transaction mode
POOL_MODE=transaction
```

When `POOL_MODE=transaction`:

- The `connect` hook skips `SET statement_timeout`. Configure
  `statement_timeout` at the pooler layer instead (e.g., pgbouncer.ini
  `server_reset_query` or `ALTER ROLE app_user SET statement_timeout = '5s'`).
- A startup warning is logged with `event: pool_transaction_mode_active`.

### Local verification with Docker Compose

A `pgbouncer` Docker Compose profile is provided for local testing:

```bash
# Start Postgres + PgBouncer in transaction mode
docker compose --profile pgbouncer up -d

# Connect through PgBouncer (port 6432)
DATABASE_URL=postgresql://indexer_user:indexer_password@localhost:6432/indexer_db \
  POOL_MODE=transaction \
  pnpm dev
```

The PgBouncer container (`bitnami/pgbouncer:1.22.0`) is configured with
`PGBOUNCER_POOL_MODE=transaction` and `PGBOUNCER_DEFAULT_POOL_SIZE=20`.
Port `6432` is bound to `127.0.0.1` only.

### API

```typescript
import { isTransactionPoolMode } from './src/db/pool.js';

// Check if the active pool is in transaction mode
if (isTransactionPoolMode()) {
  // Do not rely on session-scoped state
}
```

### Environment variable reference

| Variable | Values | Default | Description |
|---|---|---|---|
| `POOL_MODE` | `session` \| `transaction` | `session` | Pool compatibility mode. Set to `transaction` when using PgBouncer/PgCat in transaction-pooling mode. |

---

## Partition Pruning for `contract_events`

### Overview & Range Partitioning Strategy

The `contract_events` table is partitioned by range on `happened_at` (`PARTITION BY RANGE (happened_at)`) per migration `20260627000000_contract_events_partitioning.ts`. Range partitioning bounds disk growth and enables aggressive partition pruning during historical range queries.

### Query Predicate Requirements & Pruning Behavior

PostgreSQL partition pruning is driven by predicates on the partition key (`happened_at`). When `StreamEventReplayFilter` query parameters (`fromHappenedAt`, `toHappenedAt`) are passed to `PostgresContractEventStore.getEvents()`, PostgreSQL's query planner automatically prunes non-overlapping partition tables from the execution plan.

- **Single-Partition Bounded Queries**: Queries bounded to a single month (e.g. `happened_at >= '2026-07-01T00:00:00.000Z' AND happened_at <= '2026-07-31T23:59:59.999Z'`) evaluate to an execution plan containing strictly the target partition (e.g., `contract_events_y2026m07`). Other partitions (`contract_events_y2026m06`, `contract_events_y2026m08`, `contract_events_default`) are pruned and omitted from disk scans.
- **Cross-Partition Range Queries**: Queries spanning multiple partition boundaries (e.g., `happened_at >= '2026-06-15T00:00:00.000Z' AND happened_at <= '2026-07-15T23:59:59.999Z'`) scan only the specific matching partitions (`contract_events_y2026m06` and `contract_events_y2026m07`), excluding irrelevant partitions.

### Verification via EXPLAIN

Partition pruning efficiency is verified via integration tests
(`tests/db/contractEvents.partitionPruning.test.ts`) that execute
`EXPLAIN (FORMAT JSON)` against representative store query shapes and inspect
the plan output structure.

#### Test coverage

| Test category | Description |
|---|---|
| **Offline — plan helpers** | `planScansPartition` / `getScannedPartitions` unit-tested against mock EXPLAIN JSON — no database required |
| **Offline — InMemoryStore** | `InMemoryContractEventStore.getEvents()` filter parity: single-partition range, cross-partition range, no-filter |
| **Live DB — single-partition EXPLAIN** | Bounded July query scans **only** `contract_events_y2026m07`; June and August partitions are pruned from the plan |
| **Live DB — cross-partition EXPLAIN** | June-to-July range scans **exactly** `contract_events_y2026m06` and `contract_events_y2026m07`; August is pruned |
| **Live DB — August-only EXPLAIN** | Bounded August query scans **only** `contract_events_y2026m08` |
| **Live DB — store correctness** | `PostgresContractEventStore.getEvents()` returns the expected seed rows and excludes out-of-range rows |
| **Live DB — ON CONFLICT idempotency** | Re-inserting an existing `(happened_at, event_id)` pair is a silent no-op (reported as `duplicateEventIds`) |

#### Running the live tests

```bash
DATABASE_URL=postgresql://indexer_user:indexer_password@localhost:5432/indexer_db \
  pnpm test tests/db/contractEvents.partitionPruning.test.ts
```

Offline-only (no database):

```bash
pnpm test tests/db/contractEvents.partitionPruning.test.ts
```

#### `store.ts` — ON CONFLICT target

Because `contract_events` is range-partitioned and its primary key is
`(happened_at, event_id)`, the `INSERT … ON CONFLICT` clause in
`PostgresContractEventStore.insertMany()` must specify **both** columns:

```sql
ON CONFLICT (happened_at, event_id) DO NOTHING
```

Using only `(event_id)` raises a PostgreSQL error
(`there is no unique or exclusion constraint matching the ON CONFLICT
specification`) on partitioned tables and was corrected as part of issue #932.

---

## Background Job Queue (pg-boss)

### Overview

Fluxora uses [pg-boss](https://github.com/timgit/pg-boss) for Postgres-backed background job processing. pg-boss provides durable, at-least-once job delivery with built-in retry, exponential backoff, cron scheduling, and dead letter queues — all within PostgreSQL.

### The JobQueue Class

Located at `src/jobs/queue.ts`, the `JobQueue` class wraps pg-boss and integrates with the application's existing `pg.Pool`:

```typescript
import { JobQueue, getJobQueue, setJobQueue } from './src/jobs/queue.js';

const queue = new JobQueue(pool);
setJobQueue(queue);
```

### Configuration

pg-boss creates its own lightweight connection pool (2–4 connections, derived from the application pool's `max`). It uses the `pgboss` schema inside the same PostgreSQL database.

Retry and expiration settings can be configured per job registration or per send:

| Option | Default | Description |
|---|---|---|
| `retryLimit` | `2` | Max retries before the job is dead-lettered |
| `retryDelay` | `60` | Base delay in seconds between retries |
| `retryBackoff` | `true` | Exponential backoff enabled by default |
| `retryDelayMax` | — | Cap for backoff-delay growth |
| `expireInSeconds` | `900` | Max seconds a job may stay in active state |
| `deadLetter` | — | Queue name to route terminally-failed jobs to |

### Job Handler Registration

Handlers are registered by name before the queue is started:

```typescript
queue.register('send-email', async (ctx) => {
  const { id, data } = ctx;
  await emailService.send(data);
}, {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
});
```

The handler receives a `JobHandlerContext` with `id`, `name`, and `data`. Throwing from the handler triggers pg-boss's retry mechanism.

### Sending Jobs

```typescript
await queue.send('send-email', { to: 'user@example.com', template: 'welcome' }, {
  retryLimit: 3,
  deadLetter: 'job_dead_letter_queue',
});
```

### Scheduling with Cron

```typescript
await queue.schedule('partition-maintenance', '0 0 * * *', undefined, {
  retryLimit: 2,
  retryDelay: 60,
});
```

### Retry and Dead Letter Behavior

1. If a handler throws, pg-boss retries the job with exponential backoff (`retryDelay * 2^retryCount` with jitter).
2. After exhausting `retryLimit` retries, the job is moved to the configured dead letter queue (`deadLetter` option).
3. A custom `job_dead_letter` table (see migration below) stores additional metadata about failed jobs for operational inspection.

### Lifecycle

```typescript
await queue.start();  // Begins processing — registers work handlers
await queue.stop();   // Graceful shutdown — stops workers and releases resources
```

### Singleton Access

The module exports `getJobQueue()` / `setJobQueue()` following the same pattern as `pool.ts`:

```typescript
import { getJobQueue } from './src/jobs/queue.js';
const queue = getJobQueue();
if (queue) {
  await queue.send('my-job', data);
}
```

### Migration

Migration `migrations/20260727000000_job_dead_letter.ts` creates the `job_dead_letter` table for jobs that have exhausted retries:

```sql
CREATE TABLE IF NOT EXISTS job_dead_letter (
  id BIGSERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  job_id TEXT NOT NULL,
  payload JSONB,
  error_message TEXT,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_job_dead_letter_name ON job_dead_letter(job_name);
```

Apply with:

```bash
pnpm run migrate
```

### Tests

Unit tests for the queue are in `tests/jobs/queue.test.ts`. They mock pg-boss using `vi.mock()` to test the `JobQueue` class independently of a real database.

---

## Scripted Database Operations & Operator Ergonomics

### Overview & Architecture

Script-based database operations reside in [`src/scripts/db-ops.ts`](../src/scripts/db-ops.ts). This module provides production-grade wrappers around PostgreSQL utilities (`pg_dump` and `pg_restore`) as well as SQL partition cleanup utilities (`dropOldPartitions`).

The design prioritizes zero-disk footprint (streaming dumps directly to/from S3), strict shell injection safety, credential isolation, and fail-safe operator defaults.

```
                  ┌──────────────────────────────────────────────┐
                  │              src/scripts/db-ops.ts           │
                  └──────┬───────────────────────────────┬───────┘
                         │                               │
             ┌───────────▼───────────┐       ┌───────────▼───────────┐
             │    backupDatabase     │       │    restoreDatabase    │
             └─────┬───────────┬─────┘       └─────┬───────────┬─────┘
                   │           │                   │           │
           (Local) │           │ (S3 Stream)  (Local)│           │ (S3 Stream)
                   ▼           ▼                   ▼           ▼
             execFile       spawn               execFile     spawn
            "pg_dump"     "pg_dump"            "pg_restore" "pg_restore"
             └─► Disk      └─► S3 Upload         ▲           ▲
                                                 │           │
                                                Disk       S3 Stream
```

### Core Operations Reference

#### 1. `backupDatabase(databaseUrl, outputPath, s3Target?)`

Generates a custom-format PostgreSQL database backup (`--format=custom`).

- **Local Mode** (`s3Target` omitted): Executes `pg_dump` via `execFile`, writing output directly to `outputPath`.
- **S3 Streaming Mode** (`s3Target` provided): Spawns `pg_dump` stdout stream piped into a `PassThrough` stream to AWS S3 using `@aws-sdk/lib-storage` `Upload`. The dump streams directly to S3 without creating temporary files on the local filesystem.
- **Return Type**: `Promise<DbOperationResult>` where:
  ```typescript
  export interface DbOperationResult {
    success: boolean;
    message: string;
    /** Raw stderr / error detail — never contains connection passwords or AWS keys */
    error?: string;
  }
  ```

#### 2. `restoreDatabase(databaseUrl, inputPath, s3Source?)`

Restores a custom-format PostgreSQL database dump using `pg_restore`.

- **Local Mode** (`s3Source` omitted): Executes `pg_restore` via `execFile` from `inputPath`.
- **S3 Streaming Mode** (`s3Source` provided): Downloads object body via S3 `GetObjectCommand` and streams `response.Body` directly into `pg_restore` standard input (`stdin`).
- **Flags Used**:
  - `--clean`: Drops database objects before restoring them.
  - `--no-owner`: Skips restoration of original object ownership, enabling portable restores across environments with different database roles.
  - `--no-password`: Prevents prompt hanging when credentials are missing or invalid.

> [!WARNING]
> `--clean` drops existing database tables/objects before recreating them. Ensure active database connections are closed or quieted before invoking `restoreDatabase` in production.

#### 3. `dropOldPartitions(pool, parentTable, olderThanDays, dryRun = true)`

Performs retention-based partition pruning for range-partitioned tables such as `contract_events`.

- **Bound Extraction**: Queries `pg_inherits` and `pg_class`, extracting upper bound date strings using `/TO \('([^']+)'\)/` from `pg_get_expr(c.relpartbound, c.oid)`.
- **Default Partition Handling**: Automatically skips the `DEFAULT` partition (`partition_bound === 'DEFAULT'`).
- **Dry-Run Safety**: Defaults `dryRun = true`. Operators must explicitly pass `dryRun = false` to execute `DROP TABLE IF EXISTS`.

### Security & Credential Protection

1. **Input Validation**:
   - Connection strings: Validated against `^postgre(?:s|sql):\/\/` before spawning subprocesses. Rejects empty strings, whitespace, and non-postgres schemes (`mysql://`, `redis://`, etc.).
   - File paths: Validated to reject empty strings and shell control characters (`[\0`$|;&<>]`).
2. **Subprocess Isolation**:
   - Uses Node.js `execFile` (array form) and `spawn` with explicit argument vectors.
   - Arguments are never concatenated into a shell string, eliminating shell injection vectors.
3. **Password & Credential Masking**:
   - `DATABASE_URL` credentials and AWS secrets are consumed strictly from environment variables or argument inputs.
   - Raw database passwords are never printed to console or leaked inside `DbOperationResult.error` strings during error conditions.
4. **AWS Credential Isolation**:
   - Uses AWS SDK v3 environment provider chain (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`).
   - S3 credentials are never logged or stored in job results.

### Decimal-String Serialization Guarantee

Financial and numerical fields in Fluxora (e.g. event stream amounts, token balances) are stored as decimal strings in database `TEXT` or `NUMERIC` columns.

The `db-ops` module processes backup and restore operations purely as binary/text byte streams. No JSON coercion or numeric parsing is applied to table records, guaranteeing zero loss of precision for monetary values.

### Operator Ergonomics & Safety Controls

| Ergonomic Control | Behavior | Benefit |
|---|---|---|
| **Default Dry Run** | `dropOldPartitions` defaults `dryRun = true` | Prevents accidental data deletion if invoked without arguments |
| **Lazy AWS SDK Loading** | Dynamic `import('@aws-sdk/client-s3')` and `import('@aws-sdk/lib-storage')` | `db-ops.ts` runs in local-only mode even when `@aws-sdk` packages are not installed |
| **AWS Region Resolution** | `s3Target.region` ➔ `AWS_REGION` ➔ `AWS_DEFAULT_REGION` ➔ `'us-east-1'` | Flexible environment configuration across AWS ECS, Lambda, and local environments |
| **Whitespace Normalization** | Trims leading/trailing whitespace from `databaseUrl`, `outputPath`, and `inputPath` | Prevents spurious validation failures from whitespace in config files or CLI input |
| **Clean Output Interface** | `DbOperationResult` standardizes `{ success, message, error }` | Simplifies caller code, logging, and error handling |

### Regression Surface & Edge-Case Matrix

| Component / Function | Input / Condition | Expected Behavior | Failure Mode / Mitigation |
|---|---|---|---|
| `backupDatabase` | Empty or whitespace `databaseUrl` | Returns `{ success: false, message: 'DATABASE_URL is required...' }` | Fast failure before subprocess creation |
| `backupDatabase` | Non-postgres scheme (`mysql://`) | Returns `{ success: false, message: 'DATABASE_URL must be a valid PostgreSQL...' }` | Fast failure before subprocess creation |
| `backupDatabase` | File path with `;` or `` ` `` | Returns `{ success: false, message: 'Output path contains invalid characters.' }` | Rejection of unsafe path inputs |
| `backupDatabase` | Local mode, `pg_dump` fails | Returns `{ success: false, message: 'Backup failed', error: <stderr> }` | Error captured without password leakage |
| `backupDatabase` | S3 mode, AWS SDK missing | Throws Error: `'AWS SDK v3 is not installed...'` | Clear diagnostic message asking user to install SDK |
| `backupDatabase` | S3 mode, `pg_dump` non-zero exit | Returns `{ success: false, message: 'Backup failed', error: <stderr> }` | S3 upload discarded, error reported |
| `restoreDatabase` | S3 mode, S3 object body null/empty | Returns `{ success: false, message: 'Restore failed', error: 'S3 object ... returned an empty body' }` | Prevents hanging `pg_restore` on empty input |
| `dropOldPartitions` | Table has `DEFAULT` partition | `DEFAULT` partition is skipped; never dropped | Prevents dropping catch-all partition |
| `dropOldPartitions` | Unparseable partition bound | Partition is skipped without throwing | Log/continue without breaking retention task |
| `dropOldPartitions` | `dryRun = true` | Returns list of partition names in `droppedPartitions`; no `DROP TABLE` query issued | Safe audit before execution |

