# Webhooks

## Delivery store selection (`WEBHOOK_DELIVERY_STORE`)

The operator-facing delivery / outbox / DLQ management routes
(`src/routes/webhooks.ts`) read and write through an `IWebhookDeliveryStore`.
`src/webhooks/storeFactory.ts` selects the active implementation once, at process
startup:

| `WEBHOOK_DELIVERY_STORE` value                                    | Implementation                   | Durable |
|-------------------------------------------------------------------|----------------------------------|---------|
| unset, `memory`, or any unrecognised value                        | `WebhookDeliveryStore` (in-memory) | no    |
| `postgres`                                                        | `PgWebhookDeliveryStore` (Postgres write-through) | yes |

Selection rule:

- Matching is case-insensitive and surrounding whitespace is trimmed.
- Only the exact value `postgres` selects the durable backend. Every other value
  — including typos such as `postgresql` or `pg` — falls back to the in-memory
  store, so an unrecognised value can never silently disable the durable path.
- If the Postgres backend fails to initialise (for example the shared pool cannot
  be created), the failure is logged and the factory falls back to the in-memory
  store rather than crashing the process.
- When `NODE_ENV=production` and the in-memory store is active, a startup warning
  is emitted because outbox items, DLQ entries, and delivery-status records will
  be lost on restart.
- The active backend is logged at startup (`Webhook delivery store: using …`),
  so each environment's choice is visible in the process logs.

Both implementations satisfy one shared contract test —
[`tests/webhooks/store.contract.test.ts`](../tests/webhooks/store.contract.test.ts) —
which runs the same behaviour suite against each store and asserts that a fixed
sequence of operations produces identical observable results. Switching stores
therefore does not change observable behaviour.

Set `WEBHOOK_DELIVERY_STORE=postgres` in production for a durable store shared
across replicas.

## Outbox dispatcher

Stream writes enqueue rows in `webhook_outbox` inside the same database transaction as the stream update. The live dispatcher in `src/webhooks/service.ts` polls that table and sends each event to the configured consumer endpoint.

Required configuration:

- `WEBHOOK_URL`: HTTPS endpoint that receives webhook `POST` requests.
- `WEBHOOK_SECRET`: HMAC signing secret used for `x-fluxora-signature`.
- `WEBHOOK_POLL_INTERVAL_MS`: polling interval in milliseconds. Defaults to `10000`.
- `WEBHOOK_BATCH_SIZE`: rows claimed per poll. Defaults to `10`.
- `WEBHOOK_RETRY_RPS`: maximum outbound retry attempts per second per consumer URL. Defaults to `10`. Set lower (e.g. `2`) for consumers known to be slow or fragile.
- `WEBHOOK_CIRCUIT_BREAKER_THRESHOLD`: consecutive retryable failures before the circuit opens. Defaults to `0` (disabled). Set e.g. `10` to enable cross-instance protection.
- `WEBHOOK_CIRCUIT_BREAKER_RESET_MS`: how long the circuit stays open before a single half-open probe. Defaults to `300000` (5 minutes).
- `WEBHOOK_DNS_TIMEOUT_MS`: DNS lookup resolution timeout in milliseconds (fail-closed). Defaults to `2000` (2 seconds).

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

## Retry rate limiting

To prevent a slow or error-prone consumer from being bombarded with retries, `attemptWebhookDeliveryWithRateLimit` in `src/webhooks/retry.ts` enforces a per-consumer-URL sliding-window rate limit before each outbound attempt.

## Circuit breaker resilience

Per-consumer circuit breaker state is persisted in Redis (`src/redis/webhookCircuitBreakerStore.ts`) so multiple dispatcher instances and process restarts share the same open / half-open / closed view of a struggling consumer.

State is tracked **per receiver URL**, keyed by `webhook_cb:{sha256(url)[0..16]}`. One receiver failing never pauses delivery to another.

### Thresholds

