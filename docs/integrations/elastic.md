# Elastic / ECS Log Integration

Fluxora emits newline-delimited JSON to stdout. This guide covers ingestion via Filebeat and normalisation to the [Elastic Common Schema (ECS)](https://www.elastic.co/guide/en/ecs/current/index.html).

## Filebeat configuration

```yaml
# filebeat.yml
filebeat.inputs:
  - type: container
    paths:
      - /var/lib/docker/containers/*/*.log
    processors:
      - add_docker_metadata:
          host: "unix:///var/run/docker.sock"

  # Or for file-based deployment:
  # - type: log
  #   paths:
  #     - /var/log/fluxora/app.log
  #   json.keys_under_root: true
  #   json.add_error_key: true

processors:
  - decode_json_fields:
      fields: ["message"]
      target: ""
      overwrite_keys: true
      add_error_key: true

  # Map Fluxora fields to ECS
  - rename:
      fields:
        - from: "message"
          to: "log.original"
        - from: "level"
          to: "log.level"
        - from: "timestamp"
          to: "@timestamp"
        - from: "error.message"
          to: "error.message"
        - from: "error.stack"
          to: "error.stack_trace"
        - from: "error.name"
          to: "error.type"
        - from: "context.correlation_id"
          to: "trace.id"
        - from: "context.duration_ms"
          to: "event.duration"
      ignore_missing: true
      fail_on_error: false

  - add_fields:
      target: "service"
      fields:
        name: fluxora-backend
        environment: "${ENVIRONMENT:production}"

output.elasticsearch:
  hosts: ["${ELASTICSEARCH_HOST:localhost:9200}"]
  index: "fluxora-logs-%{+yyyy.MM.dd}"
  pipeline: "fluxora-logs"
```

## ECS field mapping

| Fluxora field | ECS field | Type | Notes |
|---------------|-----------|------|-------|
| `timestamp` | `@timestamp` | date | ISO 8601 |
| `level` | `log.level` | keyword | `debug`/`info`/`warn`/`error` |
| `message` | `message` | text | Log body |
| `error.name` | `error.type` | keyword | Error class name |
| `error.message` | `error.message` | text | PII-scrubbed |
| `error.stack` | `error.stack_trace` | wildcard | PII-scrubbed |
| `context.correlation_id` | `trace.id` | keyword | Request correlation |
| `context.duration_ms` | `event.duration` | long | Convert ms → ns in pipeline |
| `context.query_hash` | `db.statement` | keyword | Safe hash, not raw SQL |
| `context.table_hint` | `db.sql.table` | keyword | Extracted table name |

## Elasticsearch ingest pipeline

Create the pipeline via the Kibana Dev Tools console or the API:

```json
PUT _ingest/pipeline/fluxora-logs
{
  "description": "Normalise Fluxora JSON logs to ECS",
  "processors": [
    {
      "json": {
        "field": "message",
        "target_field": "_parsed",
        "ignore_failure": true
      }
    },
    {
      "rename": {
        "field": "_parsed.timestamp",
        "target_field": "@timestamp",
        "ignore_missing": true
      }
    },
    {
      "rename": {
        "field": "_parsed.level",
        "target_field": "log.level",
        "ignore_missing": true
      }
    },
    {
      "rename": {
        "field": "_parsed.message",
        "target_field": "message",
        "ignore_missing": true
      }
    },
    {
      "rename": {
        "field": "_parsed.error.name",
        "target_field": "error.type",
        "ignore_missing": true
      }
    },
    {
      "rename": {
        "field": "_parsed.error.message",
        "target_field": "error.message",
        "ignore_missing": true
      }
    },
    {
      "rename": {
        "field": "_parsed.error.stack",
        "target_field": "error.stack_trace",
        "ignore_missing": true
      }
    },
    {
      "rename": {
        "field": "_parsed.context.correlation_id",
        "target_field": "trace.id",
        "ignore_missing": true
      }
    },
    {
      "script": {
        "description": "Convert duration_ms to nanoseconds for ECS event.duration",
        "lang": "painless",
        "source": "if (ctx._parsed?.context?.duration_ms != null) { ctx.event = ctx.event ?: [:]; ctx.event.duration = (long)(ctx._parsed.context.duration_ms * 1_000_000); }",
        "ignore_failure": true
      }
    },
    {
      "remove": {
        "field": "_parsed",
        "ignore_missing": true
      }
    }
  ]
}
```

## Index template

```json
PUT _index_template/fluxora-logs
{
  "index_patterns": ["fluxora-logs-*"],
  "template": {
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 1
    },
    "mappings": {
      "properties": {
        "@timestamp":        { "type": "date" },
        "log.level":         { "type": "keyword" },
        "message":           { "type": "text" },
        "trace.id":          { "type": "keyword" },
        "error.type":        { "type": "keyword" },
        "error.message":     { "type": "text" },
        "error.stack_trace": { "type": "wildcard" },
        "event.duration":    { "type": "long" },
        "db.sql.table":      { "type": "keyword" },
        "db.statement":      { "type": "keyword" },
        "service.name":      { "type": "keyword" },
        "service.environment": { "type": "keyword" }
      }
    }
  }
}
```

## Sensitive field handling

Fluxora redacts PII before emission (see [observability.md](../observability.md#pii-scrubbing)). As defence-in-depth, add a Logstash filter or Elasticsearch ingest processor to catch any unexpected leakage:

```json
{
  "gsub": {
    "field": "message",
    "pattern": "G[A-Z2-7]{55}",
    "replacement": "G****",
    "ignore_missing": true
  }
}
```

## Kibana saved search

After ingestion, create a saved search in Kibana with:

- Index pattern: `fluxora-logs-*`
- Columns: `@timestamp`, `log.level`, `message`, `trace.id`, `error.type`
- Filter: `service.name: fluxora-backend`

## Verification

```bash
# Check documents are arriving
curl -s "http://localhost:9200/fluxora-logs-*/_count" | jq .count

# Sample a recent error log
curl -s "http://localhost:9200/fluxora-logs-*/_search" \
  -H "Content-Type: application/json" \
  -d '{"query":{"term":{"log.level":"error"}},"size":1}' | jq .hits.hits[0]._source
```
