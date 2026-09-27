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

## Schema/Type Consistency Check

`src/db/types.ts` declares the shapes the application believes PostgreSQL holds. Because nothing in a normal build compares those declarations against the database, a migration that renames or retypes a column can leave the types asserting something untrue, and the mismatch only surfaces later as a value of the wrong shape.

`scripts/check-db-schema-types.mjs` closes that gap. With a migrated `DATABASE_URL` it:

- reads the declared interfaces (and their type aliases) from `src/db/types.ts`,
- maps each declared property onto its column (camelCase properties become snake_case columns),
- introspects the mapped tables (`streams`, `api_keys`, `contract_events`) through `information_schema.columns`, and
- **fails** (exit code 1) when a declared column is missing — a rename or drop — or when its SQL type family disagrees with the declared type — a retype.

Columns that exist in the schema but are not part of the declared domain shape (for example `streams.sender_address_hash` or `streams.legal_hold`) are reported as non-fatal drift, as is a declared non-null property backed by a nullable column.

```bash
# after `pnpm run migrate` against the test database
DATABASE_URL=postgresql://test_user:test_password@localhost:5432/indexer_test pnpm run check:db-types
```

Without `DATABASE_URL` the check is skipped, matching the other live-database suites. CI runs it in the `test` job immediately after applying migrations, so renaming a mapped column in a migration fails the pipeline until `src/db/types.ts` is updated. Intentional representation differences — a timestamp column exposed as an ISO-8601 `string`, or a JSON-serialized `text` column exposed as `string[]` — are recorded with a reason in `SCHEMA_TYPE_CONTRACT` inside the script.

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

### Destructive operation safety

`restoreDatabase` and `dropOldPartitions` are guarded before any database or
S3 operation runs. Each operation prints the target environment and requires
`confirm: true`; a production target additionally requires
`acknowledgeProduction: true`. Set `dryRun: true` to report the planned source,
target, and number of partitions that would be changed without executing the
operation.

```ts
const result = await dropOldPartitions(pool, 'contract_events', 30, {
  dryRun: true,
  targetEnvironment: 'staging',
})

// After reviewing the dry-run result, explicitly confirm a live run:
await dropOldPartitions(pool, 'contract_events', 30, {
  dryRun: false,
  targetEnvironment: 'staging',
  confirm: true,
})
```

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

#### Lead time (how far ahead partitions are created)

Partitions are created a **documented interval ahead of use**: the partition covering month `M` is created during month `M - leadTimeMonths`, so it exists for at least `leadTimeMonths` months (≈ 28 × `leadTimeMonths` days) before a single row can require it. That buffer is what makes a failed or missed run survivable — the next run self-heals long before the partition is *needed*.

The default lead time is `DEFAULT_LEAD_TIME_MONTHS = 3` months. It is configurable, in whole calendar months, with this precedence:

| # | Source | Notes |
|---|---|---|
| 1 | `leadTimeMonths` option to `runPartitionMaintenance(pool, { leadTimeMonths })` | Highest precedence; used by tests and by callers that need a specific value. |
| 2 | `monthsAhead` option | Deprecated alias with the same meaning, kept for callers written against the previous signature. |
| 3 | `PARTITION_MAINTENANCE_LEAD_TIME_MONTHS` env var (`config.partitionMaintenance.leadTimeMonths`) | Deployment-level knob. |
| 4 | `DEFAULT_LEAD_TIME_MONTHS` (3) | Built-in fallback. |

Keep the configured value `>= 2` so a single missed monthly boundary cannot exhaust the buffer. A non-integer or negative configured value is ignored in favour of the built-in default rather than propagated, so a typo in a deployment's environment cannot silently disable pre-creation. The run result reports the value actually used as `leadTimeMonths`.

#### Schedule and idempotency

1. The job runs on a daily cron schedule (`0 0 * * *`) and once immediately at process startup (`src/jobs/queue.ts`), pre-creating the current month plus every month starting inside the configured lead time (default `3` months).
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
- Raises the `partition_maintenance_behind_schedule` operator alert (see below), so the event is pageable from metrics and not only discoverable from logs.
- Still creates the missing partition immediately afterward (self-healing) — the alert reports a `DEFAULT`-partition risk window that already occurred, it does not prevent the fix.

##### Recommended alert

```yaml
- alert: PartitionMaintenanceBehindSchedule
  expr: increase(fluxora_partition_maintenance_behind_schedule_total[1d]) > 0
  severity: critical
  annotations:
    summary: "A scheduled partition pre-creation run was missed — rows may have landed in the DEFAULT partition"
```

#### Failure alerting (a failure is never only a log line)

Every failure that matters to an operator is raised through `raiseAlert()` in `src/lib/alerts.ts`, which emits a structured `error` log record **and** increments `fluxora_alerts_raised_total{alert,severity}` — so metric-based alerting rules can page on it even when no log shipping is configured. `raiseAlert()` never throws, and can additionally be forwarded to an incident-management provider via `setAlertSink()`.

