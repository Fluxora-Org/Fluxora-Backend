# Deployment Guide

## Tiered Startup Dependency Probing

Before Fluxora accepts any HTTP traffic it runs a two-tier connectivity check
against every external dependency. This bounds the startup delay and surfaces
misconfiguration failures early so on-call engineers see a clear structured log
entry — not a cryptic 503 from the load balancer — within seconds of a bad
deploy.

### Tiers

| Tier | Dependencies | Failure behaviour |
|------|-------------|------------------|
| **hard** | PostgreSQL | Single probe attempt. On failure the process **exits immediately** with exit code 1. The structured `startup_probe:fatal` log includes the sanitised error and `"action": "process will exit"`. |
| **soft** | Redis, Stellar RPC | Retried with **decorrelated-jitter backoff** until either the probe succeeds or the total wall-clock budget (`STARTUP_PROBE_BUDGET_MS`) is exhausted. On budget exhaustion the service starts in **degraded mode** and the `startup_probe:degraded` log indicates which dependencies are unavailable. |

### Why this design?

- **Postgres is hard**: every write and read path requires a live pool
  connection. A misconfigured `DATABASE_URL` must be caught immediately — not
  after a readiness probe timeout that delays container restart.
- **Redis is soft**: rate-limiting, idempotency, and session stores fall back to
  in-memory or no-op implementations. A transient Redis restart during a rolling
  deploy should not kill the process.
- **Stellar RPC is soft**: the RPC tier has its own circuit breaker and cached
  fallbacks. Brief unavailability is tolerable; the service degrades gracefully
  rather than refusing all traffic.

### Configuration

All timeouts and the budget are configurable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `STARTUP_PROBE_BUDGET_MS` | `30000` | Total wall-clock budget (ms) for soft-tier retries. Set this below your container-orchestrator readiness timeout. |
| `STARTUP_PROBE_POSTGRES_TIMEOUT_MS` | `5000` | Per-attempt timeout (ms) for the single Postgres hard probe. |
| `STARTUP_PROBE_REDIS_TIMEOUT_MS` | `3000` | Per-attempt timeout (ms) for each Redis soft-probe retry attempt. |
| `STARTUP_PROBE_STELLAR_TIMEOUT_MS` | `5000` | Per-attempt timeout (ms) for each Stellar RPC soft-probe retry attempt. |

All values must be strictly greater than 0. The Zod schema rejects 0 or
negative values at boot with a `ConfigError`.

### Kubernetes readiness/liveness alignment

Set `STARTUP_PROBE_BUDGET_MS` to a value **lower** than your pod's
`initialDelaySeconds` so Fluxora can reach its degraded-or-healthy state before
the kubelet starts counting readiness failures.

```yaml
# Example: 30 s budget, probe starts after 35 s
readinessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 35
  periodSeconds: 10
  failureThreshold: 3
```

```
STARTUP_PROBE_BUDGET_MS=30000   # 30 s — leaves 5 s margin before kubelet checks
```

### Log events

Every stage emits a structured JSON log entry. Fields are always present in
each event; optional fields are marked with `?`.

#### `startup_probe:begin`
```json
{
  "level": "info",
  "message": "startup_probe:begin",
  "dependencies": [
    { "name": "postgres", "tier": "hard" },
    { "name": "redis",    "tier": "soft" },
    { "name": "stellar_rpc", "tier": "soft" }
  ],
  "budgetMs": 30000
}
```

#### `startup_probe:attempt`
```json
{
  "level": "info",
  "message": "startup_probe:attempt",
  "dependency": "postgres",
  "tier": "hard",
  "attempt": 1,
  "timeoutMs": 5000,
  "budgetRemainingMs": 29800    // soft tier only
}
```

#### `startup_probe:success`
```json
{
  "level": "info",
  "message": "startup_probe:success",
  "dependency": "postgres",
  "tier": "hard",
  "attempt": 1,
  "outcome": "success",
  "latencyMs": 42
}
```

#### `startup_probe:retry` *(soft tier only)*
```json
{
  "level": "warn",
  "message": "startup_probe:retry",
  "dependency": "redis",
  "tier": "soft",
  "attempt": 2,
  "outcome": "retry",
  "latencyMs": 3001,
  "error": "redis timed out after 3000 ms",
  "budgetRemainingMs": 24000
}
```

