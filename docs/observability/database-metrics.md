# Database Pool Metrics

Fluxora Backend exposes three Prometheus Gauges for every named `pg.Pool` instance. Operators can use these to detect pool exhaustion before it causes request timeouts.

## Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `db_pool_active` | Gauge | `pool` | Connections currently checked out (in use) |
| `db_pool_idle` | Gauge | `pool` | Connections sitting idle in the pool |
| `db_pool_waiting` | Gauge | `pool` | Client requests queued waiting for a connection |

The `pool` label identifies the pool instance. The default singleton uses `pool="default"`. A read-replica pool would use `pool="read-replica"`.

## How it works

`syncPoolGauges(pool, poolName)` in `src/metrics/pool.ts` is called from three `pg.Pool` event listeners registered in `src/db/pool.ts`:

- `connect` — a new physical connection was established
- `acquire` — a connection was checked out to a client
- `remove` — a connection was closed (idle timeout or error)

Each event triggers a snapshot of `pool.totalCount`, `pool.idleCount`, and `pool.waitingCount`.

```
active = totalCount - idleCount   (clamped to 0)
idle   = idleCount
waiting = waitingCount
```

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
```

## Alerting rules

```yaml
groups:
  - name: database_pool
    rules:
      # Alert when the waiting queue is non-zero for more than 30 seconds
      - alert: DbPoolQueueBuildup
        expr: db_pool_waiting > 0
        for: 30s
        labels:
          severity: warning
        annotations:
          summary: "Pool {{ $labels.pool }} has {{ $value }} waiting requests"

      # Alert when active connections reach 90% of pool max
      - alert: DbPoolNearExhaustion
        expr: db_pool_active / (db_pool_active + db_pool_idle) > 0.9
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Pool {{ $labels.pool }} utilisation above 90%"
```

## Grafana dashboard queries

```promql
# Active connections by pool
db_pool_active

# Pool utilisation ratio (0–1)
db_pool_active / (db_pool_active + db_pool_idle)

# Waiting queue depth
db_pool_waiting

# Total pool exhaustion events (counter from dbMetrics.ts)
rate(fluxora_db_pool_exhausted_total[5m])
```

## Security notes

- The `pool` label value is set exclusively from the `poolName` field in `PoolConfig`, which is always a hardcoded application constant (e.g. `"default"`, `"read-replica"`).
- It is **never** derived from HTTP request headers, query parameters, or any user-supplied input, preventing label-injection attacks that could cause cardinality explosions or metric spoofing.
- The `/metrics` endpoint should be protected from public access. See `src/routes/metrics.ts` for the existing token-auth middleware.

## Backward compatibility

The legacy unlabeled gauges in `src/metrics/dbMetrics.ts` (`fluxora_db_pool_active_connections`, `fluxora_db_pool_idle_connections`, `fluxora_db_pool_waiting_requests`) are still updated on every event. Existing dashboards and alerts targeting those metrics continue to work without changes.
