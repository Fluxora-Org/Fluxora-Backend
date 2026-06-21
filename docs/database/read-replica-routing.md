# Read-Replica Routing

## Overview

Fluxora Backend supports routing **read-only SQL queries** to a dedicated
PostgreSQL read-replica. This offloads the primary node from high-volume
`SELECT` traffic (e.g. `GET /api/streams` list requests) and improves both
read and write throughput at scale.

The implementation lives in [`src/db/replicaPool.ts`](../../src/db/replicaPool.ts)
and is integrated into the stream repository's read methods.

## Architecture

```
                 ┌──────────────────┐
  GET /api/streams ──►│  replicaPool.ts  │──► Read Replica (SELECT only)
                 │  getReadPool()   │
                 └────────┬─────────┘
                          │ fallback
                          ▼
                 ┌──────────────────┐
  POST/PUT/DELETE ──►│    pool.ts       │──► Primary (all operations)
                 │    getPool()     │
                 └──────────────────┘
```

### Query routing

| Operation            | Pool used       | Notes                        |
| -------------------- | --------------- | ---------------------------- |
| `getById()`          | Read replica    | Falls back to primary        |
| `getByEvent()`       | Read replica    | Falls back to primary        |
| `find()`             | Read replica    | Offset-paginated list        |
| `findWithCursor()`   | Read replica    | Cursor-paginated list        |
| `countByStatus()`    | Read replica    | Aggregation query            |
| `upsertStream()`     | **Primary**     | INSERT … ON CONFLICT         |
| `updateStream()`     | **Primary**     | UPDATE … RETURNING           |

## Configuration

### Environment variable

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_REPLICA_URL` | No | *(falls back to primary)* | PostgreSQL connection string for the read-replica |
| `DATABASE_REPLICA_STATEMENT_TIMEOUT_MS` | No | `STATEMENT_TIMEOUT_MS` | Replica session-level `statement_timeout`; use a higher value for reporting reads when needed |
| `DATABASE_REPLICA_POOL_QUEUE_LIMIT` | No | `POOL_QUEUE_LIMIT` | Max replica queries allowed to wait for a connection before fast-failing |

Add it to your `.env` file:

```env
# Read-replica (optional — omit to use primary for all queries)
DATABASE_REPLICA_URL=postgresql://readonly_user:password@replica-host:5432/fluxora
# Optional replica-specific overrides
DATABASE_REPLICA_STATEMENT_TIMEOUT_MS=15000
DATABASE_REPLICA_POOL_QUEUE_LIMIT=50
```

### Pool sizing

The replica pool inherits all sizing parameters from the primary pool
configuration:

- `DB_POOL_MIN` / `DB_POOL_MAX`
- `DB_CONNECTION_TIMEOUT`
- `DB_IDLE_TIMEOUT`
- `POOL_QUEUE_LIMIT`
- `STATEMENT_TIMEOUT_MS`

The replica pool applies `STATEMENT_TIMEOUT_MS` and `POOL_QUEUE_LIMIT` by
default so slow reads cannot run forever or build an unbounded wait queue.
Use `DATABASE_REPLICA_STATEMENT_TIMEOUT_MS` when replica/reporting reads need
a different timeout from primary writes, and
`DATABASE_REPLICA_POOL_QUEUE_LIMIT` when replica saturation should trip at a
different queue depth.

## Initialisation & Fallback

`getReadPool()` is **lazy** — the replica pool is not created until the
first read query executes. On the first call:

1. If `DATABASE_REPLICA_URL` is **not set**, the primary pool is returned
   immediately and cached.
2. If the variable is set, a new `pg.Pool` is created and a health-check
   (`SELECT 1`) is executed.
3. If the health-check **succeeds**, the replica pool is cached and
   returned for all subsequent calls.
4. If the health-check **fails**, the replica pool is closed, a warning is
   logged, and the primary pool is returned instead.

The decision is cached after the first call — there is no per-query
overhead.

## Timeout and Queue Protection

`createReplicaPool()` uses the same pool factory as the primary database pool,
with the stable metrics label `pool="read-replica"`. On each new physical
connection it applies:

```sql
SET statement_timeout = DATABASE_REPLICA_STATEMENT_TIMEOUT_MS
SET default_transaction_read_only = on
```

If the replica waiting queue reaches `DATABASE_REPLICA_POOL_QUEUE_LIMIT`, the
shared query helper rejects the call with `PoolExhaustedError` before it enters
the `pg.Pool` queue. PostgreSQL statement-timeout cancellations (`57014`) are
mapped to `QueryTimeoutError`.

Both timeout values are read from trusted environment configuration only; HTTP
request parameters never control `SET statement_timeout`.

## Security

### Read-only enforcement

Every physical connection to the replica pool sets:

```sql
SET default_transaction_read_only = on
```

This means that even if a write query were accidentally routed to the
replica, PostgreSQL would reject it with:

```
ERROR: cannot execute INSERT in a read-only transaction
```

### Credential isolation

The `DATABASE_REPLICA_URL` should use a **dedicated read-only database
user** with `SELECT`-only grants:

```sql
CREATE ROLE readonly_user WITH LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE fluxora TO readonly_user;
GRANT USAGE ON SCHEMA public TO readonly_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO readonly_user;
```

### Safe logging

Connection strings are **never** logged. Only the hostname is extracted
(via `URL` parsing) and included in diagnostic log messages.

## Monitoring

### Logs to watch

| Log message | Level | Meaning |
| --- | --- | --- |
| `DATABASE_REPLICA_URL not set — reads will use the primary pool` | info  | No replica configured; using primary       |
| `Read-replica pool initialised`                          | info  | Replica connected and healthy              |
| `Replica health-check failed — falling back to primary`  | warn  | Replica unreachable; using primary         |
| `Replica pool error`                                     | error | Runtime error on an existing replica conn  |

### Metrics

The labeled pool gauges distinguish primary and replica saturation:

| Metric | Label | Meaning |
| --- | --- | --- |
| `db_pool_active` | `pool="default"` / `pool="read-replica"` | Connections currently checked out |
| `db_pool_idle` | `pool="default"` / `pool="read-replica"` | Idle connections |
| `db_pool_waiting` | `pool="default"` / `pool="read-replica"` | Requests queued for a connection |

The legacy unlabeled `fluxora_db_pool_*` gauges remain for backward
compatibility, while the labeled gauges should be used when alerting on
replica-specific saturation.

## Testing

Unit tests are in `tests/db/replicaPool.test.ts`. Run them with:

```bash
pnpm test -- tests/db/replicaPool.test.ts
```

The tests cover:
- Config resolution (with and without `DATABASE_REPLICA_URL`)
- Replica-specific statement-timeout and queue-limit overrides
- Health-check success and failure paths
- Fallback to primary pool
- Read-only enforcement and `statement_timeout` on connect
- Queue-limit fast-fail and statement-timeout error mapping
- Singleton caching behaviour
- Reset / re-initialisation

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Reads still hitting primary despite `DATABASE_REPLICA_URL` being set | Health-check failed on startup | Check replica connectivity; restart the application |
| `cannot execute INSERT in a read-only transaction` | Write query accidentally routed to replica | Ensure write operations use `getPool()`, not `getReadPool()` |
| Stale data on reads | Replication lag | Monitor `pg_stat_replication` on primary; consider synchronous replication for critical reads |
