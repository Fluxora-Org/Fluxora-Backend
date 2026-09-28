# Database Pool Metrics

Fluxora Backend exposes five Prometheus Gauges for every named `pg.Pool` instance. Two of them are
saturation ratios that move **before** the pool is exhausted, so operators get lead time instead of
a post-mortem.

## Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `db_pool_active` | Gauge | `pool` | Connections currently checked out (in use) |
| `db_pool_idle` | Gauge | `pool` | Connections sitting idle in the pool |
| `db_pool_waiting` | Gauge | `pool` | Client requests queued waiting for a connection |
| `db_pool_saturation_ratio` | Gauge | `pool` | Checked-out connections ÷ configured `max` (0..1) |
| `db_pool_queue_saturation_ratio` | Gauge | `pool` | Queued requests ÷ configured `queueLimit` (0..1) |

The `pool` label identifies the pool instance. The default singleton uses `pool="default"`. A read-replica pool would use `pool="read-replica"`.

## How it works

`syncPoolGauges(pool, poolName)` in `src/metrics/pool.ts` is called from three `pg.Pool` event listeners registered in `src/db/pool.ts`:

- `connect` — a new physical connection was established
- `acquire` — a connection was checked out to a client
- `remove` — a connection was closed (idle timeout or error)

Each event triggers a snapshot of `pool.totalCount`, `pool.idleCount`, `pool.waitingCount`, plus the pool's
configured `options.max` (capacity) and `queueLimit`.

```
active                 = totalCount - idleCount      (clamped to 0)
idle                   = idleCount
waiting                = waitingCount
saturation_ratio       = active  / capacity           (clamped to 0..1)
queue_saturation_ratio = waiting / queueLimit         (clamped to 0..1)
```

`syncPoolGauges()` only publishes a ratio when the denominator is a known positive number, so a pool
without an explicit `max` / `queueLimit` is never reported as a misleading `0`.

`query()` in `src/db/pool.ts` also re-syncs the gauges on the pool-exhausted fast-fail path (when
`waitingCount >= queueLimit`) immediately before it throws `PoolExhaustedError`. That is the exact moment
`db_pool_queue_saturation_ratio` reaches `1`, so the failure path is reflected in the published metrics
rather than only in the logs.

## Saturation: why not just `db_pool_waiting`?

`db_pool_waiting` stays at `0` until the pool is **already** exhausted — by then requests are queueing or
being refused, so an alert on it has no lead time. The ratio gauges are the actionable signals:

| Metric | Meaning | Warn | Page |
|---|---|---|---|
| `db_pool_saturation_ratio` | Fraction of configured capacity in use | `>= 0.80` | `>= 0.95` |
| `db_pool_queue_saturation_ratio` | Fraction of the wait queue in use | `>= 0.50` | `>= 0.90` |

With `max = 10`, `db_pool_saturation_ratio = 0.80` means eight connections are checked out and two are
still idle: there is headroom, but the trend is clear enough to scale the pool or shed load before
anything queues. `db_pool_queue_saturation_ratio` climbs from `0` as soon as requests begin to queue and
reaches `1` at the point `query()` fast-fails.

## Configuring the pool name

Pass `poolName` in `PoolConfig` when calling `createPool()`:

```typescript
import { createPool } from './src/db/pool.js';

const readReplica = createPool({
  connectionString: process.env.READ_REPLICA_URL!,
  min: 2,
  max: 5,
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 30000,
  queueLimit: 20,
  statementTimeoutMs: 5000,
  poolName: 'read-replica',   // ← sets pool label
});
```

The default singleton (`getPool()`) uses `poolName: 'default'`.

## Prometheus scrape examples

### Scrape config (`prometheus.yml`)

```yaml
scrape_configs:
  - job_name: fluxora-backend
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: /metrics
```

### Sample output

```
# HELP db_pool_active Number of active (checked-out) pg.Pool connections
# TYPE db_pool_active gauge
db_pool_active{pool="default"} 3
db_pool_active{pool="read-replica"} 1

# HELP db_pool_idle Number of idle pg.Pool connections
# TYPE db_pool_idle gauge
db_pool_idle{pool="default"} 7
db_pool_idle{pool="read-replica"} 4

# HELP db_pool_waiting Number of requests waiting for a pg.Pool connection
# TYPE db_pool_waiting gauge
db_pool_waiting{pool="default"} 0
db_pool_waiting{pool="read-replica"} 0

# HELP db_pool_saturation_ratio Fraction of configured pg.Pool capacity in use (active / max); alert at 0.8, page at 0.95
# TYPE db_pool_saturation_ratio gauge
db_pool_saturation_ratio{pool="default"} 0.3
db_pool_saturation_ratio{pool="read-replica"} 0.2

# HELP db_pool_queue_saturation_ratio Fraction of the pg.Pool wait queue in use (waiting / queueLimit); alert at 0.5, page at 0.9
# TYPE db_pool_queue_saturation_ratio gauge
db_pool_queue_saturation_ratio{pool="default"} 0
db_pool_queue_saturation_ratio{pool="read-replica"} 0
```