#### `startup_probe:degraded` *(soft tier only)*
```json
{
  "level": "warn",
  "message": "startup_probe:degraded",
  "dependency": "stellar_rpc",
  "tier": "soft",
  "attempts": 5,
  "outcome": "degraded",
  "latencyMs": 5002,
  "error": "stellar_rpc startup probe timed out after 5000 ms",
  "action": "service will start in degraded mode"
}
```

#### `startup_probe:fatal` *(hard tier only)*
```json
{
  "level": "error",
  "message": "startup_probe:fatal",
  "dependency": "postgres",
  "tier": "hard",
  "attempt": 1,
  "outcome": "fatal",
  "latencyMs": 5001,
  "error": "connect ECONNREFUSED [redacted-url]",
  "action": "process will exit"
}
```

#### `startup_probe:complete`
```json
{
  "level": "info",
  "message": "startup_probe:complete",
  "outcome": "degraded",
  "degradedDependencies": ["stellar_rpc"],
  "results": [
    { "name": "postgres",    "tier": "hard", "outcome": "success",  "attempts": 1, "latencyMs": 42 },
    { "name": "redis",       "tier": "soft", "outcome": "success",  "attempts": 3, "latencyMs": 12 },
    { "name": "stellar_rpc", "tier": "soft", "outcome": "degraded", "attempts": 5, "latencyMs": 5002 }
  ]
}
```

### Security

- All error messages emitted in logs are passed through `sanitiseErrorMessage()`
  (`src/health/checkers.ts`). Connection strings (e.g.
  `postgresql://user:pass@host/db`, `redis://admin:secret@host:6379`),
  passwords, and hostnames embedded in error strings are replaced with
  `[redacted-url]` or `[redacted-credentials]` before any log is written.
- The probe functions use transient, short-lived clients that are torn down
  immediately after each attempt — no connection pool pollution.
- `STARTUP_PROBE_*` timeout values are validated against a minimum of 1 by the
  Zod schema so they cannot be set to 0 to disable the timeout silently.

### On-call triage quick reference

| Log event | Meaning | Action |
|-----------|---------|--------|
| `startup_probe:fatal` | Postgres unreachable | Check `DATABASE_URL`, network policy, DB status |
| `startup_probe:degraded` for `redis` | Redis unreachable after budget | Check `REDIS_URL`, Redis cluster health |
| `startup_probe:degraded` for `stellar_rpc` | Stellar RPC unreachable after budget | Check `STELLAR_RPC_URL`, network egress |
| `startup_probe:complete` with `outcome: healthy` | All dependencies reachable | Normal startup |
| `startup_probe:complete` with `outcome: degraded` | One or more soft deps unavailable | Service started; investigate degraded deps |

---

## Docker Health Check Tuning

Fluxora's Docker container features parameterised health checks to accommodate different deployment environments.

**Build Arguments (Dockerfile):**
- `HEALTH_INTERVAL` (Default: `30s`): Time between Docker daemon health probes.
- `HEALTH_TIMEOUT` (Default: `5s`): Time before a Docker daemon probe fails.

**Runtime Environment Variables (App Level):**
- `HEALTH_CHECK_INTERVAL_MS` (Default: `30000`): Internal application polling interval.
- `HEALTH_CHECK_TIMEOUT_MS` (Default: `5000`): Maximum time allowed for internal liveness checks.

*Note: Runtime timeout values must be strictly greater than 0.*

## Blue/Green Deployment

Fluxora supports zero-downtime blue/green deployments by running two parallel
application slots (`blue` and `green`) against the same PostgreSQL and Redis
backends. Both slots share the same database schema and are migration-safe:
the `src/db/migrate.ts` guard ensures migrations are idempotent and can be
run concurrently by both slots without conflict.

### Setup

The `docker-compose.yml` includes two services:
- `app-blue` — listens on port 3000, `DEPLOYMENT_SLOT=blue`
- `app-green` — listens on port 3001, `DEPLOYMENT_SLOT=green`

Each service emits an `X-Fluxora-Deployment-Slot` response header on every
HTTP response, enabling a front-side load balancer or the e2e test suite to
verify which slot answered a request during a cutover.

### Cutover Procedure (Manual)

1. **Deploy new code to the inactive slot** (e.g. `app-green`):
   ```bash
   docker-compose up -d --no-deps --build app-green
   ```
