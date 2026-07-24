# Database Connection Pool

## Overview

Fluxora Backend uses a `pg.Pool` (node-postgres) for all database access. The pool is configured via environment variables and includes proactive exhaustion detection to prevent unbounded request queuing.

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

To avoid rows landing in the unindexed `DEFAULT` partition, partitions for the next 3 months are pre-created by the background job `src/jobs/partitionMaintenance.ts`.

1. The job runs every 24 hours.
2. It uses `pg_try_advisory_lock` to prevent concurrent execution.
3. If partition creation falls behind, the job logs an error and should be monitored for alerting.

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

### Publication Scope & Security

The publication `fluxora_contract_events_pub` is narrowly scoped to ensure data isolation and security:

- **Single Table Scope**: Scoped exclusively to the `contract_events` table. Tables containing Personally Identifiable Information (PII) or sensitive tokens (such as `streams`, `api_keys`, or `webhook_outbox`) are explicitly excluded from replication.
- **Append-Only Operations**: Configured with `WITH (publish = 'insert')`. Since `contract_events` is an append-only event ledger, restricting publication strictly to `INSERT` operations eliminates unnecessary WAL replication overhead for table maintenance and prevents exposing operational updates or deletes.

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

## Partition Pruning for `contract_events`

### Overview & Range Partitioning Strategy

The `contract_events` table is partitioned by range on `happened_at` (`PARTITION BY RANGE (happened_at)`) per migration `20260627000000_contract_events_partitioning.ts`. Range partitioning bounds disk growth and enables aggressive partition pruning during historical range queries.

### Query Predicate Requirements & Pruning Behavior

PostgreSQL partition pruning is driven by predicates on the partition key (`happened_at`). When `StreamEventReplayFilter` query parameters (`fromHappenedAt`, `toHappenedAt`) are passed to `PostgresContractEventStore.getEvents()`, PostgreSQL's query planner automatically prunes non-overlapping partition tables from the execution plan.

- **Single-Partition Bounded Queries**: Queries bounded to a single month (e.g. `happened_at >= '2026-07-01T00:00:00.000Z' AND happened_at <= '2026-07-31T23:59:59.999Z'`) evaluate to an execution plan containing strictly the target partition (e.g., `contract_events_y2026m07`). Other partitions (`contract_events_y2026m06`, `contract_events_y2026m08`, `contract_events_default`) are pruned and omitted from disk scans.
- **Cross-Partition Range Queries**: Queries spanning multiple partition boundaries (e.g., `happened_at >= '2026-06-15T00:00:00.000Z' AND happened_at <= '2026-07-15T23:59:59.999Z'`) scan only the specific matching partitions (`contract_events_y2026m06` and `contract_events_y2026m07`), excluding irrelevant partitions.

### Verification via EXPLAIN

Partition pruning efficiency is verified via integration tests (`tests/db/contractEvents.partitionPruning.test.ts`) that execute `EXPLAIN (FORMAT JSON)` against representative store query shapes and inspect the plan output structure.


