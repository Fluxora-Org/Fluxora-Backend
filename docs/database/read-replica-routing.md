# Read-Replica Routing & Read-Your-Writes Consistency

## Overview

Fluxora Backend supports routing **read-only SQL queries** to a dedicated
PostgreSQL read-replica. This offloads the primary node from high-volume
`SELECT` traffic (e.g. `GET /api/streams` list requests) and improves both
read and write throughput at scale.

The implementation lives in two modules:

| Module | Responsibility |
|---|---|
| [`src/db/replicaPool.ts`](../../src/db/replicaPool.ts) | Lazily initialises the replica pool, health-check, fallback, `forcePrimary` option |
| [`src/db/writeFencePin.ts`](../../src/db/writeFencePin.ts) | Stateless HMAC-SHA256 signed write-fence pin for read-your-writes consistency |

---

## Architecture

```
  POST /api/streams
  ─────────────────────────────────────────────────────────────────────────
  │  1. Validate & create stream (always via primary pool)
  │  2. Issue write-fence pin → respond with X-Fluxora-Write-Fence: <pin>
  └──────────────────────────────────────────────────────────────────────►

  GET /api/streams?cursor=…   (without pin)
  ─────────────────────────────────────────────────────────────────────────
  │  Check header → absent/invalid → route to replica (normal path)
  └──────────────────────────────────────────────────────────────────────► Read Replica

  GET /api/streams?cursor=…   (with valid, unexpired pin)
  ─────────────────────────────────────────────────────────────────────────
  │  Check header → valid pin within TTL → route to primary
  └──────────────────────────────────────────────────────────────────────► Primary

                         ┌────────────────────────────────────────────────────┐
                         │               replicaPool.ts                       │
  GET (no pin) ─────────►│  getReadPool({ forcePrimary: false })              │──► Replica
  GET (valid pin) ──────►│  getReadPool({ forcePrimary: true  })              │──► Primary
  POST / DELETE ─────────►│  getPool() [always primary]                       │──► Primary
                         └────────────────────────────────────────────────────┘
```

### Query routing table

| Operation | Pool | Notes |
|---|---|---|
| `getById()` | Read replica | Falls back to primary |
| `getByEvent()` | Read replica | Falls back to primary |
| `existsById()` | Read replica | Falls back to primary |
| `find()` | Read replica | Offset-paginated list |
| `findWithCursor()` | **Read replica** *(default)* or **Primary** *(with valid pin)* | Pin activates `forcePrimary` |
| `upsertStream()` | **Primary** | INSERT … ON CONFLICT |
| `updateStream()` | **Primary** | UPDATE … RETURNING |

---

## The Write-Fence Pin

### Problem

PostgreSQL streaming replication is asynchronous by default. When a client
issues `POST /api/streams` and immediately follows with
`GET /api/streams?cursor=…`, the `GET` may be served by a replica that has not
yet applied the new row. The client will observe their own write as "missing".

### Solution

After a successful stream creation the server issues a **write-fence pin** — a
short-lived, cryptographically-signed HTTP response header. The client echoes
this pin on its next `GET` request. The server verifies the pin and, if valid,
routes that single read to the **primary** pool, bypassing replica lag entirely.

Once the pin expires (default 30 seconds), subsequent reads revert to the
normal replica routing path.

### Pin format

```
X-Fluxora-Write-Fence: <base64url( "v1" "." <ts_ms> "." <hex-hmac-sha256> )>
```

| Field | Description |
|---|---|
| `v1` | Protocol version — enables future algorithm migrations |
| `ts_ms` | Unix epoch in **milliseconds** when the pin was issued |
| `hex-hmac-sha256` | `HMAC-SHA256(key, "v1:" + ts_ms)` as lowercase hex |

The entire `v1.<ts_ms>.<sig>` string is then base64url-encoded so the header
value is safe for HTTP transmission and contains only `[A-Za-z0-9_-]`
characters.

### Key material

The HMAC key is the **first 32 bytes** of `JWT_SECRET` (already required to be
≥ 32 characters by the env schema). No additional secret configuration is
needed.