2. **Wait for the new slot to become healthy**:
   ```bash
   curl -I http://localhost:3001/health
   # Verify X-Fluxora-Deployment-Slot: green
   ```
3. **Run migrations idempotently** (safe to run on either slot):
   ```bash
   docker-compose exec app-green pnpm run migrate
   ```
4. **Switch load balancer upstream** from port 3000 → 3001.
   - If using `nginx`:
     ```nginx
     upstream fluxora_backend {
       server localhost:3001;  # was 3000
     }
     ```
     Then reload: `nginx -s reload`
   - If using AWS ALB: update the target group to point to the new slot.
5. **Verify traffic is flowing** to the new slot:
   ```bash
   curl -I https://your-api-domain.com/health
   # Verify X-Fluxora-Deployment-Slot: green
   ```
6. **Leave the old slot running** for 10–15 minutes for rollback safety.
7. **Stop the old slot** once confident:
   ```bash
   docker-compose stop app-blue
   ```

### Cutover Procedure (Automated with HAProxy)

If using HAProxy with active health checks:
1. Deploy to the inactive slot and wait for health checks to pass.
2. Update HAProxy config to set the new slot's weight to 100 and the old slot to 0.
3. Reload HAProxy: `haproxy -f /etc/haproxy/haproxy.cfg -sf $(pidof haproxy)`
4. Drain the old slot and stop it after the drain period.

### Rollback Steps

If issues are detected after cutover:
1. **Switch load balancer back** to the old slot (port 3000 if rolling back from 3001).
2. **Verify the old slot is healthy**:
   ```bash
   curl -I http://localhost:3000/health
   ```
3. **Stop the problematic slot**:
   ```bash
   docker-compose stop app-green
   ```
4. **Investigate logs** from the failed slot:
   ```bash
   docker-compose logs app-green
   ```
5. **Fix and redeploy** to the inactive slot before attempting cutover again.

### Migration Safety

Both slots can run migrations concurrently because:
- `src/db/migrate.ts` uses node-pg-migrate's advisory locks to prevent
  concurrent execution of the same migration.
- The `pgmigrations` table tracks applied migrations by name; re-running an
  already-applied migration is a no-op.
- Schema changes are backwards-compatible: additive-only DDL (new columns,
  new tables) is safe; breaking changes require a multi-step deploy.

### Security Notes

- The `DEPLOYMENT_SLOT` env var is read at request time, not module load time,
  so a single container image can serve either slot.
- The header value is sanitized to `[a-z0-9-]+` to prevent header injection.
- Any non-conforming value falls back to `"blue"`.

### Testing

See `tests/app.blueGreen.test.ts` for header presence verification across
200/404/500 responses and DEPLOYMENT_SLOT env var mutation tests.

### gRPC Health Check (Kubernetes-native probes)

Kubernetes' built-in gRPC probes (`livenessProbe.grpc` / `readinessProbe.grpc`, and the standalone `grpc-health-probe` binary) speak the standard `grpc.health.v1.Health` protocol rather than plain HTTP. Fluxora can expose this alongside the existing HTTP `/health` endpoints, on a separate port so it never competes with API traffic.

**Runtime Environment Variables (App Level):**
- `GRPC_HEALTH_ENABLED` (Default: `false`): Enables the gRPC health service.
- `GRPC_HEALTH_PORT` (Default: `50051`): Port the gRPC health service binds to. Must differ from `PORT` (the HTTP port).

The service reuses the exact same `HealthCheckManager` dependency checks as `/health/ready` (`src/config/health.ts`) — it does not re-implement or duplicate any check logic, so the two surfaces cannot drift out of sync. `healthy` and `degraded` both map to `SERVING` (matching `/health/ready`'s 200 response for both statuses); `unhealthy` maps to `NOT_SERVING`.

**Security note:** like the internal HTTP endpoints documented above, the gRPC health port is intentionally unauthenticated — Kubernetes probes and `grpc-health-probe` don't send credentials. This port must **not** be exposed outside the cluster network (no public LoadBalancer/Ingress); bind it only to a `ClusterIP` service or rely on the pod's default internal-only networking.

**Example — `grpc-health-probe` (manual check):**
```bash
grpc-health-probe -addr=localhost:50051
```

**Example — Kubernetes probe configuration:**
```yaml
livenessProbe:
  grpc:
    port: 50051
readinessProbe:
  grpc:
    port: 50051
  periodSeconds: 10
```