| Alert name | Severity | Raised when |
|---|---|---|
| `partition_creation_failed` | critical | A `CREATE TABLE … PARTITION OF` threw. The error is re-thrown afterwards, so the queue retries (and eventually dead-letters) the run instead of treating it as a success. |
| `partition_maintenance_behind_schedule` | critical | The current month's partition was missing — a previous run was missed or failed. |
| `partition_shortfall_detected` | critical | The pre-write guard (below) found a required partition missing just before an insert. |

```yaml
- alert: PartitionCreationFailed
  expr: increase(fluxora_alerts_raised_total{alert="partition_creation_failed"}[15m]) > 0
  severity: critical
  annotations:
    summary: "A partition could not be created — writes for that interval are at risk"

- alert: PartitionShortfallBeforeWrite
  expr: increase(fluxora_alerts_raised_total{alert="partition_shortfall_detected"}[15m]) > 0
  severity: critical
  annotations:
    summary: "A write needed a partition that did not exist — partition maintenance was not running"
```

#### Pre-write detection (absence is caught before a write fails)

The job is a *scheduled* defence, so between two runs time can advance past the created partitions (a deploy that never started the job, an outage, a mis-set lead time). The next write would then fail with an opaque `no partition of relation "contract_events" found for row` — a write error raised far from its cause.

`ensurePartitionCoverage()` (exported from `src/jobs/partitionMaintenance.ts`, same module as the job so both share the partition-naming and bound math) is called by `PostgresContractEventStore.insertMany()` **before** the insert is issued:

1. It computes the partitions covering every distinct month in the batch's `happened_at` values.
2. A single catalog query reports whether the parent is range-partitioned *and* which of those partitions exist (no per-row work, one round-trip in the happy path).
3. If a required partition is missing it raises `partition_shortfall_detected`, then creates the partition so the write that follows cannot fail — alerting and self-healing in one pass. A create that fails raises `partition_creation_failed` and is reported as `failed` on the result.

The guard is **strictly fail-open**: an unmanaged (non-partitioned) table, an inconclusive probe response, or a probe error leaves `insertMany()` behaving exactly as it did before — observability must never be the reason a writable batch fails.

#### Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `fluxora_partitions_created_total` | Counter | `table` | Incremented once per partition actually created (idempotent no-ops are not counted), by both the job and the pre-write guard |
| `fluxora_partition_maintenance_behind_schedule_total` | Counter | `table` | Incremented when the current-month partition was found missing (see above) |
| `fluxora_partition_maintenance_failures_total` | Counter | `table` | Incremented on every failed partition-creation attempt |
| `fluxora_alerts_raised_total` | Counter | `alert`, `severity` | Every operator alert raised through `src/lib/alerts.ts` |

#### Security

- Table names come exclusively from the developer-controlled `CANDIDATE_TABLES` constant, never from user input.
- Partition names are derived deterministically from the table name and a UTC year/month, and are additionally passed through `quoteIdentifier()` before being interpolated into DDL (defence-in-depth against a future change widening the input surface).
- Partition bound literals are ISO-8601 UTC timestamps produced by `Date#toISOString()`, validated against a strict regex before interpolation — the `pg` driver cannot parameterize DDL bound expressions, so this validation substitutes for parameterization.
- The job's DB principal needs `CREATE` on the parent table only; no superuser privileges are required.

#### Tests

`tests/jobs/partitionMaintenance.test.ts` covers: lock acquisition/skip/release (including release-on-throw), input validation, per-table managed/unmanaged gating, idempotent re-runs, partition naming (including year rollover and UTC boundary edge cases), lead-time resolution (option, deprecated alias, configured default, invalid-value fallback, `PARTITION_MAINTENANCE_LEAD_TIME_MONTHS`), behind-schedule detection and metrics, failure alerting (alerts raised *and* the error still re-thrown), and identifier-quoting security checks — all against a mocked `Pool`, no live database required.

`tests/db/contractEvents.partitionCoverage.test.ts` covers the pre-write guard against an in-memory emulation of Postgres: the probe's single round-trip and month deduplication, `partition_shortfall_detected` + self-heal, detection-only mode, failed-create alerting, fail-open behaviour for unmanaged tables / unexpected probe shapes / probe errors, and the issue's validation scenario — advance time past the partitions the job created and assert the shortfall is detected (and alerted on) *before* the write fails.

`tests/lib/alerts.test.ts` covers the alerting facility itself: log level and record shape, metric increment, sink dispatch, name normalisation, and the never-throws guarantee.

```bash
pnpm test tests/jobs/partitionMaintenance.test.ts tests/db/contractEvents.partitionCoverage.test.ts tests/lib/alerts.test.ts
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

