# Fluxora API — Reference

## Idempotency

### Overview

`POST /api/streams` supports idempotent request processing via the `Idempotency-Key` header.
Clients must supply a unique key per logical operation. If the same key is replayed, the server
returns the original response without re-executing the business logic.

### Header

| Header | Required | Format | Example |
|--------|----------|--------|---------|
| `Idempotency-Key` | Yes | 1–128 chars, `[A-Za-z0-9:_-]` | `Idempotency-Key: order-2026-05-27-001` |

### Behaviour

| Scenario | Response |
|----------|----------|
| First request (cache miss) | Normal `201 Created` with `Idempotency-Replayed: false` |
| Duplicate request, same body | `201` replay with `Idempotency-Replayed: true` |
| Same key, different body | `409 CONFLICT` — use a new key or resend the original body |
| Missing or invalid key | `400 VALIDATION_ERROR` |
| Redis unavailable | Request proceeds normally; idempotency is best-effort (pass-through) |

### Response headers

| Header | Value |
|--------|-------|
| `Idempotency-Key` | Echoed back on every `POST /api/streams` response |
| `Idempotency-Replayed` | `true` on a replay, `false` on first creation |

### TTL

Idempotency entries are stored in Redis with a configurable TTL (default **24 hours**).
After expiry the key can be reused for a new stream creation.

Configure via the `IDEMPOTENCY_TTL_SECONDS` environment variable (range: 1 – 604800 seconds).

```
IDEMPOTENCY_TTL_SECONDS=86400   # 24 hours (default)
```

### Graceful degradation

If Redis is unavailable at startup or during a request, the idempotency store degrades to a
pass-through (no-op). Requests are processed normally but duplicate protection is not enforced.
A `WARN` log is emitted for each degraded operation. Operators should alert on Redis connectivity
separately.

### Security notes

- The raw `Idempotency-Key` value is never written to logs; only its length is recorded.
- Keys are namespaced under `fluxora:idempotency:` in Redis to prevent collisions with other stores.
- The stored value is JSON-serialised; no dynamic code evaluation occurs.
- TTL is enforced by Redis `EX` so entries are automatically evicted without a background job.

### Example

```bash
# First request — creates the stream
curl -X POST http://localhost:3000/api/streams \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-unique-key-001" \
  -d '{"sender":"G...","recipient":"G...","depositAmount":"100","ratePerSecond":"0.001","startTime":1700000000}'

# Idempotency-Replayed: false  →  stream created

# Duplicate request — same key, same body
curl -X POST http://localhost:3000/api/streams \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-unique-key-001" \
  -d '{"sender":"G...","recipient":"G...","depositAmount":"100","ratePerSecond":"0.001","startTime":1700000000}'

# Idempotency-Replayed: true  →  original response returned, no duplicate stream
```

## Caching — GET /api/streams

`Cache-Control` headers are set on all `GET /api/streams` and `GET /api/streams/:id` responses based on the mutability of the returned data.

| Condition | Cache-Control |
|-----------|---------------|
| Any stream on the page is `active`, `paused`, or `scheduled` | `private, no-store` |
| All streams on the page are `completed` or `cancelled` | `public, max-age=300, stale-while-revalidate=60` |
| Empty page (list endpoint) | `public, max-age=300, stale-while-revalidate=60` |

Terminal statuses (`completed`, `cancelled`) are immutable — the stream data will never change — so responses containing only terminal streams are safe to cache at the edge for up to 5 minutes, with a 60-second stale-while-revalidate window.

Non-terminal streams (`active`, `paused`, `scheduled`) carry live financial state (streamed amounts, remaining balances) that changes continuously. These responses must not be stored by shared caches.
