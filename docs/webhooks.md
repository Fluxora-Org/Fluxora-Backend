# Webhooks

## Outbox dispatcher

Stream writes enqueue rows in `webhook_outbox` inside the same database transaction as the stream update. The live dispatcher in `src/webhooks/service.ts` polls that table and sends each event to the configured consumer endpoint.

Required configuration:

- `WEBHOOK_URL`: HTTPS endpoint that receives webhook `POST` requests.
- `WEBHOOK_SECRET`: HMAC signing secret used for `x-fluxora-signature`.
- `WEBHOOK_POLL_INTERVAL_MS`: polling interval in milliseconds. Defaults to `10000`.
- `WEBHOOK_BATCH_SIZE`: rows claimed per poll. Defaults to `10`.
- `WEBHOOK_RETRY_RPS`: maximum outbound retry attempts per second per consumer URL. Defaults to `10`. Set lower (e.g. `2`) for consumers known to be slow or fragile.
- `WEBHOOK_RETRY_JITTER_ALGORITHM`: retry backoff jitter algorithm. Supports `full`, `equal`, and `decorrelated`. Defaults to `full`.
- `WEBHOOK_RETRY_JITTER_PERCENT`: non-negative jitter percentage toggle. Defaults to `10`; set to `0` for deterministic no-jitter backoff.
- `WEBHOOK_CIRCUIT_BREAKER_THRESHOLD`: consecutive retryable failures before the circuit opens. Defaults to `0` (disabled). Set e.g. `10` to enable cross-instance protection.
- `WEBHOOK_CIRCUIT_BREAKER_RESET_MS`: how long the circuit stays open before a single half-open probe. Defaults to `300000` (5 minutes).

The service startup path starts the dispatcher after migrations are checked. Shutdown registers the dispatcher as a drainable service, so SIGTERM/SIGINT stops future polls and waits for the in-flight batch before closing database connections.

## Delivery guarantees

The dispatcher claims rows with:

```sql
SELECT ...
FROM webhook_outbox
WHERE processed = false
  AND created_at <= NOW()
ORDER BY created_at ASC, id ASC
LIMIT $1
FOR UPDATE SKIP LOCKED
```

`FOR UPDATE SKIP LOCKED` lets multiple API instances run dispatchers concurrently without claiming the same row at the same time. A row is marked `processed = true` only after the HTTP attempt is complete. If the process exits before commit, PostgreSQL releases the lock and the row remains unprocessed for another worker to deliver, which provides at-least-once delivery.

Failed retryable deliveries are delegated to `src/webhooks/retry.ts`. The original row is marked processed and a new unprocessed row is inserted with `created_at` set to the next retry time. The dispatcher only claims rows whose `created_at` is due, so retries remain durable in PostgreSQL without holding process memory.

## Retry jitter

Webhook retry delays use capped exponential backoff plus configurable jitter so a burst of failing deliveries does not retry in lockstep. `full` jitter selects a delay between `0` and the capped raw backoff delay; `equal` jitter keeps retries in the upper half of that range; `decorrelated` jitter uses the previous retry delay to spread later retries more aggressively while still capping at `maxBackoffMs`.

Durable outbox retries store the previous delay in `_webhookRetry.previousDelayMs`, so decorrelated jitter keeps its state across process restarts. All algorithms clamp delays to non-negative values and never exceed the configured maximum backoff.

## Retry rate limiting

To prevent a slow or error-prone consumer from being bombarded with retries, `attemptWebhookDeliveryWithRateLimit` in `src/webhooks/retry.ts` enforces a per-consumer-URL sliding-window rate limit before each outbound attempt.

## Circuit breaker resilience

Per-consumer circuit breaker state is persisted in Redis (`src/redis/webhookCircuitBreakerStore.ts`) so multiple dispatcher instances and process restarts share the same open / half-open / closed view of a struggling consumer.

### State machine

| State | Behaviour |
|-------|-----------|
| `closed` | Deliveries allowed; consecutive failures increment toward the threshold. |
| `open` | Deliveries blocked until `circuitBreakerResetMs` elapses. |
| `half-open` | After reset expiry, **one** probe delivery is allowed across all instances. Success closes the circuit; failure re-opens it. |

### How it works

1. Before firing a retry, the dispatcher calls `checkWebhookDeliveryGate` / `attemptWebhookDeliveryWithRateLimit` with the consumer endpoint URL.
2. The circuit breaker store reads/writes JSON state at `webhook_cb:{sha256(url)}`. Half-open probe ownership is tracked with `webhook_cb_probe:{sha256(url)}` via Redis `SET NX`.
3. When the circuit is open, the outbox row is re-enqueued with `created_at = resetAt` — no HTTP call is made.
4. Successful deliveries reset the breaker; retryable failures increment the shared failure counter.
5. State transitions increment `fluxora_webhook_circuit_breaker_transitions_total{from_state,to_state}`.

### Security notes

- Consumer URLs are SHA-256-hashed before use as Redis key segments (same approach as the rate limiter) to prevent key injection and to avoid storing raw URLs in Redis keys.
- A crafted URL cannot trip a breaker for a different consumer because keys are derived from the full URL digest.

### Failure modes

| Condition | Behaviour |
|-----------|-----------|
| Circuit closed | Delivery proceeds (subject to rate limit). |
| Circuit open | Delivery deferred to `resetAt`; no consumer traffic. |
| Half-open probe succeeds | Circuit resets to closed. |
| Half-open probe fails | Circuit re-opens for another `circuitBreakerResetMs`. |
| Redis unavailable | **Fail-open** for gate checks; deliveries proceed. Failure recording is best-effort. |

### How rate limiting works

1. Before firing a retry, the dispatcher calls `attemptWebhookDeliveryWithRateLimit` with the consumer's endpoint URL and the configured `RateLimitConfig` (`{ limit, windowMs }`).
2. The rate limiter (`src/redis/webhookRateLimit.ts`) maintains a Redis sorted set keyed by a SHA-256 hash of the consumer URL. Each recorded attempt is a member with score = timestamp (ms).
3. Entries older than `windowMs` are pruned on every check. If the remaining count is at or above `limit`, the attempt is **deferred** rather than dropped.
4. A deferred attempt returns `{ shouldRetry: true, rateLimited: true, retryAt: now + windowMs }`. The dispatcher re-inserts the outbox row with `created_at = retryAt`, so the deferral is durable in PostgreSQL.
5. `WEBHOOK_RETRY_RPS` (default `10`) controls `limit`; `windowMs` is `1000 ms` (one second).

### Failure modes

| Condition | Behaviour |
|-----------|-----------|
| Within rate limit | Attempt proceeds; attempt recorded in Redis. |
| Limit exceeded | Attempt deferred; outbox row re-enqueued with `retryAt = now + windowMs`. No delivery is dropped. |
| Redis unavailable | **Fail-open**: attempt proceeds normally. A Redis outage does not halt deliveries. |
| `maxAttempts` reached | `shouldRetry = false`; row moves to dead-letter queue regardless of rate limit. |

### Security notes

- Consumer URLs are SHA-256-hashed before use as Redis key segments to prevent key-injection via crafted URLs and to bound key length.
- The rate limiter counts all outbound attempts (not just failures) to protect consumers from burst traffic regardless of outcome.
- Redis credentials are consumed from environment variables only and are never logged.

## Security notes

Webhook requests are signed with the configured secret and include delivery metadata headers. Production endpoints must use HTTPS unless they target loopback for local deployments. URLs with embedded credentials are rejected.

Consumers must treat webhook delivery as at-least-once: verify the signature, deduplicate by `x-fluxora-delivery-id`, and make handlers idempotent.
