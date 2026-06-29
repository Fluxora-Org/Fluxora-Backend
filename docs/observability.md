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

## Log aggregation integrations

See the platform-specific guides:

- [Datadog](integrations/datadog.md) — Agent log pipeline, JSON parsing, attribute remapping
- [Elastic / ECS](integrations/elastic.md) — Filebeat config, ECS field mapping, index template

---

## WebSocket Backpressure Gauges

When a single WebSocket subscriber stops reading from its socket, the kernel-level send buffer fills up and the hub eventually starts dropping frames or terminating the connection. Until that point, the global `BackpressureMetrics` only tell you *how often* drops happened, not *which* connection is consuming the most buffer.

The per-client gauges below expose `ws.bufferedAmount` directly so operators can pinpoint the offending peer before the hub escalates to drop/terminate.

### Metrics

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `fluxora_ws_backpressure_buffered_bytes` | Gauge | `connection_id` (UUID v4) | Current `ws.bufferedAmount` per connected `/ws/streams` client, in bytes. Sampled every 5s by the hub's collector and rounded to non-negative integers. |
| `fluxora_ws_max_buffered_bytes` | Gauge | — | Maximum `ws.bufferedAmount` observed across all live clients at the most recent sample. Useful for dashboards: spikes here precede drops. |
| `fluxora_ws_slow_clients` | Gauge | — | Count of live clients whose `bufferedAmount` exceeds the slow threshold (default 1 MiB). |

### Label cardinality and security

The only label is `connection_id`, which is a server-generated **UUID v4** produced in `StreamHub.onConnect` (`randomUUID()` from `node:crypto`). It is **never** derived from:

- The client IP address (`ws.remoteAddress`)
- The authenticated JWT subject or any JWT claim
- The `correlationId` header
- Any client-controlled input

Series for disconnected clients are explicitly removed via the prom-client `Gauge.remove(...)` API in `StreamHub.onDisconnect`, so the cardinality of the per-client gauge is bounded by **peak concurrent connections**, not by the total number of historical connections. This prevents:

- **Memory exhaustion** by an attacker that repeatedly connects/disconnects to inflate the metric label set.
- **PII leakage** through labels — even an attacker that controls the client cannot influence the label value.

The aggregated `fluxora_ws_max_buffered_bytes` and `fluxora_ws_slow_clients` carry no labels and contribute zero additional cardinality.

### Configuration

| StreamHub option | Default | Description |
|------------------|---------|-------------|
| `backpressureCollector.intervalMs` | `5000` | Poll interval. Set to `0` to disable the periodic collector entirely (gauge updates still happen during broadcast / send activity). |
| `backpressureCollector.slowThresholdBytes` | `1048576` (1 MiB) | Threshold above which a client is counted in `fluxora_ws_slow_clients`. |

### PromQL examples

Top-5 clients by current buffered bytes:

```promql
topk(5, fluxora_ws_backpressure_buffered_bytes)
```

Any client approaching the terminate threshold (4 MiB), with 1 MB headroom:

```promql
max(fluxora_ws_backpressure_buffered_bytes) > 4194304
```

Alert: more than 5 slow clients sustained over 5 minutes:

```promql
fluxora_ws_slow_clients > 5
```

### Thresholding strategy

- **`fluxora_ws_slow_clients > 0` for > 2 min**: investigate the highest entries of `topk(5, fluxora_ws_backpressure_buffered_bytes)` and look for one or two clients with `correlation_id` entries repeated in the structured `ws_backpressure` warning logs.
- **`max(fluxora_ws_backpressure_buffered_bytes) > 4 MiB`** (terminate threshold): one or more clients are about to be force-closed by the hub. Operators can proactively identify the offending connection via `topk(1, fluxora_ws_backpressure_buffered_bytes)`.
- **`fluxora_ws_max_buffered_bytes` rising without `fluxora_ws_slow_clients` rising**: one client is filling up but stays below the slow threshold — still worth checking `topk(1, ...)` to confirm it's not unbounded.

### Affected source files