### TTL

The lifetime is controlled by `RYW_PIN_TTL_SECONDS` (default **30 s**).
Setting it to `0` disables pin enforcement entirely — all reads follow normal
replica routing regardless of the header.

---

## Client Integration

### Step 1 — Capture the pin from the POST response

```http
POST /api/streams HTTP/1.1
Content-Type: application/json
Authorization: Bearer <jwt>
Idempotency-Key: client-uuid-abc

{ … }

HTTP/1.1 201 Created
X-Fluxora-Write-Fence: dj...  ← capture this
```

### Step 2 — Echo the pin on the next GET

```http
GET /api/streams HTTP/1.1
Authorization: Bearer <jwt>
X-Fluxora-Write-Fence: dj...  ← echo the captured pin
```

The server will route this read to the **primary** pool and the newly-created
stream will be visible.

### Step 3 — Stop sending the pin after TTL

Clients should discard the pin after `RYW_PIN_TTL_SECONDS` seconds or after
receiving the first `GET` response that includes the new stream (whichever is
earlier). Subsequent reads can omit the header and will be served by the
replica as usual.

> **Note:** The server never rejects a request because of a missing or expired
> pin — it simply routes to the replica instead. There is no error response
> related to pin state.

---

## Configuration

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_REPLICA_URL` | No | *(falls back to primary)* | PostgreSQL connection string for the read-replica |
| `JWT_SECRET` | **Yes** | — | ≥ 32-character secret; first 32 bytes used as HMAC key |
| `RYW_PIN_TTL_SECONDS` | No | `30` | Pin lifetime in seconds. Set to `0` to disable. |
| `REPLICA_STATEMENT_TIMEOUT_MS` | No | inherits `STATEMENT_TIMEOUT_MS` | Per-query timeout on the replica |
| `REPLICA_QUEUE_LIMIT` | No | `25` | Max queued connection requests on the replica pool |

---

## Security Analysis

### Integrity

The pin is signed with HMAC-SHA256. An attacker who does not know `JWT_SECRET`
cannot forge a valid pin. The probability of a random 256-bit string passing
verification is 2⁻²⁵⁶ ≈ 0.

### Replay resistance

The timestamp embedded in the pin is verified at receipt time against
`RYW_PIN_TTL_SECONDS`. A stolen pin can only be replayed within the TTL window
(default 30 s), after which it is silently discarded.

Additionally, future timestamps (clock skew > 0) are rejected — a pin
issued by a misconfigured future clock cannot be used to permanently force
primary routing.

### Timing safety

Signature comparison uses `crypto.timingSafeEqual`. The server's response time
does not leak whether the received signature was "close" to the expected one,
preventing timing-oracle attacks.

### Header injection

The pin value is base64url-encoded (`[A-Za-z0-9_-]` only), making it safe for
HTTP headers. The `verifyWriteFencePin` function validates the charset before
proceeding.

### Fail-open on issuance errors

If pin issuance fails (e.g. `JWT_SECRET` is temporarily unavailable), the `POST`
still returns 201 — just without the `X-Fluxora-Write-Fence` header. The
missing pin causes the subsequent `GET` to fall back to replica routing
(slightly elevated risk of stale reads), but the write itself is not affected.

### No server-side state

The pin requires no Redis, no database row, and no in-memory table. Horizontal
scaling and rolling restarts are transparent.

### Credential isolation

The HMAC key is derived from `JWT_SECRET`, not from `API_KEY_PEPPER` or
`DATABASE_URL`. Rotating `JWT_SECRET` immediately invalidates all in-flight
pins, which is the correct behaviour (old pins expire within TTL anyway).

---

## Replica Pool Initialisation

`getReadPool()` is **lazy** — the replica pool is not created until the first
read query executes. On the first call:

1. If `DATABASE_REPLICA_URL` is **not set**, the primary pool is returned
   immediately and cached.
2. If the variable is set, a new `pg.Pool` is created and a health-check
   (`SELECT 1`) is executed.
3. If the health-check **succeeds**, the replica pool is cached and returned
   for all subsequent calls.
4. If the health-check **fails**, the replica pool is closed, a warning is
   logged, and the primary pool is returned instead.

The decision is cached after the first call — there is no per-query overhead.

### Read-only enforcement

Every physical connection to the replica pool sets:

```sql
SET default_transaction_read_only = on;
SET statement_timeout = <REPLICA_STATEMENT_TIMEOUT_MS>;
```

Both are applied in a single round-trip so the connection is either fully
configured or destroyed — no half-configured client can enter the pool.
Even if a write query were accidentally routed to the replica, PostgreSQL
would reject it with:

```
ERROR: cannot execute INSERT in a read-only transaction
```

### Credential isolation (connection strings)

Connection strings are **never** logged. Only the hostname is extracted
(via `URL` parsing) and included in diagnostic log messages.

---

## Replication Lag Monitoring

Replication lag is monitored via `checkReplicationLag()` and exposed as a
Prometheus metric:

```
fluxora_db_replication_lag_seconds  (gauge)
```

The lag check runs at most every 30 seconds (configurable via
`LAG_CHECK_INTERVAL_MS`) to avoid excessive database load.

---

## Replica Pool Sizing

The replica pool inherits all sizing parameters from the primary pool:

- `DB_POOL_MIN` / `DB_POOL_MAX`
- `DB_CONNECTION_TIMEOUT`
- `DB_IDLE_TIMEOUT`
- `POOL_QUEUE_LIMIT`
- `STATEMENT_TIMEOUT_MS` (overridden by `REPLICA_STATEMENT_TIMEOUT_MS`)

---

## Monitoring

### Logs to watch

| Message | Level | Meaning |
|---|---|---|
| `DATABASE_REPLICA_URL not set — reads will use the primary pool` | info | No replica configured |
| `Read-replica pool initialised` | info | Replica connected and healthy |
| `Replica health-check failed — falling back to primary` | warn | Replica unreachable |
| `Replica pool error` | error | Runtime error on existing replica conn |
| `Failed to check replication lag` | warn | Lag check failed |
| `Failed to issue write-fence pin` | warn | Pin issuance skipped (write still succeeds) |

### Prometheus metrics

| Metric | Type | Description |
|---|---|---|
| `fluxora_db_replication_lag_seconds` | Gauge | Current replica lag in seconds |

---

## Testing

### Unit tests

```bash
# Write-fence pin tests (issueWriteFencePin, verifyWriteFencePin, round-trips)
pnpm test -- tests/db/replicaPool.readYourWrites.test.ts

