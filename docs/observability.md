# Observability

## DB Query Duration Histogram

Every repository method in `src/db/repositories/streamRepository.ts` is instrumented with a Prometheus histogram.

### Metric

```
fluxora_db_query_duration_seconds{repository="streamRepository",operation="upsertStream"} ...
```

| Label | Values | Description |
|-------|--------|-------------|
| `repository` | `streamRepository` | Source repository |
| `operation` | `upsertStream`, `updateStream`, `getById`, `getByEvent`, `findWithCursor`, `find`, `countByStatus` | Method name |

**Buckets (seconds):** 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10

p99 SLO query:

```promql
histogram_quantile(0.99, rate(fluxora_db_query_duration_seconds_bucket[5m]))
```

---

## Slow-Query Logging (SIEM Integration)

Every PostgreSQL query is timed. When duration ≥ `SLOW_QUERY_THRESHOLD_MS`, a structured OCSF log entry is emitted and a Prometheus counter is incremented.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SLOW_QUERY_THRESHOLD_MS` | `1000` | Threshold in ms. Set to `0` to disable. |

### OCSF Log Format

Entries follow [OCSF Database Activity](https://schema.ocsf.io/classes/database_activity) (class_uid 5001), compatible with Splunk, Datadog, and Elastic.

```json
{
  "log_type": "slow_query",
  "class_uid": 5001,
  "activity_id": 1,
  "severity_id": 3,
  "severity": "Medium",
  "time": "2026-05-30T18:00:00.000Z",
  "query_hash": "a3f1c2d4e5b6a7f8",
  "duration_ms": 1234,
  "table_hint": "streams",
  "correlation_id": "req_abc123"
}
```

| Field | Description |
|-------|-------------|
| `log_type` | Always `slow_query` — use for SIEM filter rules |
| `class_uid` | OCSF class: 5001 (Database Activity) |
| `activity_id` | OCSF activity: 1 (Query) |
| `severity_id` | OCSF severity: 3 (Medium) |
| `severity` | Human-readable severity |
| `time` | ISO-8601 timestamp |
| `query_hash` | First 16 hex chars of SHA-256(sql). Stable; safe to log. |
| `duration_ms` | Wall-clock query duration in milliseconds |
| `table_hint` | First table name extracted from SQL keywords |
| `correlation_id` | Request correlation ID, if available |

Raw SQL and parameter values are **never** logged.

### Prometheus Counter

```
fluxora_db_slow_queries_total{table_hint="streams"} 3
```

---

## Pool Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `fluxora_db_pool_active_connections` | Gauge | Checked-out connections |
| `fluxora_db_pool_idle_connections` | Gauge | Idle connections |
| `fluxora_db_pool_waiting_requests` | Gauge | Requests waiting for a connection |
| `fluxora_db_pool_exhausted_total` | Counter | Times the pool queue limit was exceeded |

All metrics scraped at `GET /metrics`.

---

## Security Notes

- `query_hash` is a truncated SHA-256 of the SQL template — never contains parameter values or PII.
- `table_hint` is extracted via regex from SQL keywords only — cannot contain injected values.
- OCSF entries are written to stdout only; never include credentials or user data.
