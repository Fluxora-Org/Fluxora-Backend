# Observability

## Slow-query logging

Every PostgreSQL query executed through `src/db/pool.ts` is timed. When the duration meets or exceeds `SLOW_QUERY_THRESHOLD_MS`, a structured `WARN` log entry is emitted and a Prometheus counter is incremented.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SLOW_QUERY_THRESHOLD_MS` | `1000` | Threshold in ms. Set to `0` to disable slow-query logging entirely. |

### Log fields

```json
{
  "level": "warn",
  "message": "Slow postgres query",
  "query_hash": "a3f1c2d4e5b6a7f8",
  "duration_ms": 1234,
  "table_hint": "streams",
  "correlation_id": "req_abc123"
}
```

| Field | Description |
|-------|-------------|
| `query_hash` | First 16 hex chars of SHA-256(sql). Stable across runs; safe to log. |
| `duration_ms` | Wall-clock query duration in milliseconds. |
| `table_hint` | First table name extracted from the SQL keyword context (FROM/INTO/UPDATE/JOIN). |
| `correlation_id` | Request correlation ID from async context, if available. |

Raw SQL and parameter values are **never** logged to prevent PII/credential leakage.

### Prometheus metric

```
fluxora_db_slow_queries_total{table_hint="streams"} 3
```

Counter name: `fluxora_db_slow_queries_total`  
Label: `table_hint` — the extracted table name (or `unknown`).  
Scraped at: `GET /metrics`