- `src/metrics/wsBackpressure.ts` — gauge definitions + collector helpers
- `src/ws/hub.ts` — starts the collector and removes the per-client series on disconnect
- `tests/ws/hub.perClientGauge.test.ts` — bounded-cardinality / rise-then-clear assertions

---

## Authentication Latency Histograms

Auth runs on every protected request path. When the JWT verifier, revocation-store lookup, or API-key store becomes a bottleneck, these histograms give a distribution view (p50/p95/p99) and a split by success/failure — without leaking credential material.

### Metrics

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `fluxora_auth_jwt_verify_duration_seconds` | Histogram | `outcome` (`success` \| `failure`) | Time spent in `verifyToken()` (the cryptographic verify only — does NOT include revocation check or schema parse). Recorded by `src/middleware/auth.ts`. |
| `fluxora_auth_apikey_lookup_duration_seconds` | Histogram | `outcome` (`success` \| `failure`) | Time spent in API-key lookups. Recorded by `src/lib/apiKey.ts::isValidApiKey` and `src/middleware/adminAuth.ts::requireAdminAuth`. |

### Bucket layout

The bucket boundaries are intentionally bounded and tuned for each call site:

```text
fluxora_auth_jwt_verify_duration_seconds:        0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1
fluxora_auth_apikey_lookup_duration_seconds:     0.0001, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05
```

Range rationale:

- JWT verify buckets span 1 ms → 1 s. The measurement covers `verifyToken()` alone; the trailing revocation-check and schema-parse steps are intentionally excluded so an `outcome=success` observation reflects only successful cryptographic verification. A 401 caused by a downstream revocation hit or token-schema mismatch will appear as `outcome=success` on this histogram and is observable separately through the HTTP error-rate counter.
- API-key lookup buckets span 100 µs → 50 ms because the in-memory store does a SHA-256 + `timingSafeEqual`, but a future DB-backed store (tracked separately) would shift the distribution to the millisecond range.

### Security & label-cardinality guarantees

The label set is intentionally restricted to a single `outcome` label. The metrics must **never** carry credential material. The following labels are forbidden both now and in future iterations:

- `jti`, `kid`, `sub`, `subject`
- `keyId`, `prefix`, `keyHash`, raw-key substrings
- `address` / account ids derived from the token
- `userId` / `principalId`

Tests in `tests/metrics/businessMetrics.test.ts` explicitly assert the label set is `{ outcome: 'success' }` or `{ outcome: 'failure' }` only.

### PromQL examples

**p99 JWT verify latency**

```promql
histogram_quantile(
  0.99,
  rate(fluxora_auth_jwt_verify_duration_seconds_bucket[5m])
)
```

**p99 API-key lookup latency**

```promql
histogram_quantile(
  0.99,
  rate(fluxora_auth_apikey_lookup_duration_seconds_bucket[5m])
)
```

**Auth failure rate (any path) per second**

```promql
sum(rate(
  fluxora_auth_jwt_verify_duration_seconds_count{outcome="failure"}[5m]
))
+
sum(rate(
  fluxora_auth_apikey_lookup_duration_seconds_count{outcome="failure"}[5m]
))
```

**Alert: JWT verify p99 > 250 ms for 5 minutes**

```promql
histogram_quantile(
  0.99,
  rate(fluxora_auth_jwt_verify_duration_seconds_bucket[5m])
) > 0.25
```

### Thresholding strategy

- **Latency p99 > 250 ms (JWT)**: indicates the revocation-store lookup is slow or the cryptographic step is being starved; pair with `redis_pending_commands` and CPU pressure signals.
- **Latency p99 > 20 ms (API key, in-memory)**: useful as a canary when a DB-backed store is introduced, since lookups should remain single-digit milliseconds.
- **Failure rate sustained > 5%**: indicates a misconfiguration in token issuance, key rotation, or upstream auth provider outage.

### Affected source files

- `src/metrics/businessMetrics.ts` — histogram definitions
- `src/middleware/auth.ts` — JWT verify timer
- `src/lib/apiKey.ts` — `isValidApiKey` timer
- `src/middleware/adminAuth.ts` — admin env-var key check timer