## Alerting rules

```yaml
groups:
  - name: database_pool
    rules:
      # Lead-time signal: the pool is filling up before anything queues.
      - alert: DbPoolSaturationWarning
        expr: db_pool_saturation_ratio >= 0.8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Pool {{ $labels.pool }} is {{ $value }} saturated"

      - alert: DbPoolSaturationCritical
        expr: db_pool_saturation_ratio >= 0.95
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Pool {{ $labels.pool }} is {{ $value }} saturated — exhaustion imminent"

      # Failure-path signal: the wait queue is filling and requests are being refused.
      - alert: DbPoolQueueSaturation
        expr: db_pool_queue_saturation_ratio >= 0.9
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Pool {{ $labels.pool }} wait queue is {{ $value }} full"

      # Belt-and-braces: something is already queuing.
      - alert: DbPoolQueueBuildup
        expr: db_pool_waiting > 0
        for: 30s
        labels:
          severity: warning
        annotations:
          summary: "Pool {{ $labels.pool }} has {{ $value }} waiting requests"
```

## Query-failure metrics (actionable failure paths)

Every failed `query()` call — pool exhaustion fast-fail, `statement_timeout` (PG 57014), unique violation (PG 23505), or any other driver/connection error — is recorded by a dedicated counter (`src/metrics/dbMetrics.ts`). Without it, dashboards flatline the moment queries start failing because the success-only metrics (e.g. slow-query counter) go quiet exactly during an incident.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `fluxora_db_query_errors_total` | Counter | `error_type` | Total failed queries, partitioned by error class |
| `fluxora_db_pool_exhausted_total` | Counter | — | Dedicated pool-exhaustion counter (still emitted for legacy dashboards) |

`error_type` is a **bounded enum** — label cardinality is capped at 4 series no matter how many queries fail:

| `error_type` | Trigger |
|---|---|
| `pool_exhausted` | Waiting queue length ≥ `POOL_QUEUE_LIMIT` (fast-fail before execution) |
| `query_timeout` | Query canceled by `statement_timeout` (PG `57014`) |
| `duplicate_entry` | Unique constraint violation (PG `23505`) |
| `other` | Any other driver / connection / SQL error |

### Intended alert thresholds

```yaml
      # warning — any query is failing; investigate DB connectivity/latency
      - alert: DbQueryFailures
        expr: rate(fluxora_db_query_errors_total[5m]) > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Query failures detected: the '{{ $labels.error_type }}' class is above zero"

      # critical — pool exhaustion is an availability event (503s)
      - alert: DbPoolExhausted
        expr: rate(fluxora_db_pool_exhausted_total[5m]) > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Postgres pool queue limit reached"
```

### Slow queries on the failure path

`fluxora_db_slow_queries_total` is now incremented on the **failure path as well as the success path** (e.g. a query that hangs for 8s and then hits `statement_timeout`). The slow-query counter therefore keeps rising during an outage instead of freezing at the value of the last successful query, giving SREs a leading spike before errors surface.

## Grafana dashboard queries

```promql
# Active connections by pool
db_pool_active

# Pool saturation (0–1) — uses the configured max, not the current connection count
db_pool_saturation_ratio

# Wait-queue saturation (0–1)
db_pool_queue_saturation_ratio

# Waiting queue depth
db_pool_waiting

# Total pool exhaustion events (counter from dbMetrics.ts)
rate(fluxora_db_pool_exhausted_total[5m])

# Query failure rate by error class (counter from dbMetrics.ts)
rate(fluxora_db_query_errors_total[5m])
```

## Security notes

- The `pool` label value is set exclusively from the `poolName` field in `PoolConfig`, which is always a hardcoded application constant (e.g. `"default"`, `"read-replica"`).
- It is **never** derived from HTTP request headers, query parameters, or any user-supplied input, preventing label-injection attacks that could cause cardinality explosions or metric spoofing.
- The `/metrics` endpoint should be protected from public access. See `src/routes/metrics.ts` for the existing token-auth middleware.

## Backward compatibility

The legacy unlabeled gauges in `src/metrics/dbMetrics.ts` (`fluxora_db_pool_active_connections`, `fluxora_db_pool_idle_connections`, `fluxora_db_pool_waiting_requests`) are still updated on every event. Existing dashboards and alerts targeting those metrics continue to work without changes.
