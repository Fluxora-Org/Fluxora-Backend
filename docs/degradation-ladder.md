# Degradation Ladder

This document describes the service's availability expectations and the order in which capabilities are shed when dependencies become unavailable. The ladder matches the implemented behaviour in `src/middleware/rpcDegradation.ts`, `src/services/stellar-rpc.ts`, `src/redis/rpcFallbackCache.ts`, and `src/middleware/rateLimiter.ts`.

## Overview

The service degrades through a series of levels as the Stellar RPC circuit breaker transitions through its states and supporting infrastructure becomes unavailable. Each level defines what remains available, what is shed, and the entry/exit criteria.

```
Level 0: NORMAL (CLOSED)
    │
    ▼ Circuit breaker trips
Level 1: DEGRADED (OPEN)
    │
    ▼ Reset timeout elapsed
Level 2: PROBE (HALF_OPEN)
    │
    ▼ Probe succeeds
Level 0: NORMAL (CLOSED)  [recovery]
    │
    ▼ Probe fails
Level 1: DEGRADED (OPEN)  [re-trip]
```

---

## Level 0 — NORMAL (CLOSED)

**Description:** All capabilities are fully available. The Stellar RPC circuit breaker is closed and all requests pass through normally.

### Capabilities Available

| Capability | Status |
|------------|--------|
| Read requests (GET, HEAD, OPTIONS) | Full access — served from live RPC or database |
| Mutating requests (POST, PUT, PATCH, DELETE) | Full access — chain-consistency guaranteed |
| Fallback cache | Active — writes refreshed on every successful RPC call |
| Rate limiting | Enforced via Redis sliding window |
| Health checks | All dependencies reported as `healthy` |
| Cache early refresh | Enabled when `RPC_FALLBACK_CACHE_EARLY_EXPIRY_BETA > 0` |

### Entry Criteria

- Circuit breaker state is `CLOSED`
- All soft dependencies (Redis, Stellar RPC) are reachable
- No health check failures

### Exit Criteria

- `failureCount >= failureThreshold` (default 5) within `windowMs` (default 30,000 ms)
- Circuit breaker transitions to `OPEN`

### Observable Behavior

- `X-Degradation-State: CLOSED` on every response
- No `Warning` header on read responses
- `X-RPC-Cache` header absent (no stale data)
- Rate limit headers reflect live Redis counters
- `GET /health` returns `status: "ok"`

---

## Level 1 — DEGRADED (OPEN)

**Description:** The Stellar RPC circuit breaker has tripped. The service enters a reduced-capability mode where read requests are served from the fallback cache or database, but mutating requests are rejected because chain-consistency cannot be guaranteed.

### Capabilities Available

| Capability | Status |
|------------|--------|
| Read requests (GET, HEAD, OPTIONS) | **Available** — served from fallback cache or database with staleness warning |
| Mutating requests (POST, PUT, PATCH, DELETE) | **Rejected** — returns `503 Service Unavailable` |
| Fallback cache | **Active read-only** — serves last-known-good responses; no new writes |
| Rate limiting | **Available** — Redis primary, in-memory fallback if Redis is unreachable |
| Health checks | `GET /health` returns `status: "degraded"` |
| Cache early refresh | **Disabled** — no live RPC calls to refresh cache |

### Entry Criteria

- Circuit breaker state transitions from `CLOSED` to `OPEN`
- `failureCount >= failureThreshold` within the rolling `windowMs` window
- Triggered by: `TIMEOUT`, `NETWORK`, or `PROVIDER` failures

### Exit Criteria

- `resetTimeoutMs` (default 60,000 ms) elapsed since circuit opened
- Circuit transitions to `HALF_OPEN` for probe

### Observable Behavior

- **All responses** carry `X-Degradation-State: OPEN`
- **Read responses** (GET/HEAD/OPTIONS):
  - HTTP `200` with cached/database data
  - `Warning: 199 fluxora-backend "Stellar RPC unavailable - data may be stale"` header
  - `X-RPC-Cache: stale` header when serving from fallback cache
- **Write responses** (POST/PUT/PATCH/DELETE):
  - HTTP `503 Service Unavailable`
  - Body: `{"error":{"code":"SERVICE_UNAVAILABLE","message":"...","degradation":{...}}}`
  - Degradation metadata includes `circuitState`, `failureCount`, `openedAt`
- Structured logs: `rpc_degradation_transition` event on state entry; `rpc_degradation_write_blocked` on each rejected write
- Rate limiting continues to enforce limits; `X-RateLimit-Store` header indicates `redis` or `memory`

### Fallback Cache Behavior in OPEN State

1. **Cache hit**: Returns the last-known-good response, increments `rpc_circuit_open_fallback_hits_total`, marks response as stale via `markStaleRpcCacheResponse()`
2. **Cache miss**: Increments `rpc_circuit_open_fallback_misses_total` and propagates `CircuitOpenError`
3. **Redis failures**: Degrade to cache misses/no-op writes; the cache cannot become a hard dependency

---

## Level 2 — PROBE (HALF_OPEN)

