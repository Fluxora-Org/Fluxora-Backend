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

## Server-Timing response header

Fluxora can return a W3C-compatible `Server-Timing` response header for the streams API so browser developer tools and ad-hoc debugging can see a compact latency breakdown without enabling the OpenTelemetry backend.

### How it works

- Middleware creates a request-scoped registry attached to `res.locals` when `SERVER_TIMING_ENABLED=true`.
- Streams route handlers record named phases by pushing sanitized values into the registry. Current streams responses include `db` and `serialize`; paths that make Stellar RPC calls may also record `stellar_rpc`.
- The final header is emitted once per response and contains only phase names and durations.
- Responses without recorded phases omit the header, even when the feature is enabled.

### Security guarantees

- The header contains no hostnames, query strings, URLs, or PII.
- Phase names are restricted to a safe token format and durations are rounded to milliseconds.
- The feature is disabled by default and adds negligible overhead when `SERVER_TIMING_ENABLED` is unset or false.

### Example

```http
Server-Timing: db;dur=12.5, serialize;dur=3.75
```

### Prometheus Counter

```
fluxora_db_slow_queries_total{table_hint="streams"} 3
```

## Server-Sent Events (SSE) observability
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

## Trace-Enriched Error Logs

Every error-level log emitted by the centralized error handler (`src/middleware/errorHandler.ts`)
automatically carries the current OpenTelemetry `traceId` and `spanId` when a distributed trace
is active, enabling operators to jump from a log line straight to the corresponding trace in
Jaeger, Datadog, or any other OTLP-compatible backend.

### Fields

When a tracing context is active, error log JSON records include these two additional fields:

| Field | Source | Description |
|-------|--------|-------------|
| `traceId` | `trace.getActiveSpan().spanContext().traceId` | W3C 32-hex-char trace ID linking all spans in the distributed trace |
| `spanId` | `trace.getActiveSpan().spanContext().spanId` | W3C 16-hex-char span ID of the request's root span |

These fields are read from the same OTel `AsyncLocalStorage` context used by the rest of
`src/tracing/hooks.ts` (via `getActiveTraceSpanIds()`) so every log line and every emitted
span share a single source of truth for trace identity.

### Example log entry (with active trace)

```json
{
  "level": "error",
  "timestamp": "2026-07-30T12:00:00.000Z",
  "message": "API error: Validation failed",
  "code": "VALIDATION_ERROR",
  "statusCode": 400,
  "requestId": "abc-def-123",
  "traceId": "0af7651916cd43dd8448eb211c80319c",
  "spanId": "b7ad6b7169203331"
}
```

### Graceful degradation

When no tracing context is active (e.g. background jobs outside a request span, tracing
disabled, or OTel SDK not initialised), the `traceId` and `spanId` fields are simply
**absent** from the log record. The error handler never throws due to a missing trace
context — its core function of logging the error and returning a response to the client
is never compromised.

### PII safety

The `traceId` and `spanId` values are opaque hex strings generated by the tracing
infrastructure. They contain no PII, no request payload, and no credential material.
These fields are logged to stderr only and are **never** exposed in HTTP response bodies.

### Affected source files

- `src/tracing/hooks.ts` — `getActiveTraceSpanIds()` helper
- `src/middleware/errorHandler.ts` — enriches all error log calls with trace context
- `tests/errors.traceEnrichment.test.ts` — comprehensive tests including graceful
  degradation, failure safety, and PII assertions

---

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
| `fluxora_ws_broadcast_batch_flush_seconds` | Histogram | — | Age in seconds of the oldest event included in a micro-batched WebSocket broadcast flush. Bounded O(1) cardinality (zero labels). |

### Micro-Batch Broadcast Flush Latency

When WebSocket broadcast micro-batching (flush-window coalescing) is enabled via `flushWindowMs > 0`, events are held briefly to coalesce outbound socket frames. Operators tune `flushWindowMs` to balance network frame overhead against delivery latency.

`fluxora_ws_broadcast_batch_flush_seconds` records, per batch flush, the age (in seconds) of the oldest event included in that flush.

**Bucket layout (seconds):**  
`0.0001` (0.1ms), `0.0005` (0.5ms), `0.001` (1ms), `0.0025` (2.5ms), `0.005` (5ms), `0.01` (10ms), `0.025` (25ms), `0.05` (50ms), `0.1` (100ms), `0.25` (250ms), `0.5` (500ms), `1.0` (1s), `2.5` (2.5s), `5.0` (5s).

