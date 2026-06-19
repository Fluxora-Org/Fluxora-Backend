# Observability

## Prometheus scrape configuration

`GET /metrics` is protected by the same `ADMIN_API_KEY` Bearer token used by other admin routes. Prometheus scrape jobs must supply the token via the `Authorization` header.

### Environment variable

| Variable | Description |
|----------|-------------|
| `ADMIN_API_KEY` | Shared secret for admin and metrics access. Required — the endpoint returns `503` when unset. |

### Prometheus `scrape_configs` example

```yaml
scrape_configs:
  - job_name: fluxora
    static_configs:
      - targets: ['localhost:3000']
    authorization:
      type: Bearer
      credentials: <ADMIN_API_KEY value>
```

### Response codes

| Status | Cause |
|--------|-------|
| `200` | Valid token — metrics payload returned |
| `401` | Missing or malformed `Authorization` header |
| `403` | Token present but incorrect |
| `503` | `ADMIN_API_KEY` not configured on the server |

## Slow-query logging

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
  "timestamp": "2026-05-29T16:00:00.000Z",
  "level": "warn",
  "message": "Slow postgres query",
  "context": {
    "query_hash": "a3f1c2d4e5b6a7f8",
    "duration_ms": 1234,
    "table_hint": "streams",
    "correlation_id": "req_abc123"
  }
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

Counter name: `fluxora_db_slow_queries_total`  
Label: `table_hint` — the extracted table name (or `unknown`).  
Scraped at: `GET /metrics`

## Prometheus scrape configuration

`GET /metrics` is protected by the same `ADMIN_API_KEY` Bearer token used by other admin routes. Prometheus scrape jobs must supply the token via the `Authorization` header.

### Environment variable

| Variable | Description |
|----------|-------------|
| `ADMIN_API_KEY` | Shared secret for admin and metrics access. Required — the endpoint returns `503` when unset. |

### Prometheus `scrape_configs` example

```yaml
scrape_configs:
  - job_name: fluxora
    static_configs:
      - targets: ['localhost:3000']
    authorization:
      type: Bearer
      credentials: <ADMIN_API_KEY value>
```

### Response codes

| Status | Cause |
|--------|-------|
| `200` | Valid token — metrics payload returned |
| `401` | Missing or malformed `Authorization` header |
| `403` | Token present but incorrect |
| `503` | `ADMIN_API_KEY` not configured on the server |

## Runtime Performance Metrics

The application exposes fine-grained Node.js runtime health indicators to differentiate garbage collection pressure from event loop starvation during load spikes.

### Metrics

| Metric Name | Type | Description |
|-------------|------|-------------|
| `fluxora_nodejs_heap_used_bytes` | Gauge | Node.js heap used size in bytes. |
| `fluxora_nodejs_heap_total_bytes` | Gauge | Node.js heap total size in bytes. |
| `fluxora_nodejs_external_bytes` | Gauge | Node.js external memory size in bytes. |
| `fluxora_nodejs_event_loop_lag_seconds` | Histogram | Event loop lag measured via a `setTimeout` probe. Buckets: 0.005 to 10 seconds. |

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_SAMPLE_INTERVAL_MS` | `10000` | The interval in milliseconds at which to sample runtime metrics. |

### Alert Thresholding Strategy

- **Event Loop Lag**: Alert if p99 lag `> 1s` (indicates severe event loop starvation or long-running synchronous work).
- **Heap Pressure**: Alert if `fluxora_nodejs_heap_used_bytes` is consistently `> 85%` of `fluxora_nodejs_heap_total_bytes` over a sustained period (indicates GC thrashing).

## Authentication Latency Metrics

Authentication hot paths export bounded-label histograms for operator dashboards. The only label is `outcome`; token contents, API keys, key prefixes, addresses, and request identifiers are not recorded.

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `fluxora_auth_jwt_verify_duration_seconds` | Histogram | `outcome="success|failure"` | Time spent verifying JWT signature and expiry. |
| `fluxora_auth_apikey_lookup_duration_seconds` | Histogram | `outcome="success|failure"` | Time spent hashing and comparing API keys against active records. |

Example p95 PromQL:

```promql
histogram_quantile(
  0.95,
  sum(rate(fluxora_auth_jwt_verify_duration_seconds_bucket[5m])) by (le, outcome)
)
```

```promql
histogram_quantile(
  0.95,
  sum(rate(fluxora_auth_apikey_lookup_duration_seconds_bucket[5m])) by (le, outcome)
)
```

## Log aggregation integrations

See the platform-specific guides:

- [Datadog](integrations/datadog.md) — Agent log pipeline, JSON parsing, attribute remapping
- [Elastic / ECS](integrations/elastic.md) — Filebeat config, ECS field mapping, index template