| Setting | Env var | Default | Meaning |
|---------|---------|--------:|---------|
| Failure threshold | `WEBHOOK_CIRCUIT_BREAKER_THRESHOLD` | `0` | Consecutive retryable failures that open the circuit. `0` **disables** the breaker — no circuit is ever opened and no delivery is ever paused. |
| Open window | `WEBHOOK_CIRCUIT_BREAKER_RESET_MS` | `300000` (5 min) | How long the circuit stays open before a single half-open probe is admitted. |
| Probe lock | derived | `min(resetMs, 60000)` | How long the single half-open probe stays reserved, so replicas sharing the circuit do not each fire one. |
| State TTL | derived | `max(resetMs * 2, 300000)` | How long a state record is retained. Also the hard upper bound on a half-open pause whose probe never reports: the expired record reads back as `closed`. |

Only retryable failures count toward the threshold (`countsTowardCircuitBreaker` in `src/webhooks/retry.ts`): a network error, a timeout, or a status in `retryableStatusCodes` (`408`, `425`, `429`, `500`, `502`, `503`, `504` by default). A `2xx` — or a permanent `4xx` such as `401`/`404` — never counts and never opens a circuit.

### State machine

```text
                    recordFailure() × threshold            now >= resetAt
  ┌────────┐ ────────────────────────────────────▶ ┌──────┐ ────────────────▶ ┌───────────┐
  │ closed │                                       │ open │                   │ half-open │
  └────────┘ ◀──────────────────────────────────── └──────┘ ◀────────────────── └───────────┘
     ▲     │       recordSuccess() (any state)         │ ▲    │                     │      │
     └─────┴──────────────────────────────────────────┘ └────┴─────────────────────┘      │
                                        recordFailure() (probe failed)  recordSuccess()   │
```

| From | To | Trigger | Threshold / condition |
|------|----|---------|----------------------|
| — | `closed` | First delivery, or a record older than the state TTL | `consecutiveFailures = 0` |
| `closed` | `closed` | `recordFailure()` | `consecutiveFailures < threshold`; the counter increments and deliveries keep flowing |
| `closed` | `open` | `recordFailure()` | `consecutiveFailures >= threshold`; `resetAt = now + resetMs` |
| `open` | `open` | `checkAndClaimAttempt()` before `resetAt` | every attempt is denied, no HTTP call is made; the outbox row is re-enqueued with `created_at = resetAt` |
| `open` | `open` | `recordFailure()` | the window restarts: `resetAt = now + resetMs`, the counter keeps incrementing |
| `open` | `half-open` | `checkAndClaimAttempt()` at `now >= resetAt` | exactly one caller wins `SET NX webhook_cb_probe:{sha256}`; every other caller is denied |
| `half-open` | `closed` | `recordSuccess()` | the probe returned `2xx`; `consecutiveFailures` resets to `0` and the probe lock is released |
| `half-open` | `open` | `recordFailure()` | the probe failed; re-opens for another `resetMs` and clears the probe lock |
| `half-open` | `half-open` | `checkAndClaimAttempt()` | a probe is still in flight (this replica or another); all attempts denied. If that probe never reports, the circuit stays paused until the state record expires, then reads as `closed` |

`resetAt` is **exclusive**: an attempt at `now === resetAt` is admitted as the probe, one millisecond earlier is still blocked.