**Zero-Overhead Guarantee:**  
When micro-batching is disabled (default `flushWindowMs: 0`, single-event-per-frame mode), this metric is a complete no-op with zero runtime overhead and zero histogram observations recorded.

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

## WebSocket Subscription Cardinality Gauge

A single stream with an unusually large subscriber count can drive disproportionate broadcast fan-out, consuming CPU and network bandwidth while increasing backpressure risk for every other stream. The subscription cardinality gauge reports the subscriber count for the top-N most-subscribed streams so operators can identify hot streams before they cause incidents.

### Metric

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `fluxora_ws_stream_subscriber_count` | Gauge | `stream_id` (application-assigned stream identifier) | Subscriber count for the top-N WebSocket streams by fan-out size. Only the N most-subscribed streams are reported (default N = 20). |

### Label cardinality and security

The `stream_id` label is the opaque stream identifier assigned by the application. It does not contain PII, client IPs, JWT subjects, or any user-controlled data.

Cardinality is bounded by `DEFAULT_WS_STREAM_CARDINALITY_TOP_N` (20) — at most 20 time-series are emitted at any point. The collector sorts streams by subscriber count descending, keeps the top N, and explicitly removes stale series for streams that drop below the N-th rank between collection cycles. This prevents:

- **Unbounded label growth** when many low-subscriber streams exist — only the top 20 are exposed.
- **Stale series** lingering after a stream's subscribers leave — stale labels are cleaned up on the next collection cycle.

An attacker cannot inflate Prometheus memory by creating many streams with a handful of subscribers each, because only the top-N are ever exposed regardless of how many total streams exist.

### Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `DEFAULT_WS_STREAM_CARDINALITY_TOP_N` | `20` | Maximum number of streams reported by the gauge. Exported from `src/metrics/wsBackpressure.ts`. |

### PromQL examples

Top-5 streams by subscriber count:

```promql
topk(5, fluxora_ws_stream_subscriber_count)
```

Alert: any single stream with more than 500 subscribers (potential hot-stream):

```promql
fluxora_ws_stream_subscriber_count > 500
```

Total subscribers across all top-N streams (approximation of broadcast fan-out):

```promql
sum(fluxora_ws_stream_subscriber_count)
```

### Thresholding strategy

- **`max(fluxora_ws_stream_subscriber_count) > 500` for > 5 min**: investigate the identified hot stream. High fan-out magnifies the cost of every broadcast event — one slow client can trigger backpressure for all other subscribers on that stream.
- **`topk(1, fluxora_ws_stream_subscriber_count)` divergence from `sum(fluxora_ws_stream_subscriber_count)`**: one stream dominates the total subscriber count, indicating fan-out concentration risk.
- **Correlation with `fluxora_ws_slow_clients` rising**: a hot stream with slow clients compounds backpressure; identify the stream from the cardinality gauge and the slow clients from the per-client backpressure gauge.

### Affected source files

- `src/metrics/wsBackpressure.ts` — `wsStreamSubscriberCount` gauge definition + `collectStreamSubscriberCardinality` helper
- `src/ws/hub.ts` — `_getStreamSubscriptions()` accessor exposing the internal `streamSubscriptions` map
- `tests/ws/hub.subscriptionCardinality.test.ts` — top-N cap, stale-series removal, empty-hub, and reset assertions

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

### Subscriber callback errors

When a live SSE subscriber callback throws, Fluxora keeps fan-out isolated (other subscribers still run) but emits both:

1. a structured error log
2. a Prometheus counter

**Metric**

- Name: `fluxora_sse_subscriber_errors_total`
- Type: Counter
- Label: `reason` (bounded enum)

This metric increments on thrown subscriber callbacks.

**Security**

SSE payloads and other stream-level data are not included in the log/metric labels (only `streamId` is logged; the payload is not logged).


## Webhook Circuit Breaker Metrics

Outbound webhook delivery uses a per-consumer-URL circuit breaker to avoid hammering failing endpoints.
The `fluxora_webhook_circuit_breaker_transitions_total` counter tracks every state change so operators
can build dashboards and alert on consumer endpoint degradation.

### `fluxora_webhook_circuit_breaker_transitions_total`

A Prometheus **Counter** that increments on every circuit-breaker state transition.

| Label | Values | Description |
|-------|--------|-------------|
| `from_state` | `closed`, `open`, `half-open` | State before the transition |
| `to_state` | `closed`, `open`, `half-open` | State after the transition |
| `consumer_hash` | 16-char hex string | SHA-256 of the consumer URL, truncated to 16 hex characters |

