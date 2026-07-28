# Rate Limiting

Fluxora enforces cluster-wide rate limits using a Redis sliding-window algorithm. Every replica shares the same counters, so a client cannot exceed the configured limit by distributing requests across instances.

---

## How it works

Each incoming request is identified by either its API key (`x-api-key` header) or its IP address. The identifier is mapped to a Redis sorted set. On every request the middleware executes a four-command pipeline in a single round-trip:

1. **ZADD NX** — add the current timestamp as a new member (NX prevents overwriting existing members)
2. **ZREMRANGEBYSCORE** — prune members older than `now - windowMs` (the sliding window)
3. **ZCARD** — count the remaining members (= requests in the current window)
4. **PEXPIRE** — reset the TTL so the key expires automatically after the window

If the resulting count exceeds the configured limit the request is rejected with HTTP 429.

---

## Store implementations

| Class | File | Description |
|---|---|---|
| `SlidingWindowStore` | `src/redis/rateLimitStore.ts` | Redis sorted-set pipeline. Primary backend. |
| `InMemoryStore` | `src/redis/rateLimitStore.ts` | Per-process counter map. Used as fallback. |
| `HybridStore` | `src/redis/rateLimitStore.ts` | Wraps primary + fallback; delegates to fallback on Redis errors. |

All three implement the `RateLimitStore` interface (`src/types/rateLimit.ts`):

```typescript
interface RateLimitStore {
  increment(key: string, windowMs: number, limit: number): Promise<{ count: number; resetAt: number }>;
  getCount(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
  close(): Promise<void>;
}
```

---

## Redis key format

```
fluxora:rl:{sanitisedKey}
```

Where `sanitisedKey` is built by the middleware as:

```
{identifierType}:{hashedOrSanitisedIdentifier}:{routeKey}
```

- `identifierType` — `ip` or `apiKey`
- `hashedOrSanitisedIdentifier` — SHA-256 hex digest for API keys; sanitised IP string for IP-based clients. Sanitisation replaces characters outside `[A-Za-z0-9._-]` with `_` and truncates to 256 characters.
- `routeKey` — URL path with `/` replaced by `_` and leading `_` stripped (e.g. `api_streams` for `/api/streams`); `global` when no route-specific budget applies.

**Example:** `fluxora:rl:apikey:a3f2c9d1...:api_streams`

### Sorted-set member format

```
{timestampMs}-{6-char random hex}
```

e.g. `1718000000123-a4f9c2`

The random suffix prevents member collisions when two requests arrive within the same millisecond.

---

## Response headers

Every non-exempt response includes:

| Header | Value |
|---|---|
| `X-RateLimit-Limit` | Effective limit for this request |
| `X-RateLimit-Remaining` | `max(0, limit - count)` |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the window resets |
| `X-RateLimit-Store` | `redis` or `memory` — indicates which backend is active |

On HTTP 429 responses, an additional header is set:

| Header | Value |
|---|---|
| `Retry-After` | Seconds until the window resets |

---

## Fallback behaviour

When Redis is unavailable (connection error, timeout, etc.) the `HybridStore` catches the error, logs a `warn`-level message, increments the `rate_limit_redis_errors_total` Prometheus counter, and delegates to the `InMemoryStore` for that request.

While operating in fallback mode:
- `X-RateLimit-Store: memory` is set on every response
- `GET /api/rate-limits` returns `"degraded": true` in the response body
- Limits are enforced per-process (not cluster-wide) until Redis recovers

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_ENABLED` | `true` | Set to `false` to skip Redis entirely and use in-memory only |
| `REDIS_URL` | `redis://localhost:6379` | IORedis connection URL |
| `RATE_LIMIT_ENABLED` | `true` | Master on/off switch for all rate limiting |
| `RATE_LIMIT_IP_WINDOW_MS` | `60000` | Window duration (ms) for IP-based limits |
| `RATE_LIMIT_IP_MAX` | `100` | Max requests per IP per window |
| `RATE_LIMIT_APIKEY_WINDOW_MS` | `60000` | Window duration (ms) for API-key limits |
| `RATE_LIMIT_APIKEY_MAX` | `500` | Max requests per API key per window |
| `RATE_LIMIT_ADMIN_MAX` | `2000` | Max requests for admin keys per window |
| `RATE_LIMIT_ALLOWLIST_IPS` | — | Comma-separated IPs exempt from rate limiting (e.g. health probes) |

---

## Per-route budgets

Route-specific limits are configured in `src/config/rateLimits.ts` via the `ROUTE_BUDGETS` array. Each entry specifies:

- `baseLimit` — limit for read methods (GET, HEAD, OPTIONS); `0` means use the global limit
- `writeLimit` — stricter limit for write methods (POST, PUT, PATCH, DELETE); `0` means use `baseLimit`
- `exempt` — if `true`, the route is not rate-limited at all

Exhausting the limit for one route does not affect other routes for the same client.

---

## GET /api/rate-limits

Returns the caller's current rate-limit status, queried live from the store:

```json
{
  "identifier": "1.2.3.4",
  "identifierType": "ip",
  "limit": 100,
  "remaining": 87,
  "resetsAt": "2026-05-26T12:01:00.000Z",
  "window": "minute",
  "store": "redis",
  "degraded": false
}
```

When Redis is unavailable, `store` is `"memory"` and `degraded` is `true`.

---

## Security

- **API key hashing** — raw API key material is never written to Redis. The middleware hashes the key with SHA-256 before constructing the store key.
- **Identifier sanitisation** — the `SlidingWindowStore` sanitises all identifiers before use as Redis key segments, replacing characters outside `[A-Za-z0-9._-]` with `_` and truncating to 256 characters.
- **Key namespacing** — all keys are prefixed with `fluxora:rl:` to avoid collisions with other Redis data.

---

## Observability

| Metric | Labels | Description |
|---|---|---|
| `rate_limit_rejected_total` | `identifier_type`, `route` | Incremented on every HTTP 429 response |
| `rate_limit_redis_errors_total` | `operation` | Incremented on every Redis error that triggers fallback |

Structured log entries are emitted at `warn` level for:
- Every 429 response (includes masked identifier, route, method, limit, window)
- Every Redis error that triggers fallback (includes error message and operation)

---

## Graceful shutdown

`SlidingWindowStore.close()` calls `RedisClient.close()` (which calls `ioredis.quit()`), allowing in-flight pipelines to complete before the connection is torn down. The shutdown hook is registered in `src/index.ts` via `addShutdownHook(() => limiter.close())`.