Every transition increments `fluxora_webhook_circuit_breaker_transitions_total{from_state,to_state,consumer_hash}`. Re-entries that do not change state (`closed → closed`, `half-open → half-open`) are not counted; a `0` on a label pair means that edge has not been crossed since the process started. Alerting rules and PromQL for the metric are in [`docs/observability.md`](observability.md#webhook-circuit-breaker-metrics).

### How it works

1. Before firing a retry, the dispatcher calls `checkWebhookDeliveryGate` / `attemptWebhookDeliveryWithRateLimit` with the consumer endpoint URL.
2. The circuit breaker store reads/writes JSON state at `webhook_cb:{sha256(url)}`. Half-open probe ownership is tracked with `webhook_cb_probe:{sha256(url)}` via Redis `SET NX`.
3. When the circuit is open, the outbox row is re-enqueued with `created_at = resetAt` — no HTTP call is made.
4. Successful deliveries reset the breaker; retryable failures increment the shared failure counter.
5. `shouldRetry()` also stops retrying a single event once `consecutiveFailures >= threshold`, so an event is not re-queued behind an open circuit.

### Observing a receiver's circuit state

`GET /internal/webhooks/circuit-breakers?endpointUrl=<receiver url>` (admin auth) reports one receiver's state, whether deliveries are paused, why, and when they resume:

```json
{
  "total": 1,
  "states": [
    {
      "endpointUrl": "https://receiver.example/webhooks",
      "state": "open",
      "paused": true,
      "reason": "failure-threshold",
      "consecutiveFailures": 4,
      "failureCount": 4,
      "threshold": 4,
      "resetMs": 300000,
      "lastFailureTime": "2023-11-14T22:13:20.003Z",
      "resumeAt": "2023-11-14T22:18:20.003Z",
      "nextAttemptTime": "2023-11-14T22:18:20.003Z"
    }
  ],
  "observedAt": "2023-11-14T22:14:20.003Z"
}
```

`threshold` and `resetMs` are the effective values for this process, so the response always states the numbers the circuit is actually applying. `nextAttemptTime` is a deprecated alias of `resumeAt` kept for existing dashboards.

`resumeAt` is the **latest** moment the pause can still be in effect. For `failure-threshold` it is exact (`resetAt`). For `half-open-probe-in-flight` it is the state record's expiry — a half-open pause normally ends within seconds, when the probe reports success or failure; the bound only matters when the probing dispatcher died before recording an outcome.

**Pause reasons** — the `reason` field is the answer to "why did deliveries to this receiver stop?":

| `reason` | `paused` | Meaning | Resumes |
|----------|:--------:|---------|---------|
| `deliveries-allowed` | `false` | The circuit is `closed`; every attempt is delivered (subject to the rate limiter). | — (`resumeAt: null`) |
| `failure-threshold` | `true` | `consecutiveFailures >= threshold`. All attempts are blocked; the receiver is presumed down. | at `resumeAt` (`resetAt`), when one probe is admitted |
| `reset-elapsed` | `false` | The open window has passed but no probe has been claimed yet. The next attempt is admitted as the half-open probe. | immediately, on the next attempt |
| `half-open-probe-in-flight` | `true` | A single probe delivery is in flight (this replica or another); all other attempts are blocked. | when the probe reports success/failure, or at the latest at `resumeAt` (see below) |

`POST /internal/webhooks/circuit-breakers/:endpointUrl/reset` (admin auth) forces the circuit closed for an operator-forced recovery; the response carries the post-reset state so the caller can confirm `paused: false`.

### Security notes

- Consumer URLs are SHA-256-hashed before use as Redis key segments (same approach as the rate limiter) to prevent key injection and to avoid storing raw URLs in Redis keys.
- A crafted URL cannot trip a breaker for a different consumer because keys are derived from the full URL digest.
- The observability endpoint is admin-authenticated and echoes back the caller-supplied `endpointUrl`; it exposes no receiver state that an admin caller could not already read from the circuit-breaker keys, and it never widens delivery access to a receiver.

### Failure modes

| Condition | Behaviour |
|-----------|-----------|
| Circuit closed | Delivery proceeds (subject to rate limit). |
| Circuit open | Delivery deferred to `resetAt`; no consumer traffic. |
| Half-open probe succeeds | Circuit resets to closed. |
| Half-open probe fails | Circuit re-opens for another `circuitBreakerResetMs`. |
| Half-open probe never reports | The circuit stays `half-open` and paused until the state record expires (`max(circuitBreakerResetMs * 2, 300000)` ms), which reads back as `closed` and resumes delivery without operator action. The probe lock's own TTL does not re-admit delivery. |
| Threshold `0` (disabled) | The breaker is bypassed entirely: every attempt is allowed and no circuit is ever opened. |
| Redis unavailable | **Fail-open** for gate checks; deliveries proceed. Failure recording is best-effort. (Rule 2 of [`docs/security/redis-outage-policy.md`](security/redis-outage-policy.md) — availability-only, no deny/abuse gate.) |

Every edge above is asserted by
[`tests/webhooks/circuitBreaker.stateMachine.test.ts`](../tests/webhooks/circuitBreaker.stateMachine.test.ts),
which runs the same transition suite against both the Redis store and the in-process fallback store.

### How rate limiting works

1. Before firing a retry, the dispatcher calls `attemptWebhookDeliveryWithRateLimit` with the consumer's endpoint URL and the configured `RateLimitConfig` (`{ limit, windowMs }`).
2. The rate limiter (`src/redis/webhookRateLimit.ts`) maintains a Redis sorted set keyed by a SHA-256 hash of the consumer URL. Each recorded attempt is a member with score = timestamp (ms).
3. Entries older than `windowMs` are pruned on every check. If the remaining count is at or above `limit`, the attempt is **deferred** rather than dropped.
4. A deferred attempt returns `{ shouldRetry: true, rateLimited: true, retryAt: now + windowMs }`. The dispatcher re-inserts the outbox row with `created_at = retryAt`, so the deferral is durable in PostgreSQL.
5. `WEBHOOK_RETRY_RPS` (default `10`) controls `limit`; `windowMs` is `1000 ms` (one second).

### Burst configuration (token-bucket extension)

To allow momentary spikes in retry traffic above the steady-state
`WEBHOOK_RETRY_RPS` limit (e.g. a batch of stream creations), opt in to
the token-bucket layer with `WEBHOOK_RETRY_BURST`. When the burst is
exhausted the limiter reverts to the steady-state rate configured above.

| Env var                | Default | Description                                                                                          |
|------------------------|--------:|------------------------------------------------------------------------------------------------------|
| `WEBHOOK_RETRY_BURST`  |     `0` | Token-bucket capacity per consumer. `0` keeps the legacy sliding-window behaviour (backward compat). |

When `WEBHOOK_RETRY_BURST > 0`:

- The bucket starts full with `burst` tokens. Each successful delivery
  decrements the bucket by `1.0`.
- Tokens refill at the steady-state rate `WEBHOOK_RETRY_RPS` tokens per
  `windowMs` (default `10 / 1000 ms` = `0.01` tokens/ms), clamped to
  `burst`.
- When the bucket has fewer than `1.0` tokens, the attempt returns
  `{ canAttempt: false, retryAfterMs: ceil((1.0 - tokens) / refillRateMs) }`
  and the dispatcher defers it identically to the sliding-window path
  (outbox row re-enqueued with `created_at = retryAt`).

When `WEBHOOK_RETRY_BURST = 0` (default), the limiter is exactly the
`WEBHOOK_RETRY_RPS` sliding-window described above — behaviour is
unchanged for existing deployments.

**Observability** — the bucket fill level per consumer is exported as
the Prometheus gauge `fluxora_webhook_rate_limiter_bucket_fill{consumer_hash="…"}`
(the `consumer_hash` label is the same SHA-256 prefix used as the
Redis sliding-window key, so dashboards that already join by consumer
continue to work). The gauge is updated on every
`TokenBucketRateLimiter.checkLimit` call. See
`src/metrics/requestProtectionMetrics.ts` for the label cardinality
guarantees (one time-series per currently-tracked consumer, not per
historical attempt).

**Security** — the bucket only refills at the steady-state
`WEBHOOK_RETRY_RPS`, so a configured `burst` cannot be abused to sustain
an effective outbound rate above the configured limit. Bursts absorb
instantaneous spikes; over a `windowMs` window the average rate is at
most `WEBHOOK_RETRY_RPS`. Bucket entries from inactive consumers are
cleaned up after `30 s` of idleness, so a long-burst-then-disconnect
consumer does not pin a stale gauge series. See
`src/webhooks/rate-limiter.ts` and `tests/webhooks/rate-limiter.test.ts`.

### Failure modes

| Condition | Behaviour |
|-----------|-----------|
| Within rate limit | Attempt proceeds; attempt recorded in Redis. |
| Limit exceeded | Attempt deferred; outbox row re-enqueued with `retryAt = now + windowMs`. No delivery is dropped. |
| Redis unavailable | **Fail-open**: attempt proceeds normally. A Redis outage does not halt deliveries. (Rule 2 of [`docs/security/redis-outage-policy.md`](security/redis-outage-policy.md) — the only harm of a false default is lost availability, and there is no authorisation/abuse gate.) |
| `maxAttempts` reached | `shouldRetry = false`; row moves to dead-letter queue regardless of rate limit. |

### Outage policy

Both the retry **rate limiter** (`src/redis/webhookRateLimit.ts`) and the **circuit
breaker** (`src/redis/webhookCircuitBreakerStore.ts`) **fail open** when Redis is
unavailable — the attempt is allowed and recorded best-effort. This is a
deliberate, rule-2 classification of the governing outage policy, not an
accidental `catch`: the cost of a false "allow" is only availability (extra
deliveries), while a false "deny" would stall all webhook deliveries. The fail-open
is observable via `fluxora_webhook_rate_limiter_fail_open_total` and error logs.

This is deliberate opposite of the fail-closed stores (JWT revocation, WS ban),
which must never admit a denied subject. See
[`docs/security/redis-outage-policy.md`](security/redis-outage-policy.md).

### Security notes

- Consumer URLs are SHA-256-hashed before use as Redis key segments to prevent key-injection via crafted URLs and to bound key length.
- The rate limiter counts all outbound attempts (not just failures) to protect consumers from burst traffic regardless of outcome.
- Redis credentials are consumed from environment variables only and are never logged.

## Security notes

Webhook requests are signed with the configured secret and include delivery metadata headers. Production endpoints must use HTTPS unless they target loopback for local deployments. URLs with embedded credentials are rejected.

Consumers must treat webhook delivery as at-least-once: verify the signature, deduplicate by `x-fluxora-delivery-id`, and make handlers idempotent.

## Signature verification

Webhook consumers verify incoming requests by recomputing the HMAC-SHA256 signature using the shared signing secret. The verification path lives in `src/webhooks/signature.ts`.

### Request headers

| Header | Description |
|--------|-------------|
| `x-fluxora-delivery-id` | Unique identifier for the delivery (used for deduplication). |
| `x-fluxora-timestamp` | Unix timestamp (seconds) at which the request was signed. |
| `x-fluxora-signature` | HMAC-SHA256 hex digest of `{timestamp}.{rawBody}`. |
| `x-fluxora-event` | Event type (e.g. `stream.updated`). |

### Verification steps

1. Reject if the payload exceeds `DEFAULT_MAX_WEBHOOK_BODY_BYTES` (256 KiB).
2. Reject if the timestamp is not a positive integer.
3. Reject if the timestamp is outside `DEFAULT_WEBHOOK_TOLERANCE_SECONDS` (300s) of the current time.
4. Compute the expected signature and compare using a constant-time comparison (`timingSafeEqual` over HMAC-hashed inputs) to prevent timing attacks.
5. If `isDuplicateDelivery(deliveryId)` returns true, reject with `409 duplicate_delivery`.

### Secret rotation grace window

When a webhook consumer rotates its signing secret via the admin API, there is a transition period during which some producers may still be signing with the old secret. To avoid spurious verification failures, the verification path supports a **bounded dual-secret grace window**:

- During the grace window, **both** the previous and current secret are accepted.
- After the grace window expires, the previous secret is **rejected** with code `previous_secret_expired` (HTTP 401).
- The rotation timestamp and grace-window expiry are **persisted** in the `webhook_secrets` table (not held in memory), so a process restart cannot silently extend or shrink the window.
- The default grace window is `DEFAULT_WEBHOOK_SECRET_GRACE_WINDOW_SECONDS` (86 400 seconds / 24 hours).

#### Grace window parameters

`verifyWebhookSignature` accepts the following optional fields for rotation support:

| Field | Type | Description |
|-------|------|-------------|
| `secretPrevious` | `string` | The previous signing secret, valid only during the grace window. |
| `previousSecretRotatedAt` | `number` | Unix timestamp (seconds) when the previous secret was rotated out. When omitted, the previous secret is accepted unconditionally (backward compatibility). |
| `graceWindowSeconds` | `number` | Bounded grace window in seconds. Defaults to 86 400. Only consulted when `previousSecretRotatedAt` is also provided. |

#### Rotation flow

1. **Set initial secret**: `webhookSecretRepository.setSecret(id, secret)` inserts a row with no previous secret.
2. **Rotate**: `webhookSecretRepository.rotateSecret(id, { newSecret, graceWindowSeconds })` atomically moves the current secret to `previous_secret`, sets `previous_secret_rotated_at` and `previous_secret_expires_at`, and activates the new secret as `current_secret`.
3. **Verify**: The verification path checks both secrets. The previous secret is only accepted if `now < previous_secret_expires_at`.
4. **Cleanup**: `webhookSecretRepository.clearExpiredPreviousSecret(id, now)` nulls out the previous secret once the grace window has expired, providing defense-in-depth so the stale secret cannot be used even if the verification path is misconfigured.

#### Security properties

- **Bounded acceptance**: The previous secret is rejected after `graceWindowSeconds` — no indefinite acceptance of a stale secret.
- **Constant-time comparison**: Both secrets are verified using the same `constantTimeCompare` path, preventing timing-based secret enumeration.
- **Persistence**: Rotation state survives process restarts because it is stored in PostgreSQL, not in-memory.
- **Defense-in-depth cleanup**: The `clearExpiredPreviousSecret` method provides a second layer of protection by physically removing the previous secret after expiry.
- **Backward compatibility**: When `previousSecretRotatedAt` is not provided, the previous secret is accepted unconditionally, preserving existing behavior for callers that have not yet adopted the grace window.

#### Verification result codes

| Code | Status | Description |
|------|--------|-------------|
| `ok` | 200 | Signature verified successfully. |
| `previous_secret_expired` | 401 | The previous secret was provided but has exceeded its grace window. |
| `signature_mismatch` | 401 | No provided secret matched the signature. |
| `missing_secret` | 401 | No signing secret configured. |
| `missing_delivery_id` | 401 | `x-fluxora-delivery-id` header missing. |
| `missing_timestamp` | 401 | `x-fluxora-timestamp` header missing. |
| `missing_signature` | 401 | `x-fluxora-signature` header missing. |
| `invalid_timestamp` | 400 | Timestamp is not a positive integer. |
| `timestamp_outside_tolerance` | 401 | Timestamp is outside the allowed tolerance window. |
| `payload_too_large` | 413 | Request body exceeds the maximum allowed size. |
| `duplicate_delivery` | 409 | Delivery ID has already been processed. |

## SSRF Protection

All webhook target URLs are validated before any network call to prevent Server-Side Request Forgery (SSRF) attacks. This protection is applied in both the `WebhookDispatcher` class and the `dispatchWebhook` helper function.

### Blocked IP ranges

The SSRF guard blocks the following IP address ranges:

- **Loopback addresses**: `127.0.0.0/8`, `::1` (including `localhost`)
- **Link-local addresses**: `169.254.0.0/16` (includes AWS metadata endpoint `169.254.169.254`), `fe80::/10`
- **Private networks**: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7` (IPv6 unique local)
- **Reserved ranges**: `0.0.0.0/8`, `240.0.0.0/4`, `224.0.0.0/4` (multicast)
- **IPv4-mapped IPv6 loopback**: `::ffff:127.0.0.0/8`

### Protocol requirements

- **HTTPS required by default**: All webhook URLs must use HTTPS unless explicitly configured otherwise
- **HTTP/HTTPS only**: Other protocols (FTP, etc.) are rejected

### DNS rebinding protection

The guard resolves hostnames to IP addresses and validates each resolved IP against the blocked ranges. This prevents DNS rebinding attacks where an attacker might initially point a hostname to a public IP, then change it to a private IP after validation.

### Host allowlist (optional)

The `WEBHOOK_ALLOWED_HOSTS` environment variable can be set to restrict webhook delivery to specific hosts:

```bash
WEBHOOK_ALLOWED_HOSTS=api.example.com,*.trusted.com
```

- Supports exact hostnames: `api.example.com`
- Supports wildcard subdomains: `*.trusted.com` matches `sub.trusted.com` and `trusted.com`
- When not configured, all non-blocked hosts are allowed
- Blocked IP ranges are always rejected, even if in the allowlist

### Request timeout

All webhook fetches enforce a timeout (default 30 seconds) to prevent slow-loris attacks and hanging requests. The timeout is applied via `AbortController` in both the class-based dispatcher and the helper function.

### Configuration

Add to your environment configuration:

```bash
# Optional: Restrict webhook delivery to specific hosts
WEBHOOK_ALLOWED_HOSTS=api.example.com,*.trusted.com
```

### Error handling

SSRF validation failures are logged without exposing the full URL for security. The validation fails closed: any ambiguous or unresolvable target is rejected with a `WebhookTargetValidationError`.

### Implementation details

- Validation function: `validateWebhookTarget(url, options)` in `src/webhooks/ssrfGuard.ts`
- Applied in: `WebhookDispatcher.dispatch()` and `dispatchWebhook()` in `src/webhooks/dispatcher.ts`
- Timeout: Uses `DEFAULT_RETRY_POLICY.timeoutMs` (30 seconds)
- DNS resolution: Uses Node.js `dns.promises.lookup()`