**Description:** The reset timeout has elapsed. The circuit breaker allows one probe call to test whether the Stellar RPC provider has recovered. This is a transitional state — the service is still degraded until the probe outcome is known.

### Capabilities Available

| Capability | Status |
|------------|--------|
| Read requests | **Available** — treated as degraded (same as OPEN: staleness warning) |
| Mutating requests | **Rejected** — same 503 behavior as OPEN |
| Fallback cache | **Read-only** — same as OPEN |
| Rate limiting | **Available** — same as OPEN |
| Probe call | **One allowed** — tests RPC provider recovery |

### Entry Criteria

- Circuit has been `OPEN` for at least `resetTimeoutMs` (default 60,000 ms)
- Circuit breaker automatically transitions from `OPEN` to `HALF_OPEN`

### Exit Criteria

- **Probe succeeds** → Circuit transitions to `CLOSED`; all capabilities restored (recovery to Level 0)
- **Probe fails** → Circuit transitions back to `OPEN`; degradation continues (re-trip to Level 1)

### Observable Behavior

- `X-Degradation-State: HALF_OPEN` on every response
- Same read/write behavior as Level 1 (OPEN)
- The single probe call is made via `breaker.call()` — if it succeeds, `onSuccess()` fires, resetting failures and closing the circuit
- If the probe call throws, `onFailure()` fires, reopening the circuit
- Structured log: `rpc_degradation_transition` event with `previousState: OPEN`, `currentState: HALF_OPEN`

### Important Notes

- `HALF_OPEN` is treated identically to `OPEN` from the client's perspective — reads carry the staleness warning, writes return 503
- The probe call is a single attempt (no retry) — it uses `breaker.call()` which may throw `CircuitOpenError` if the probe itself fails
- Recovery requires a successful probe; a single failure reopens the circuit and the full `resetTimeoutMs` wait applies again

---

## Additional Degradation Layers

### Redis Unavailable (Rate Limiting Fallback)

When Redis is unreachable, the rate limiter falls back to an in-memory store independently of the circuit breaker state.

| Indicator | Value |
|-----------|-------|
| `X-RateLimit-Store` header | `memory` |
| `GET /api/rate-limits` response | `degraded: true` |
| Limits | Per-process only (not cluster-wide) |

This degradation is transparent to clients and does not affect the degradation ladder levels. Rate limiting continues to function, just without cluster-wide coordination.

### Startup Degradation (Soft Dependencies)

At startup, soft dependencies (Redis, Stellar RPC) are probed with retry-and-backoff within a bounded budget. If the budget is exhausted:

- The dependency is marked as **degraded** (not fatal)
- The service starts in reduced-capability mode
- `GET /health/ready` may report `status: "degraded"`
- Hard dependencies (Postgres) that fail cause immediate process exit

### Health Check Degradation States

| Endpoint | `ok` | `degraded` | `unhealthy` | `shutting_down` |
|----------|------|------------|-------------|-----------------|
| `GET /health` | All dependencies healthy | Indexer stalled/starting or RPC circuit open | Not used | Graceful shutdown |
| `GET /health/ready` | All dependencies healthy | Dependencies degraded < 30s grace period | Any dependency unhealthy | Not used |
| `GET /health/live` | Detailed healthy report | Detailed degraded report | Detailed unhealthy report | N/A |

---

## Complete Degradation Summary

| Level | State | Reads | Writes | Cache | Rate Limiting | Health |
|-------|-------|-------|--------|-------|---------------|--------|
| 0 | `CLOSED` | Live RPC | Allowed | Active write+read | Redis cluster | `ok` |
| 1 | `OPEN` | Stale cache/db | **503 Rejected** | Read-only | Redis → memory fallback | `degraded` |
| 2 | `HALF_OPEN` | Stale cache/db | **503 Rejected** | Read-only | Redis → memory fallback | `degraded` |
| — | Redis down | Unaffected | Unaffected | N/A | In-memory only | Varies |
| — | Startup soft dep down | Varies | Varies | N/A | Varies | `degraded` |

## Validation

To validate that the ladder matches implemented behavior:

1. **Level 0 → Level 1**: Induce repeated RPC failures (e.g., `RPC_CB_FAILURE_THRESHOLD` set to 1). Verify:
   - `GET` requests return 200 with `Warning` and `X-Degradation-State: OPEN`
   - `POST` requests return 503 with degradation diagnostics
   - `X-RPC-Cache: stale` header present when serving cached data

2. **Level 1 → Level 2**: Wait for `RPC_CB_RESET_TIMEOUT_MS`. Verify:
   - `X-Degradation-State: HALF_OPEN` appears
   - One probe call is attempted

3. **Level 2 → Level 0**: Probe succeeds. Verify:
   - `X-Degradation-State: CLOSED` returns
   - Writes are accepted again
   - Cache refresh resumes

4. **Level 2 → Level 1**: Probe fails. Verify:
   - `X-Degradation-State: OPEN` returns
   - Full `resetTimeoutMs` wait applies again

5. **Redis fallback**: Stop Redis. Verify:
   - `X-RateLimit-Store: memory` appears on responses
   - Rate limiting still enforced per-process
   - Service continues operating
