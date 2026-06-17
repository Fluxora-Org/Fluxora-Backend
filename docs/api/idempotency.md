# Idempotency

Fluxora Backend supports idempotency for `POST /api/streams` to ensure that replaying a request with the same `Idempotency-Key` returns the exact same response without re-executing the underlying business logic.

## How it Works

1. **First request** — the client sends `POST /api/streams` with a unique `Idempotency-Key` header.
2. **Fingerprinting** — the backend computes a SHA-256 hex digest of the canonicalized request body (keys sorted, whitespace stripped).
3. **Cache lookup** — the backend checks the Redis-backed idempotency store keyed by `Idempotency-Key`.
4. **Cache miss** — the stream is created normally. The response (status code + body + fingerprint) is stored in Redis with the configured TTL.
5. **Subsequent requests** — if a request with the same `Idempotency-Key` is received:
   - **Same body hash** → the cached response is returned immediately with `Idempotency-Replayed: true`. No DB write occurs.
   - **Different body hash** → `409 Conflict` is returned. The cached response is **not** overwritten.

## Backing Store

| `REDIS_ENABLED` | Store used | Cross-instance dedup |
| --- | --- | --- |
| `true` (default) | `RedisIdempotencyStore` | Yes |
| `false` | `NoOpIdempotencyStore` | No — every request is treated as a first request |

The Redis store is wired at startup by `wireIdempotencyStore()` in `src/app.ts`. Each key is stored under the namespace `fluxora:idempotency:<key>` with the configured TTL.

### Degraded mode (`REDIS_ENABLED=false`)

When Redis is disabled, a `NoOpIdempotencyStore` is installed and a warning is logged:

```text
Redis disabled — stream idempotency running in NoOp mode; cross-instance duplicate protection is not enforced
```

Requests are still processed; they just lack cross-instance duplicate protection. Use this mode only in local development or single-instance deployments where duplicate requests are not a concern.

### Redis outage

If the Redis connection **fails at startup**, `idempotencyDependency` is set to `unavailable` and all subsequent `POST /api/streams` requests return **503 Service Unavailable** rather than silently creating duplicate streams:

```json
{
  "success": false,
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Idempotency processing is temporarily unavailable. Retry after dependency health is restored."
  }
}
```

If Redis goes down **after** a successful startup connection, the per-request `onStateChange` callback in `RedisIdempotencyStore` flips `idempotencyDependency` to unavailable on the first failed operation, and back to healthy on the first successful one (i.e., after ioredis reconnects).

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `REDIS_ENABLED` | `true` | Enable / disable Redis backing. Set to `false` for local dev or single-node deployments. |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL. |
| `REDIS_MODE` | `standalone` | `standalone`, `sentinel`, or `cluster`. |
| `IDEMPOTENCY_TTL_SECONDS` | `86400` (24 h) | How long an idempotency entry is retained. Valid range: 1–604 800 s (7 days). |

## Conflict Detection

If an `Idempotency-Key` is reused with a **different** request body, the API returns `409 Conflict` to prevent executing a different operation under the same key:

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Idempotency-Key has already been used for a different request payload",
    "detail": { "hint": "Use a new Idempotency-Key or retry with the original request body" }
  }
}
```

## Constraints

- **Method**: Idempotency is only enforced for `POST /api/streams`.
- **Header format**: `Idempotency-Key` must be 1–128 characters, `[A-Za-z0-9:_-]` only.
- **TTL**: Entries expire after `IDEMPOTENCY_TTL_SECONDS` (default 24 h). Indefinite retention is not possible.

## Canonicalization

The request body is normalized before hashing to ensure consistent fingerprints regardless of JSON serialization order or whitespace:

- All object keys are sorted alphabetically (recursively).
- All unnecessary whitespace is removed.
- The normalized string is hashed with SHA-256.

Two bodies that differ only in key order or spacing produce the **same** fingerprint and trigger a replay rather than a conflict.

## Security Notes

- The raw `Idempotency-Key` value is **never** written to logs. Only its byte length is recorded.
- Stored fingerprints are SHA-256 digests, not the raw body, so Redis compromise does not expose request payloads.
- A different payload under the same key cannot silently overwrite a cached response — it always produces a 409.
- The Redis TTL prevents indefinite retention; there is no way to store an entry without an expiry.

## Response Headers

| Header | Value | Present on |
| --- | --- | --- |
| `Idempotency-Key` | Echo of the submitted key | All 2xx responses to `POST /api/streams` |
| `Idempotency-Replayed` | `true` | Replayed (cached) responses |
| `Idempotency-Replayed` | `false` | First-time (freshly created) responses |