**Cardinality bounds:**
The `consumer_hash` label is a fixed 16-character hex digest derived from `SHA-256(consumer_url)`.
The raw URL is **never** exposed as a label, preventing:
- Unbounded cardinality from arbitrary customer endpoint URLs
- PII or credential leakage through metric labels

Both the Redis-backed (`RedisWebhookCircuitBreakerStore`) and in-memory-fallback
(`InMemoryWebhookCircuitBreakerStore`) code paths emit this metric, so counters remain
accurate during a Redis outage.

### State machine

```
closed ──(threshold reached)──▸ open
 open  ──(reset period elapsed)──▸ half-open
half-open ──(probe succeeds)──▸ closed
half-open ──(probe fails)──▸ open
```

### PromQL examples

**Total transitions into `open` state** (circuit breaker tripping rate):

```promql
sum(rate(fluxora_webhook_circuit_breaker_transitions_total{to_state="open"}[5m])) by (consumer_hash)
```

**Breakers currently in `open` state** (approximation — count recent open→half-open and closed→open transitions minus recoveries):

```promql
sum(increase(fluxora_webhook_circuit_breaker_transitions_total{to_state="open"}[1h])) by (consumer_hash)
-
sum(increase(fluxora_webhook_circuit_breaker_transitions_total{from_state="open"}[1h])) by (consumer_hash)
```

**Half-open probes succeeding vs failing** (recovery health):

```promql
sum(rate(fluxora_webhook_circuit_breaker_transitions_total{from_state="half-open",to_state="closed"}[5m]))
sum(rate(fluxora_webhook_circuit_breaker_transitions_total{from_state="half-open",to_state="open"}[5m]))
```

### Alerting rules

```yaml
groups:
  - name: webhook-circuit-breaker
    rules:
      - alert: WebhookCircuitBreakerOpenRateHigh
        expr: sum(rate(fluxora_webhook_circuit_breaker_transitions_total{to_state="open"}[5m])) by (consumer_hash) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Webhook circuit breaker tripping frequently for consumer {{ $labels.consumer_hash }}"

      - alert: WebhookCircuitBreakerStuckOpen
        expr: increase(fluxora_webhook_circuit_breaker_transitions_total{from_state="half-open",to_state="open"}[1h]) > 3
        labels:
          severity: critical
        annotations:
          summary: "Webhook consumer {{ $labels.consumer_hash }} circuit breaker repeatedly re-opening — endpoint may be down"
```

### WebSocket Micro-Batching Metrics

| Metric Name | Type | Description | Buckets / Labels |
| :--- | :--- | :--- | :--- |
| `fluxora_ws_broadcast_batch_flush_seconds` | Histogram | Latency in seconds from enqueuing the oldest event in a batch to flushing the batch frame over the WebSocket. | `[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5]` |

---

## Indexer Batch RED Metrics

The indexer's per-ledger-batch processing step in `src/indexer/service.ts` is
instrumented with a Rate / Errors / Duration triad defined in
`src/metrics/indexerRed.ts`. It deliberately mirrors the HTTP RED metrics
(`http_requests_total` / `http_request_duration_seconds`) so an indexer
dashboard can reuse the same PromQL shapes and panel layouts as the HTTP one.

### Metric-to-metric parity with HTTP

| Concern | HTTP | Indexer batch |
| :--- | :--- | :--- |
| Rate | `http_requests_total` | `indexer_batches_processed_total` |
| Errors | 5xx slice of `http_requests_total` | `indexer_batch_errors_total` |
| Duration | `http_request_duration_seconds` | `indexer_batch_duration_seconds` |
| "which work" label | `route` | `contract_id` |
| "what happened" label | `status_code` | `outcome` |

### Metrics

| Metric Name | Type | Description | Labels / Buckets |
| :--- | :--- | :--- | :--- |
| `indexer_batches_processed_total` | Counter | Every batch processing step executed, successful or not. | `contract_id`, `outcome` (`success` \| `error`) |
| `indexer_batch_errors_total` | Counter | Batch processing steps that threw. | `contract_id`, `error_source` (`stellar_rpc` \| `local`), `error_type` |
| `indexer_batch_duration_seconds` | Histogram | Wall-clock duration of one batch processing step. | `contract_id`, `outcome`; buckets `[0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]` |

**What counts as one batch processing step?** One iteration of the `replayEvents`
loop body that calls `processBatch` — fetch the batch, insert into
`contract_events`, advance the cursor, `COMMIT`. Loop guards (shutdown,
leadership, replay budget) run *outside* the timer, so the histogram measures
work rather than control flow.

