# Observability

## Log schema

All log lines are emitted as newline-delimited JSON to stdout. The top-level shape is defined by `LogEntry` in `src/config/logger.ts`.

### Top-level fields

| Field | Type | Always present | Description |
|-------|------|---------------|-------------|
| `timestamp` | ISO 8601 string | ✓ | UTC emission time, e.g. `2026-05-29T16:00:00.000Z` |
| `level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | ✓ | Severity |
| `message` | string | ✓ | Human-readable description of the event (Stellar keys auto-masked) |
| `context` | object | optional | Structured key/value pairs specific to the event |
| `error` | object | optional | Present only on `error`-level entries |

### `error` sub-object

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Error class name, e.g. `TypeError` |
| `message` | string | Error message (PII-scrubbed) |
| `stack` | string | Stack trace (PII-scrubbed), omitted when unavailable |

### Sample log lines

Info:
```json
{"timestamp":"2026-05-29T16:00:00.000Z","level":"info","message":"Stream created","context":{"id":"stream-abc","action":"created"}}
```

Error with stack trace:
```json
{"timestamp":"2026-05-29T16:00:01.000Z","level":"error","message":"Database unavailable","error":{"name":"Error","message":"Connection refused","stack":"Error: Connection refused\n    at Pool.connect ..."}}
```

Slow query warn:
```json
{"timestamp":"2026-05-29T16:00:02.000Z","level":"warn","message":"Slow postgres query","context":{"query_hash":"a3f1c2d4e5b6a7f8","duration_ms":1234,"table_hint":"streams","correlation_id":"req_abc123"}}
```

## PII scrubbing

All log entries pass through `src/pii/sanitizer.ts` before emission. The deny-list is the single source of truth in `src/pii/policy.ts`. The input object is never mutated — a deep clone is always returned.

### Redacted fields (replaced with `[REDACTED]`)

| Field | Classification | Reason |
|-------|---------------|--------|
| `sender` / `recipient` | SENSITIVE | Stellar public keys — pseudonymous but correlatable |
| `authorization` | RESTRICTED | Bearer token / credentials |
| `authToken` | RESTRICTED | Authentication token |
| `password` | RESTRICTED | Credential |
| `secret` | RESTRICTED | Secret value |
| `token` | RESTRICTED | Token value |
| `credential` | RESTRICTED | Credential value |
| `key` | RESTRICTED | Potentially sensitive key |
| `private-key` / `api-key` | RESTRICTED | Key material |
| `access-token` / `refresh-token` | RESTRICTED | OAuth tokens |
| `session-id` / `cookie` / `set-cookie` | RESTRICTED | Session identifiers |
| `ipAddress` | RESTRICTED | Client IP — never persisted |
| `userAgent` | INTERNAL | Browser fingerprint fragment |
| `x-api-key` | RESTRICTED | API key header |
| `idempotency-key` | INTERNAL | Request correlation key |

Field matching is case-insensitive. Non-string sensitive values are fully replaced with `[REDACTED]`.

### Stellar key masking

Stellar public keys (`G` + 55 base-32 chars) found in any string field — including free-form message text and stack traces — are partially masked: first 4 and last 4 characters are preserved, the middle is replaced with `..`.

Example: `GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7` → `GAAZ..CWN7`

### Fields never redacted

Financial amounts (`depositAmount`, `ratePerSecond`) and stream metadata (`id`, `status`, `startTime`) are classified PUBLIC or INTERNAL and pass through unchanged. The sanitizer never coerces strings to numbers, preserving decimal precision.

## Log levels

| Level | Console method | Use |
|-------|---------------|-----|
| `debug` | `console.log` | Development diagnostics; disabled in production by default |
| `info` | `console.log` | Normal operational events |
| `warn` | `console.warn` | Degraded conditions, recoverable errors |
| `error` | `console.error` | Failures requiring operator attention |

Set the minimum level via the `Logger` constructor or `setLevel()`. Default: `info`.

## Slow-query logging

Every PostgreSQL query executed through `src/db/pool.ts` is timed. When the duration meets or exceeds `SLOW_QUERY_THRESHOLD_MS`, a structured `WARN` log entry is emitted and a Prometheus counter is incremented.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SLOW_QUERY_THRESHOLD_MS` | `1000` | Threshold in ms. Set to `0` to disable slow-query logging entirely. |

### Log fields

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

## Log aggregation integrations

See the platform-specific guides:

- [Datadog](integrations/datadog.md) — Agent log pipeline, JSON parsing, attribute remapping
- [Elastic / ECS](integrations/elastic.md) — Filebeat config, ECS field mapping, index template