# Replica pool core tests (health-check, fallback, singleton, forcePrimary)
pnpm test -- tests/db/replicaPool.test.ts
```

The write-fence test suite (`readYourWrites.test.ts`) covers:

- Pin issuance (happy path, key errors, JWT_SECRET validation)
- Verification (valid, expired, tampered sig, version mismatch, malformed)
- TTL boundary conditions (exactly at boundary, 1 ms inside/outside)
- `shouldForcePrimaryFromHeaders` header extraction
- Security: timing-safe comparison, brute-force resistance
- Full round-trip: issue → echo → force primary
- `streamRepository.findWithCursor` options forwarding

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Client still sees stale reads after POST | Pin not echoed in GET request | Add `X-Fluxora-Write-Fence` header to the GET using the value from POST response |
| `X-Fluxora-Write-Fence` absent from POST response | `JWT_SECRET` missing or too short | Ensure `JWT_SECRET` is ≥ 32 characters in the environment |
| Pin valid but GET still uses replica | `RYW_PIN_TTL_SECONDS=0` | Set to a non-zero value (e.g. `30`) to enable pinning |
| Reads still hitting primary after 30+ s | Client sending stale pin | Client should discard pin after TTL |
| `cannot execute INSERT in a read-only transaction` | Write query accidentally routed to replica | Ensure write operations use `getPool()`, not `getReadPool()` |
| High primary load after many writes | Clients not discarding expired pins | Lower `RYW_PIN_TTL_SECONDS` or fix client to discard after first successful read |