A batch that fetched zero rows (source exhausted ahead of the counted total) is
still recorded as one `success`: a unit of work was performed. This is the one
place where `indexer_batches_processed_total` can exceed the pre-existing
`indexer_replay_batches_committed_total`, which counts only batches that reached
`COMMIT`.

### `error_source` — upstream vs. local failures

The `error_source` label answers "is this our problem or the RPC provider's?"
without opening a log.

| `error_source` | Origin | `error_type` values |
| :--- | :--- | :--- |
| `stellar_rpc` | A call into `src/services/stellar-rpc.ts` failed. Retrying the indexer will not help until the provider recovers. | `timeout`, `network`, `provider`, `circuit_open`, `cancelled` |
| `local` | The failure was raised inside the indexer process. Actionable by the indexer owner. | `db_pool_exhausted`, `db_query_timeout`, `db_duplicate_entry`, `db_error`, `unknown` |

`error_type` for `stellar_rpc` mirrors the `RpcFailureKind` union exported by
`src/services/stellar-rpc.ts` (lower-snake-cased). Classification is structural
— it matches on the error's `name` and `kind`, so a `RpcProviderError` rethrown
by an intermediate layer is still attributed to `stellar_rpc`.

Every increment of `indexer_batch_errors_total` is paired with an
`outcome="error"` increment of `indexer_batches_processed_total`, so the error
ratio is well-defined against either denominator.

### Dashboard queries

```promql
# Rate — batches/sec being processed, per contract
sum(rate(indexer_batches_processed_total[5m])) by (contract_id)

# Errors — overall error ratio
sum(rate(indexer_batch_errors_total[5m]))
  / sum(rate(indexer_batches_processed_total[5m]))

# Errors — is it us or the provider?
sum(rate(indexer_batch_errors_total[5m])) by (error_source, error_type)

# Duration — p50 / p95 / p99 of a batch
histogram_quantile(0.50, sum(rate(indexer_batch_duration_seconds_bucket[5m])) by (le))
histogram_quantile(0.95, sum(rate(indexer_batch_duration_seconds_bucket[5m])) by (le))
histogram_quantile(0.99, sum(rate(indexer_batch_duration_seconds_bucket[5m])) by (le))
```

### Suggested alerts

```yaml
groups:
  - name: indexer-red
    rules:
      - alert: IndexerBatchErrorRateHigh
        expr: |
          sum(rate(indexer_batch_errors_total[5m]))
            / sum(rate(indexer_batches_processed_total[5m])) > 0.05
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "More than 5% of indexer batches are failing"

      - alert: IndexerUpstreamRpcDegraded
        expr: sum(rate(indexer_batch_errors_total{error_source="stellar_rpc"}[5m])) > 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Indexer batches failing on Stellar RPC ({{ $labels.error_type }}) — upstream, not local"

      - alert: IndexerBatchLatencyHigh
        expr: |
          histogram_quantile(0.99,
            sum(rate(indexer_batch_duration_seconds_bucket[5m])) by (le)) > 10
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "p99 indexer batch duration above 10s — replays will miss their budget"
```

### Cardinality and data-safety notes

- `contract_id` is trimmed and truncated to 64 characters (the same convention
  as `indexer_replay_*`), and blank/absent ids collapse to `unknown`. A
  malformed replay request cannot mint an unbounded label value.
- Replay is reachable only via `POST /api/indexer/events/replay`, which requires
  a JWT carrying `Permission.INDEXER_REPLAY`, so `contract_id` values are not
  attacker-supplied from unauthenticated traffic.
- `error_source` and `error_type` are drawn from closed unions in
  `src/metrics/indexerRed.ts`. **Raw error messages are never used as label
  values**, so an error carrying user input, credentials, or PII cannot leak
  into the `/metrics` payload or inflate cardinality.
- The classifier is total: a thrown string, `null`, or an unrecognised object
  yields `local` / `unknown` rather than throwing. Metric recording can never
  mask the original batch failure — the error is always rethrown to the caller.


## Config reload metrics (SIGHUP)

Hot-config refresh emits the following Prometheus series (no secret labels):

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `fluxora_config_reload_total` | Counter | `result` (`success` / `failure` / `noop`) | Reload attempts |
| `fluxora_config_reload_duration_seconds` | Histogram | — | Refresh wall-clock duration |
| `fluxora_config_reload_generation` | Gauge | — | Last successfully applied generation |

See also [env-reload-behavior.md](./env-reload-behavior.md).
