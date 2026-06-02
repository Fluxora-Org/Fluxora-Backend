# Rate-Limit Response Headers

Fluxora emits four standard rate-limit headers on **every** response — not only on HTTP 429 — so that clients can implement intelligent back-off without waiting for a rejection.

---

## Header fields

| Header | Type | Description |
|---|---|---|
| `X-RateLimit-Limit` | integer string | Maximum number of requests allowed in the current window |
| `X-RateLimit-Remaining` | integer string | Requests remaining before the client is rejected |
| `X-RateLimit-Reset` | integer string | Unix epoch timestamp **in seconds** when the window resets |
| `Retry-After` | integer string | Seconds until the client may retry — **present only on HTTP 429** |

All four values are sourced directly from the Redis counter TTL, not estimated. `X-RateLimit-Reset` is derived from the `resetAt` value returned by `SlidingWindowStore.increment`, which sets the Redis key's expiry via `PEXPIRE`. When Redis is unavailable and the `InMemoryStore` fallback is active, values come from the in-memory window's expiry timestamp.

---

## Compliance

The header set follows [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585) (HTTP 429 Too Many Requests) and the [IETF rate-limit headers draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/). The `Retry-After` header uses the `delay-seconds` format (an integer, not an HTTP date).

---

## Example: allowed request

```
HTTP/1.1 200 OK
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 59
X-RateLimit-Reset: 1717200060
```

## Example: rejected request

```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1717200060
Retry-After: 42
Content-Type: application/json

{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Retry after 42 seconds.",
    "retryAfter": 42,
    "limit": 60,
    "window": "minute",
    "identifier": "1.2.3.4"
  }
}
```

---

## Client back-off guidance

```
if response.status == 429:
    retry_after = int(response.headers["Retry-After"])
    sleep(retry_after + jitter())
else:
    remaining = int(response.headers["X-RateLimit-Remaining"])
    reset      = int(response.headers["X-RateLimit-Reset"])
    if remaining < 5:
        # Throttle proactively before the window resets
        sleep(max(0, reset - time.time()))
```

---

## Exempt paths

The following paths are exempt from rate-limiting and do not receive quota headers:

| Path | Reason |
|---|---|
| `/` | Root discovery endpoint |
| `/health` | Liveness / readiness probe |
| `/api/rate-limits` | Quota introspection endpoint |

---

## Header source: Redis vs. in-memory

The `X-RateLimit-Store` response header (non-standard, for observability) indicates which backend served the request:

| Value | Meaning |
|---|---|
| `redis` | Cluster-wide counter from Redis sliding-window store |
| `memory` | Per-process fallback counter (Redis unavailable) |

When the store is `memory`, quota values are local to the process. Distributed deployments may see inconsistent remaining counts across replicas until Redis recovers.

---

## Zod validation schema

Header values can be validated programmatically using the exported schema:

```typescript
import { RateLimitHeadersSchema } from '../src/validation/rateLimitHeaders.js';

const result = RateLimitHeadersSchema.safeParse(response.headers);
if (!result.success) {
  // handle malformed headers
}
```

See [src/validation/rateLimitHeaders.ts](../../src/validation/rateLimitHeaders.ts) for the full schema definition.
