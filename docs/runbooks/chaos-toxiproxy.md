# Toxiproxy Chaos Engineering — Operations Runbook

> **Scope** Postgres (`src/db/pool.ts`) and Redis (`src/redis/client.ts`) fault
> injection using [Toxiproxy](https://github.com/Shopify/toxiproxy).
>
> **Audience** On-call engineers, SRE, and CI authors.
>
> **Related files**
> - `docker-compose.yml` — chaos profile services
> - `toxiproxy.config.json` — proxy seed configuration
> - `tests/incidents/toxiproxy.chaos.test.ts` — automated scenario tests
> - `src/config/health.ts` — `HealthCheckManager` / `HealthStatus`
> - `src/health/checkers.ts` — `createPostgresChecker`, `createRedisChecker`
> - `src/db/pool.ts` — `PoolExhaustedError`, `QueryTimeoutError`

---

## 1. Architecture overview

```
  backend / test process
        │
        ├─► toxi-postgres  127.0.0.1:5433 ──[toxics]──► chaos-postgres :5432
        └─► toxi-redis     127.0.0.1:6380 ──[toxics]──► chaos-redis    :6379
        │
        └─► toxiproxy mgmt API  127.0.0.1:8474
```

Toxiproxy intercepts the TCP stream between the application and each backend.
**Toxics** — pluggable fault injectors — are added and removed at runtime
through the management REST API without restarting any service.

### Proxy names (as in `toxiproxy.config.json`)

| Proxy | Downstream port | Upstream |
|---|---|---|
| `pg_proxy` | 5433 | chaos-postgres:5432 |
| `redis_proxy` | 6380 | chaos-redis:6379 |

---

## 2. Starting and stopping the chaos stack

```bash
# Start all chaos profile services (Toxiproxy + Postgres + Redis)
docker compose --profile chaos up -d

# Verify services are ready
docker compose --profile chaos ps
curl -s http://localhost:8474/proxies | jq .

# Tear down
docker compose --profile chaos down -v
```

> **Note** The management API port (8474) is bound to `127.0.0.1` and never
> exposed outside the local machine or CI runner. Toxiproxy itself has no
> authentication, so network isolation is the only access control.

---

## 3. Health status model

`src/config/health.ts` defines three statuses aggregated across all registered
checkers:

| Status | Meaning |
|---|---|
| `healthy` | All checkers pass with latency < `DEFAULT_DEGRADED_LATENCY_MS` (1 000 ms) |
| `degraded` | At least one checker reports high latency or partial failure |
| `unhealthy` | At least one checker throws / times out / returns an unexpected response |

Aggregation rule: `unhealthy` > `degraded` > `healthy`.  
A single `unhealthy` dependency makes the overall status `unhealthy`.

`src/health/checkers.ts` constants:

| Constant | Value |
|---|---|
| `DEFAULT_TIMEOUT_MS` | 5 000 ms |
| `DEFAULT_DEGRADED_LATENCY_MS` | 1 000 ms |

---

## 4. Fault scenarios

Each scenario below lists:
- The Toxiproxy toxic(s) to apply
- The **expected health status transitions**
- The application-layer error thrown (for programmatic assertions)
- The teardown (reset) step

### 4.1 Postgres — high latency (degraded)

**Inject**
```bash
curl -s -X POST http://localhost:8474/proxies/pg_proxy/toxics \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "pg_latency",
    "type": "latency",
    "stream": "upstream",
    "attributes": { "latency": 1500, "jitter": 0 }
  }'
```

**Expected health transitions**

| Phase | `postgres` checker | Overall |
|---|---|---|
| Before toxic | `healthy` (latency < 1 000 ms) | `healthy` |
| After toxic injected | `degraded` (latency ≥ 1 500 ms > `DEFAULT_DEGRADED_LATENCY_MS`) | `degraded` |
| After toxic removed | `healthy` | `healthy` |

**Application behaviour**  
Queries succeed but are slow. No exception is thrown by `pool.ts` unless
latency exceeds `STATEMENT_TIMEOUT_MS` (default 5 000 ms), which would then
produce a `QueryTimeoutError` (PG error 57014).

**Remove**
```bash
curl -s -X DELETE http://localhost:8474/proxies/pg_proxy/toxics/pg_latency
```

---

### 4.2 Postgres — connection timeout (unhealthy)

Simulates a complete network partition where new connections hang indefinitely.

**Inject** (timeout toxic + disable proxy)
```bash
# Option A: inject a very long latency > connectTimeout (5 000 ms)
curl -s -X POST http://localhost:8474/proxies/pg_proxy/toxics \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "pg_timeout",
    "type": "latency",
    "stream": "upstream",
    "attributes": { "latency": 8000, "jitter": 0 }
  }'

# Option B: disable the proxy entirely (all connections refused)
curl -s -X POST http://localhost:8474/proxies/pg_proxy \
  -H 'Content-Type: application/json' \
  -d '{"enabled": false}'
```

**Expected health transitions**

| Phase | `postgres` checker | Overall |
|---|---|---|
| Before | `healthy` | `healthy` |
| After inject | `unhealthy` (connect times out / ECONNREFUSED) | `unhealthy` |
| After reset | `healthy` | `healthy` |

**Application behaviour**  
`pool.query()` throws a native pg connection error (or `QueryTimeoutError` if
`STATEMENT_TIMEOUT_MS` fires first). New connection attempts from the pool
fail with `Error: connect ETIMEDOUT` or similar. The pool waiting count rises
until `POOL_QUEUE_LIMIT` is reached, at which point `query()` throws
`PoolExhaustedError`.

**Remove**
```bash
curl -s -X DELETE http://localhost:8474/proxies/pg_proxy/toxics/pg_timeout
# Or re-enable:
curl -s -X POST http://localhost:8474/proxies/pg_proxy \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true}'
```

---

### 4.3 Postgres — bandwidth throttle (degraded → unhealthy under load)

Throttles downstream bandwidth to simulate a saturated network link.

**Inject**
```bash
curl -s -X POST http://localhost:8474/proxies/pg_proxy/toxics \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "pg_bandwidth",
    "type": "bandwidth",
    "stream": "downstream",
    "attributes": { "rate": 10 }
  }'
```

`rate` is in KB/s. A 10 KB/s cap will cause large result sets to take
hundreds of milliseconds, pushing latency above `DEFAULT_DEGRADED_LATENCY_MS`.

**Expected health transitions**

| Phase | `postgres` checker | Overall |
|---|---|---|
| Before | `healthy` | `healthy` |
| After inject (SELECT 1) | `degraded` or `healthy` depending on response size | `degraded` or `healthy` |
| Under load (large queries) | `degraded` | `degraded` |
| If timeout exceeded | `unhealthy` | `unhealthy` |

**Remove**
```bash
curl -s -X DELETE http://localhost:8474/proxies/pg_proxy/toxics/pg_bandwidth
```

---

### 4.4 Postgres — connection reset (unhealthy)

Simulates TCP RST injected mid-connection, as happens during node failover or
firewall rule changes.

**Inject**
```bash
curl -s -X POST http://localhost:8474/proxies/pg_proxy/toxics \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "pg_reset",
    "type": "reset_peer",
    "stream": "upstream",
    "attributes": { "timeout": 0 }
  }'
```

`timeout: 0` means the peer is reset immediately on any new byte.

**Expected health transitions**

| Phase | `postgres` checker | Overall |
|---|---|---|
| Before | `healthy` | `healthy` |
| After inject | `unhealthy` (ECONNRESET) | `unhealthy` |
| After toxic removed | `healthy` (pool reconnects) | `healthy` |

**Application behaviour**  
`pool.query()` throws `Error: read ECONNRESET`. The pg Pool automatically
removes the broken connection from the pool and creates a new one on the next
`acquire`, so the application recovers within one connection cycle.

**Remove**
```bash
curl -s -X DELETE http://localhost:8474/proxies/pg_proxy/toxics/pg_reset
```

---

### 4.5 Redis — high latency (degraded)

**Inject**
```bash
curl -s -X POST http://localhost:8474/proxies/redis_proxy/toxics \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "redis_latency",
    "type": "latency",
    "stream": "upstream",
    "attributes": { "latency": 1500, "jitter": 100 }
  }'
```

**Expected health transitions**

| Phase | `redis` checker | Overall |
|---|---|---|
| Before | `healthy` | `healthy` |
| After inject | `degraded` (PING latency ≥ 1 500 ms) | `degraded` |
| After remove | `healthy` | `healthy` |

**Application behaviour**  
ioredis `PING` and all commands succeed but slowly. No retry storm because
ioredis `maxRetriesPerRequest: 3` only retries on connection-level failures,
not latency. Callers time out if the latency exceeds their own application-level
timeout.

**Remove**
```bash
curl -s -X DELETE http://localhost:8474/proxies/redis_proxy/toxics/redis_latency
```

---

### 4.6 Redis — connection reset (unhealthy → recovery)

**Inject**
```bash
curl -s -X POST http://localhost:8474/proxies/redis_proxy/toxics \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "redis_reset",
    "type": "reset_peer",
    "stream": "upstream",
    "attributes": { "timeout": 0 }
  }'
```

**Expected health transitions**

| Phase | `redis` checker | Overall |
|---|---|---|
| Before | `healthy` | `healthy` |
| After inject | `unhealthy` (ECONNRESET) | `unhealthy` |
| After remove | `healthy` (ioredis reconnects) | `healthy` |

**Application behaviour**  
ioredis emits `redis:reconnecting` log event (`src/redis/client.ts` listener).
After the toxic is removed, ioredis automatically reconnects and the checker
returns `healthy`.

**Remove**
```bash
curl -s -X DELETE http://localhost:8474/proxies/redis_proxy/toxics/redis_reset
```

---

### 4.7 Redis — bandwidth throttle (degraded)

```bash
curl -s -X POST http://localhost:8474/proxies/redis_proxy/toxics \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "redis_bandwidth",
    "type": "bandwidth",
    "stream": "downstream",
    "attributes": { "rate": 5 }
  }'
```

At 5 KB/s even PONG (4 bytes) is unaffected, but pipeline responses to bulk
operations are throttled. Health checker will stay `healthy` for PING but
application-level Redis operations (e.g., rate-limit sliding window) will slow.

**Remove**
```bash
curl -s -X DELETE http://localhost:8474/proxies/redis_proxy/toxics/redis_bandwidth
```

---

## 5. Automated test coverage

`tests/incidents/toxiproxy.chaos.test.ts` automates all scenarios above using
the Toxiproxy HTTP API directly (no Docker SDK required). Tests are skipped
automatically unless `CHAOS_ENABLED=true` is set, so they are safe to include
in the standard `pnpm test` suite without requiring the chaos stack.

```bash
# Run chaos tests with the chaos stack already running:
CHAOS_ENABLED=true pnpm test tests/incidents/toxiproxy.chaos.test.ts

# Or start the stack and run in one command:
docker compose --profile chaos up -d && \
  CHAOS_ENABLED=true pnpm test tests/incidents/toxiproxy.chaos.test.ts && \
  docker compose --profile chaos down -v
```

### CI integration

Add to `.github/workflows/ci.yml` as a separate job:

```yaml
  chaos:
    name: Chaos tests (Toxiproxy)
    runs-on: ubuntu-latest
    needs: [test]

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20.x'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Start chaos stack
        run: docker compose --profile chaos up -d --wait

      - name: Run chaos tests
        env:
          CHAOS_ENABLED: "true"
          TOXI_URL: "http://localhost:8474"
          CHAOS_PG_PROXY_URL: "postgresql://chaos_user:chaos_password@localhost:5433/chaos_db"
          CHAOS_REDIS_PROXY_URL: "redis://:chaos_password@localhost:6380"
        run: pnpm test tests/incidents/toxiproxy.chaos.test.ts

      - name: Tear down chaos stack
        if: always()
        run: docker compose --profile chaos down -v
```

---

## 6. Security considerations

| Concern | Mitigation |
|---|---|
| Management API exposed externally | Bound to `127.0.0.1` in compose; CI runner has no public IP for these ports |
| Test credentials in compose | Test-only values; not used in any other environment; isolated in `chaos` network |
| `sanitiseErrorMessage` in health responses | `src/health/checkers.ts` strips connection strings / credentials before returning errors in `/health` responses |
| Toxiproxy has no auth | Network isolation (Docker bridge) is the only control; do not expose 8474 in production |
| Chaos tests can destabilise shared state | Chaos tests are skipped by default (`CHAOS_ENABLED`) and run in an isolated `chaos_db` / `chaos-redis` — they never touch the main Postgres or Redis instances |

---

## 7. Resetting all toxics (emergency)

```bash
# List all active toxics on both proxies
curl -s http://localhost:8474/proxies/pg_proxy/toxics | jq .
curl -s http://localhost:8474/proxies/redis_proxy/toxics | jq .

# Re-enable disabled proxies
curl -s -X POST http://localhost:8474/proxies/pg_proxy \
  -H 'Content-Type: application/json' -d '{"enabled": true}'
curl -s -X POST http://localhost:8474/proxies/redis_proxy \
  -H 'Content-Type: application/json' -d '{"enabled": true}'

# Nuclear option: restart the toxiproxy container (clears all runtime toxics,
# proxies are re-seeded from toxiproxy.config.json)
docker compose --profile chaos restart toxiproxy
```

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ECONNREFUSED` on port 5433/6380 | Toxiproxy not started | `docker compose --profile chaos up -d` |
| `curl: (7) Failed to connect to localhost:8474` | Toxiproxy container unhealthy | Check logs: `docker compose logs toxiproxy` |
| Health checker shows `unhealthy` after removing toxic | pg Pool still has broken connections in flight | Wait for pool to cycle (< `DB_IDLE_TIMEOUT`, default 30 s) |
| Redis not reconnecting after reset toxic removed | ioredis reconnect back-off | Default ioredis back-off is exponential; allow ~5 s for reconnect |
| `CHAOS_ENABLED` not set, tests skipped | Correct — chaos tests require explicit opt-in | Set `CHAOS_ENABLED=true` |
| Toxiproxy upstream `connection refused` | `chaos-postgres` / `chaos-redis` not healthy | Check: `docker compose --profile chaos ps` |
