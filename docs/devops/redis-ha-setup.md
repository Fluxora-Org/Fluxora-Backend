# Redis HA Setup

Fluxora supports three Redis deployment modes controlled by the `REDIS_MODE` environment variable.

## Modes

| Mode | Use case | Failover |
|------|----------|----------|
| `standalone` (default) | Development / single-node | Manual |
| `sentinel` | Production HA, single primary | Automatic via Sentinel |
| `cluster` | Production HA, horizontal scale | Automatic via Cluster |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_MODE` | No | `standalone` | `standalone` \| `sentinel` \| `cluster` |
| `REDIS_URL` | No | `redis://localhost:6379` | Connection URL (password extracted from here for all modes) |
| `REDIS_ENABLED` | No | `true` | Set `false` to disable Redis (uses no-op client) |
| `REDIS_SENTINEL_HOSTS` | sentinel only | — | Comma-separated `host:port` list of Sentinel nodes |
| `REDIS_SENTINEL_NAME` | No | `mymaster` | Sentinel master name |
| `REDIS_CLUSTER_NODES` | cluster only | — | Comma-separated `host:port` list of cluster seed nodes |

---

## Standalone (default)

```env
REDIS_MODE=standalone
REDIS_URL=redis://:yourpassword@redis.internal:6379
```

No additional configuration needed. Suitable for development and single-node deployments.

---

## Sentinel

Requires at least three Sentinel processes for quorum.

```env
REDIS_MODE=sentinel
REDIS_URL=redis://:yourpassword@ignored:6379   # password is read from here
REDIS_SENTINEL_HOSTS=sentinel1:26379,sentinel2:26379,sentinel3:26379
REDIS_SENTINEL_NAME=mymaster                   # must match sentinel.conf
```

The `REDIS_URL` hostname is ignored in sentinel mode; only the password is extracted from it.

### Sentinel configuration (`sentinel.conf`)

```
sentinel monitor mymaster 10.0.0.10 6379 2
sentinel auth-pass mymaster yourpassword
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 60000
sentinel parallel-syncs mymaster 1
```

---

## Cluster

Requires at least three primary nodes (six nodes recommended: three primaries + three replicas).

```env
REDIS_MODE=cluster
REDIS_URL=redis://:yourpassword@ignored:6379   # password is read from here
REDIS_CLUSTER_NODES=node1:7000,node2:7001,node3:7002
```

Provide at least one seed node; ioredis discovers the rest automatically via `CLUSTER NODES`.

---

## Structured Log Events

The client emits structured JSON log lines on lifecycle events:

| Event | Level | `mode` field |
|-------|-------|-------------|
| `redis:connect` | `info` | current mode |
| `redis:ready` | `info` | current mode |
| `redis:reconnecting` | `warn` | current mode |
| `redis:error` | `error` | current mode + `error` message |
| `redis:close` | `warn` | current mode |
| `redis:end` | `warn` | current mode |

Example log line:
```json
{"level":"WARN","ts":"2026-05-31T17:00:00.000Z","msg":"redis:reconnecting","mode":"sentinel"}
```

Configure alerts on `redis:reconnecting` and `redis:error` to detect failover events.

---

## Security Notes

- **Passwords** are always sourced from `REDIS_URL` and never logged.
- `REDIS_URL` should be stored in a secrets manager (AWS Secrets Manager, Vault) and injected at runtime — not committed to source control.
- Use TLS (`rediss://`) in production. ioredis supports TLS natively; set `REDIS_URL=rediss://...` and configure `tls` options if using self-signed certificates.
- Restrict network access to Redis ports (6379, 26379, 7000–7002) via security groups / firewall rules.

---

## Disabling Redis

Set `REDIS_ENABLED=false` to use the `NoOpRedisClient`. All Redis operations become no-ops, which disables rate limiting and idempotency features. Suitable for local development without a Redis instance.

---

## Troubleshooting

**`REDIS_SENTINEL_HOSTS is required when REDIS_MODE=sentinel`**
→ Set `REDIS_SENTINEL_HOSTS` to a comma-separated list of `host:port` pairs.

**`REDIS_CLUSTER_NODES is required when REDIS_MODE=cluster`**
→ Set `REDIS_CLUSTER_NODES` to at least one seed node.

**`Invalid host:port entry`**
→ Check that each entry in `REDIS_SENTINEL_HOSTS` / `REDIS_CLUSTER_NODES` is in `host:port` format with a numeric port.

**Repeated `redis:reconnecting` logs**
→ Check network connectivity between the app and Redis nodes. Verify firewall rules and that the Redis/Sentinel/Cluster processes are running.
