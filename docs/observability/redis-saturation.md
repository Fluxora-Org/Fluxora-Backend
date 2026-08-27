# Redis Connection Saturation Metrics

Fluxora Backend exposes three Prometheus Gauges that track the health and saturation of ioredis (Redis) connections. These metrics provide early warning of a slow or overloaded Redis instance before it causes application-level timeouts.

## Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `redis_command_queue_length` | Gauge | `instance` | Number of commands waiting in the Redis command queue |
| `redis_connection_status` | Gauge | `instance` | Connection status as a numeric enum (see below) |
| `redis_queue_length_warnings_total` | Counter | `instance` | Total number of times the command queue exceeded the warning threshold |

The `instance` label identifies which logical Redis connection the metric represents (e.g. `default`, `dedup`, `idempotency`). Currently all connections use the `default` label.

### Connection status enum values

| Value | Status | Meaning |
|---|---|---|
| 0 | `end` | Connection fully closed |
| 1 | `connecting` / `wait` | Initial connect in progress or waiting to connect |
| 2 | `reconnecting` | Automatic reconnect in progress |
| 3 | `ready` / `connect` | Authenticated and ready to accept commands |
| 4 | `close` | Connection closed (may re-enter connecting) |
| -1 | `unknown` | Unexpected status string |

## How it works

A background polling interval (default: 10 seconds) reads `client.commandQueue.length` and `client.status` from every tracked ioredis instance and pushes the values into the Prometheus gauges.

The polling loop is started by calling `startRedisSaturationMetrics()` in `src/redis/client.ts`, which is wired from `src/app.ts` alongside `startRuntimeMetrics()`.

### Rate-limited warnings

When the command queue length exceeds `REDIS_QUEUE_WARNING_THRESHOLD` (default: **500**), a structured warning log is emitted:

```json
{
  "level": "warn",
  "message": "redis:queue_length_exceeded",
  "instance": "default",
  "commandQueueLength": 723,
  "threshold": 500,
  "status": "ready"
}
```

To prevent log floods, successive warnings for the same instance are suppressed for `REDIS_QUEUE_WARNING_RATE_LIMIT_MS` (default: **30 000 ms / 30 s**).

### Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `REDIS_SATURATION_POLL_INTERVAL_MS` | 10000 | Polling interval in milliseconds |
| `REDIS_QUEUE_WARNING_THRESHOLD` | 500 | Queue length that triggers a warning |
| `REDIS_QUEUE_WARNING_RATE_LIMIT_MS` | 30000 | Minimum gap between successive warnings (ms) |

## Prometheus scrape output

```prometheus
# HELP redis_command_queue_length Current number of commands waiting in the Redis command queue, labeled by instance
# TYPE redis_command_queue_length gauge
redis_command_queue_length{instance="default"} 0

# HELP redis_connection_status Redis connection status (0=end, 1=connecting, 2=reconnecting, 3=ready, 4=close, -1=unknown), labeled by instance
# TYPE redis_connection_status gauge
redis_connection_status{instance="default"} 3

# HELP redis_queue_length_warnings_total Total number of times the Redis command queue exceeded the warning threshold, labeled by instance
# TYPE redis_queue_length_warnings_total counter
redis_queue_length_warnings_total{instance="default"} 0
```

## Alerting rules

```yaml
groups:
  - name: redis_saturation
    rules:
      # Alert when the command queue stays above 100 for more than 1 minute.
      # In normal operation the queue should be near 0 — sustained queuing
      # indicates Redis cannot keep up with the command rate.
      - alert: RedisQueueBuildup
        expr: redis_command_queue_length > 100
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Redis instance {{ $labels.instance }} has {{ $value }} queued commands"

      # Critical alert when queue exceeds 1000 (default threshold).
      # At this point Redis is severely degraded and downstream latency is
      # likely affecting API response times.
      - alert: RedisQueueCritical
        expr: redis_command_queue_length > 1000
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "Redis instance {{ $labels.instance }} command queue critically high ({{ $value }})"

      # Alert when the connection status is not 'ready' for 10 seconds.
      # A transient reconnect (< 5 s) is usually harmless, but prolonged
      # disconnection will impact the rate limiter, dedup cache, and other
      # Redis-backed modules.
      - alert: RedisConnectionDegraded
        expr: redis_connection_status != 3
        for: 10s
        labels:
          severity: critical
        annotations:
          summary: "Redis instance {{ $labels.instance }} is in status {{ $value }} (expected: ready)"

      # Spike detection: any increase in the warning counter in a 5-minute
      # window indicates the queue threshold was hit.
      - alert: RedisQueueThresholdHit
        expr: increase(redis_queue_length_warnings_total[5m]) > 0
        labels:
          severity: warning
        annotations:
          summary: "Redis instance {{ $labels.instance }} hit the queue-length warning threshold in the last 5 minutes"
```

## Grafana dashboard queries

```promql
# Command queue depth over time
redis_command_queue_length

# Connection status (should be stable at 3)
redis_connection_status

# Warning rate
rate(redis_queue_length_warnings_total[5m])
```

## Security notes

- The `instance` label value is set exclusively from the `instanceName` parameter in the tracking code (`src/redis/client.ts`), which is always a hardcoded application constant (e.g. `"default"`).
- It is **never** derived from HTTP request headers, query parameters, or any user-supplied input, preventing label-injection attacks that could cause cardinality explosions or metric spoofing.
- The `/metrics` endpoint is protected from public access. See `src/routes/metrics.ts` for the existing token-auth middleware.

## References

- Source: `src/metrics/redisPool.ts` — gauge definitions and `syncRedisGauges()`
- Source: `src/redis/client.ts` — polling loop, tracking, and rate-limited warnings
- Integration: `src/app.ts` — lifecycle hooks (start/stop on app start/shutdown)
- Similar pattern: `docs/observability/database-metrics.md` — pg.Pool connection pool metrics
