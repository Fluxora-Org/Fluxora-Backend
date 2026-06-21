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
| `DATABASE_REPLICA_URL` | unset | Optional read-replica connection string for stream read queries |
| `REPLICA_MAX_LAG_SECONDS` | `30` | Max tolerated replica replay lag before reads fall back to primary |

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

## Read Replica Lag Failover

When `DATABASE_REPLICA_URL` is set, stream read queries use a dedicated read-only replica pool. Before serving each read, the pool probes `pg_last_xact_replay_timestamp()` and computes replay lag in seconds. If the lag is unknown, the probe fails, or lag is greater than `REPLICA_MAX_LAG_SECONDS`, that read falls back to the primary pool.

Fallback is reversible. Later reads probe the replica again, so traffic returns to the replica once lag drops below the threshold. The probe does not log the replica URL or credentials.

Prometheus exposes `fluxora_db_replica_lag_seconds` as the last observed lag value. The metric has no host or URL labels to avoid leaking topology details.

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
