# Datadog Log Integration

Fluxora emits newline-delimited JSON to stdout. The Datadog Agent can collect, parse, and enrich these logs with no custom pipeline code.

## Agent configuration

Add a log collection config for the Fluxora container. With Docker:

```yaml
# /etc/datadog-agent/conf.d/fluxora.d/conf.yaml
logs:
  - type: docker
    source: fluxora
    service: fluxora-backend
    log_processing_rules:
      - type: multi_line
        name: new_log_start
        pattern: '^\{'   # each JSON object starts a new log line
```

For a file-based deployment (stdout redirected to a file):

```yaml
logs:
  - type: file
    path: /var/log/fluxora/app.log
    source: fluxora
    service: fluxora-backend
```

## JSON log parsing

Datadog auto-parses JSON logs when the `source` is set. The following Fluxora fields map directly to Datadog reserved attributes:

| Fluxora field | Datadog reserved attribute | Notes |
|---------------|---------------------------|-------|
| `timestamp` | `date` | ISO 8601; Datadog parses automatically |
| `level` | `status` | Remapped via pipeline (see below) |
| `message` | `message` | Used as the log body |

### Log pipeline — attribute remapping

Create a **Log Pipeline** in Datadog → Logs → Configuration → Pipelines:

1. **Filter**: `source:fluxora`
2. **Processors**:

   a. **JSON Parser** — parse the raw log body into attributes (auto-applied for JSON sources).

   b. **Remapper** — map `level` → `status`:
   ```
   Source attributes: level
   Target attribute:  status
   ```

   c. **Remapper** — map `message` → `message` (already the default; no action needed).

   d. **Date Remapper** — set `timestamp` as the official log date:
   ```
   Source attributes: timestamp
   ```

   e. **Attribute Remapper** — promote `context.correlation_id` to a top-level facet:
   ```
   Source attributes: context.correlation_id
   Target attribute:  correlation_id
   ```

## Tagging

Add the following tags to every log via the Agent config or the pipeline:

```yaml
# datadog.yaml or container labels
tags:
  - env:production
  - service:fluxora-backend
  - version:<APP_VERSION>
```

Or via Docker labels:

```yaml
labels:
  com.datadoghq.ad.logs: '[{"source":"fluxora","service":"fluxora-backend"}]'
  com.datadoghq.tags: "env:production,service:fluxora-backend"
```

## Sensitive field handling

Fluxora redacts PII before emission (see [observability.md](../observability.md#pii-scrubbing)). No additional Datadog scrubbing rules are required for the fields listed in the PII policy.

As a defence-in-depth measure, add a **Scrubbing Rule** in the Agent config to catch any unexpected credential leakage:

```yaml
# datadog.yaml
logs_config:
  processing_rules:
    - type: mask_sequences
      name: mask_bearer_tokens
      replace_placeholder: "[REDACTED]"
      pattern: 'Bearer\s+[A-Za-z0-9\-._~+/]+'
    - type: mask_sequences
      name: mask_stellar_keys
      replace_placeholder: "G****"
      pattern: 'G[A-Z2-7]{55}'
```

## Log-based monitors

Suggested monitors to create in Datadog:

| Monitor | Query | Threshold |
|---------|-------|-----------|
| Error rate spike | `source:fluxora status:error` | > 10 errors / 5 min |
| Slow query alert | `source:fluxora "Slow postgres query"` | > 5 / min |
| Auth failures | `source:fluxora "Invalid admin credentials"` | > 3 / min |

## Verification

After deploying, confirm logs appear with:

```bash
# Tail live logs in Datadog CLI
datadog-agent stream-logs --filters "source:fluxora"
```

Expected output for a healthy service:
```json
{"timestamp":"...","level":"info","message":"Stream created","context":{"id":"stream-abc"}}
```
