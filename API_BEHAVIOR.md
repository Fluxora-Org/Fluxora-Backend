# Fluxora HTTP API: Behavior Specification

## Overview

This document specifies the observable behavior of the Fluxora HTTP API under normal and failure conditions. It serves as the source of truth for client expectations and operator diagnostics.

**Last Updated**: 2024-01-01  
**Version**: 0.1.0  
**Status**: Operator-Grade Reliability

---

## Trust Boundaries

### Public Internet Clients
- **Access**: Read-only (GET /health, GET /api/streams, GET /api/streams/{id})
- **Restrictions**: No authentication required; rate limiting applies
- **Guarantees**: Best-effort; no SLA

### Authenticated Partners
- **Access**: Create and manage streams (POST /api/streams, GET /api/streams)
- **Authentication**: Bearer token (JWT)
- **Guarantees**: Idempotency via Idempotency-Key header; duplicate detection

### Administrators
- **Access**: Full access including internal endpoints
- **Authentication**: Bearer token with admin scope
- **Guarantees**: All partner guarantees plus internal diagnostics

### Internal Workers
- **Access**: Indexer endpoints (POST /internal/indexer/sync)
- **Authentication**: Bearer token with worker scope
- **Guarantees**: Async processing; no response body guarantee

---

## HTTP Status Codes & Semantics

### Success Responses

All successful responses follow this standardized structure:

```json
{
  "success": true,
  "data": {
    // Response payload
  },
  "meta": {
    "timestamp": "2024-01-01T12:00:00.000Z",
    "requestId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

### 200 OK
- **When**: Request succeeded; response body contains result
- **Body**: JSON object with `success: true`, `data`, and `meta` fields
- **Idempotent**: Yes (safe to retry)
- **Example**: GET /api/streams returns stream list wrapped in success envelope

### 201 Created
- **When**: Resource created successfully
- **Body**: JSON object with `success: true`, created resource in `data`, and `meta` fields
- **Idempotent**: Yes (via Idempotency-Key)
- **Example**: POST /api/streams returns new stream wrapped in success envelope

### 202 Accepted
- **When**: Request accepted for async processing
- **Body**: JSON object with `success: true`, status in `data`, and `meta` fields
- **Idempotent**: Yes
- **Example**: POST /internal/indexer/sync queues sync job

### 400 Bad Request
- **When**: Malformed request (invalid JSON, missing fields, wrong types)
- **Body**: Error response with standardized envelope
- **Idempotent**: No (retry may succeed with corrected request)
- **Examples**:
  - Invalid JSON: `{"success": false, "error": {"code": "INVALID_JSON", "message": "Request body must be valid JSON"}}`
  - Missing field: `{"success": false, "error": {"code": "VALIDATION_ERROR", "message": "sender is required"}}`

### 401 Unauthorized
- **When**: Missing or invalid authentication token
- **Body**: Error response with code "UNAUTHORIZED"
- **Idempotent**: No (retry with valid token may succeed)
- **Cause**: Missing Authorization header, expired token, invalid signature

### 403 Forbidden
- **When**: Authenticated but insufficient permissions
- **Body**: Error response with code "FORBIDDEN"
- **Idempotent**: No (retry with different credentials may succeed)
- **Example**: Non-admin trying to access /internal/indexer

### 404 Not Found
- **When**: Resource does not exist
- **Body**: Error response with code "NOT_FOUND"
- **Idempotent**: Yes (resource will not exist on retry)
- **Example**: GET /api/streams/stream-invalid returns 404

### 409 Conflict
- **When**: Duplicate submission detected (Idempotency-Key collision with different body)
- **Body**: Error response with code "CONFLICT"
- **Idempotent**: No (retry with same body returns 201; different body returns 409)
- **Cause**: Same Idempotency-Key used with different request body
- **Recovery**: Use new Idempotency-Key or retry with original body

### 413 Payload Too Large
- **When**: Request body exceeds 256 KiB
- **Body**: Error response with code "PAYLOAD_TOO_LARGE"
- **Idempotent**: No (retry with smaller payload may succeed)
- **Limit**: 256 KiB (262,144 bytes)

### 422 Unprocessable Entity
- **When**: Request is valid JSON but fails business logic validation
- **Body**: Error response with code and details
- **Idempotent**: No (retry may succeed if conditions change)
- **Examples**:
  - Sender and recipient are the same
  - Deposit amount < rate per second
  - Start time is in the past (>1 hour ago)

### 500 Internal Server Error
- **When**: Unexpected error in service code
- **Body**: Error response with code "INTERNAL_ERROR" and requestId
- **Idempotent**: Unknown (check logs with requestId)
- **Action**: Log requestId; contact support

### 503 Service Unavailable
- **When**: Dependency is unhealthy (database, Stellar RPC, workers)
- **Body**: Error response with code "SERVICE_UNAVAILABLE"
- **Idempotent**: Yes (retry after dependency recovers)
- **Cause**: Database connection failed, Stellar RPC timeout, worker queue full
- **Recovery**: Automatic; retry after 30 seconds

---

## Failure Modes & Client-Visible Behavior

### Invalid Input

#### Malformed JSON
- **Trigger**: Request body is not valid JSON
- **Status**: 400
- **Code**: `invalid_json`
- **Message**: "Request body must be valid JSON"
- **Recovery**: Fix JSON syntax and retry

#### Invalid Stellar Address
- **Trigger**: Address doesn't match pattern `^G[A-Z2-7]{55}$`
- **Status**: 400
- **Code**: `validation_error`
- **Message**: "sender must be a valid Stellar public key (starts with G, 56 chars)"
- **Details**: `{ field: "sender", value: "invalid-address" }`
- **Recovery**: Use valid Stellar public key

#### Invalid Amount
- **Trigger**: Amount is not a positive integer or exceeds max
- **Status**: 400 or 422
- **Code**: `validation_error`
- **Message**: "depositAmount must be a non-negative integer (stroops)"
- **Details**: `{ field: "depositAmount", value: "-100" }`
- **Recovery**: Use positive integer within Stellar limits (max: 9223372036854775807)

#### Oversized Payload
- **Trigger**: Request body > 256 KiB
- **Status**: 413
- **Code**: `payload_too_large`
- **Message**: "Request body exceeds the 256 KiB limit"
- **Recovery**: Reduce payload size or split into multiple requests

#### Deeply Nested JSON
- **Trigger**: JSON depth > 10 levels
- **Status**: 400
- **Code**: `validation_error`
- **Message**: "request body exceeds maximum JSON depth of 10"
- **Recovery**: Flatten JSON structure

### Business Logic Validation

#### Sender and Recipient Are the Same
- **Trigger**: `sender === recipient`
- **Status**: 422
- **Code**: `VALIDATION_ERROR`
- **Message**: "sender and recipient must be different addresses"
- **Recovery**: Use different addresses

#### Insufficient Deposit
- **Trigger**: `depositAmount < ratePerSecond`
- **Status**: 422
- **Code**: `VALIDATION_ERROR`
- **Message**: "depositAmount must be at least equal to ratePerSecond (minimum 1 second of streaming)"
- **Recovery**: Increase depositAmount or decrease ratePerSecond

#### Invalid Timestamp
- **Trigger**: `startTime < now - 1 hour` or `startTime` is not a valid Unix timestamp
- **Status**: 400 or 422
- **Code**: `VALIDATION_ERROR`
- **Message**: "startTime must be in the future or within the last hour"
- **Recovery**: Use future timestamp or timestamp within last hour

### Duplicate Submission

#### Idempotency-Key Collision (Same Body)
- **Trigger**: Same Idempotency-Key with identical request body
- **Status**: 201 (cached response)
- **Behavior**: Returns same response as original request
- **Guarantee**: Exactly-once semantics

#### Idempotency-Key Collision (Different Body)
- **Trigger**: Same Idempotency-Key with different request body
- **Status**: 409
- **Code**: `CONFLICT`
- **Message**: "Duplicate Idempotency-Key with different request body"
- **Recovery**: Use new Idempotency-Key or retry with original body

#### Missing Idempotency-Key
- **Trigger**: POST /api/streams without Idempotency-Key header
- **Status**: 400
- **Code**: `VALIDATION_ERROR`
- **Message**: "Idempotency-Key header is required and must be a single string value"
- **Recovery**: Add Idempotency-Key header with a unique value matching `[A-Za-z0-9:_-]`, 1–128 chars

#### Malformed Idempotency-Key
- **Trigger**: Key contains disallowed characters, or exceeds 128 / is under 1 character
- **Status**: 400
- **Code**: `VALIDATION_ERROR`
- **Recovery**: Use a valid key (UUID v4 recommended)

### Dependency Outages

#### Database Connection Failed
- **Trigger**: Cannot connect to database
- **Status**: 503
- **Code**: `SERVICE_UNAVAILABLE`
- **Message**: "Service temporarily unavailable"
- **Behavior**: All endpoints return 503
- **Recovery**: Automatic; retry after 30 seconds

#### Stellar RPC Timeout
- **Trigger**: Stellar RPC endpoint does not respond within timeout
- **Status**: 503
- **Code**: `SERVICE_UNAVAILABLE`
- **Message**: "Service temporarily unavailable"
- **Behavior**: Stream creation may fail; listing may return stale data
- **Recovery**: Automatic; retry after 30 seconds

---

## Stellar RPC: Timeout, Cancellation, and Failure Classification

### Overview

All Stellar RPC calls go through `StellarRpcService` in `src/services/stellar-rpc.ts`, which enforces:

- **Per-call timeout** — configurable via `RPC_TIMEOUT_MS` (default 5 000 ms)
- **AbortController cancellation** — callers may pass an `AbortSignal` to cancel in-flight calls
- **Structured failure classification** — every failure is tagged with a `kind` field
- **Circuit breaker** — trips after repeated failures to prevent cascade

### Failure Kinds (`RpcFailureKind`)

| Kind | Cause | Operator action |
|------|-------|-----------------|
| `TIMEOUT` | Call did not complete within `timeoutMs` | Check RPC endpoint latency; increase `RPC_TIMEOUT_MS` if needed |
| `NETWORK` | Connection-level error (`ECONNREFUSED`, `ENOTFOUND`, etc.) | Verify network path to RPC endpoint; check DNS |
| `PROVIDER` | RPC returned an error response (4xx / 5xx) | Inspect `statusCode` in log; check RPC provider status |
| `CIRCUIT_OPEN` | Circuit breaker is OPEN; call was not attempted | Wait for `RPC_CB_RESET_TIMEOUT_MS`; check upstream health |
| `CANCELLED` | Caller aborted via `AbortSignal` | Expected; no action required |

### Structured Log Fields

Every failure emits a `warn` log with these fields:

```json
{
  "event": "rpc_failure",
  "operation": "getLatestLedger",
  "kind": "TIMEOUT",
  "statusCode": null,
  "durationMs": 5001,
  "error": "getLatestLedger timed out after 5000ms"
}
```

### AbortController Usage

Pass an `AbortSignal` to cancel a call externally:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 3000); // cancel after 3 s

try {
  const ledger = await rpcService.getLatestLedger({ signal: controller.signal });
} catch (err) {
  if (err instanceof RpcProviderError && err.kind === 'CANCELLED') {
    // call was cancelled — safe to ignore or retry
  }
}
```

### Circuit Breaker Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `RPC_TIMEOUT_MS` | `5000` | Per-call timeout in ms |
| `RPC_CB_FAILURE_THRESHOLD` | `5` | Failures within window before tripping |
| `RPC_CB_WINDOW_MS` | `30000` | Rolling failure-counting window in ms |
| `RPC_CB_RESET_TIMEOUT_MS` | `60000` | Time OPEN before allowing a probe in ms |

### Failure Modes and Expected Behavior

| Condition | `kind` | Circuit breaker | Client-visible outcome |
|-----------|--------|-----------------|------------------------|
| RPC unreachable | `NETWORK` | Counts toward threshold | `503 Service Unavailable` |
| RPC slow / hung | `TIMEOUT` | Counts toward threshold | `503 Service Unavailable` |
| RPC 5xx response | `PROVIDER` | Counts toward threshold | `503 Service Unavailable` |
| Breaker OPEN | `CIRCUIT_OPEN` | Already OPEN | `503 Service Unavailable` (fast-fail) |
| Caller cancelled | `CANCELLED` | Does **not** count | Request aborted; no response sent |

### Security Notes

- Timeout values are read from environment variables at startup; they are not user-controllable at runtime.
- `AbortSignal` cancellation does not suppress circuit-breaker accounting — only `CANCELLED` failures are excluded from the failure count.
- No RPC credentials or internal error details are forwarded to HTTP clients; only `503` with a generic message is returned.

#### Worker Queue Full
- **Trigger**: Indexer worker queue exceeds capacity
- **Status**: 503
- **Code**: `SERVICE_UNAVAILABLE`
- **Message**: "Service temporarily unavailable"
- **Behavior**: POST /internal/indexer/sync returns 503
- **Recovery**: Automatic; retry after 60 seconds

### Partial Data

#### Stale Stream Listing
- **Trigger**: Database lag or Stellar RPC delay
- **Status**: 200
- **Behavior**: Stream list may not include very recent streams
- **Guarantee**: Eventual consistency within 5 minutes
- **Mitigation**: Use cursor-based pagination; check stream status endpoint

#### Missing Stream Details
- **Trigger**: Stream created but not yet indexed
- **Status**: 404
- **Behavior**: GET /api/streams/{id} returns 404 immediately after creation
- **Guarantee**: Stream will be available within 30 seconds
- **Mitigation**: Retry with exponential backoff

---

## Idempotency Guarantees

### Exactly-Once Semantics
- **Scope**: POST /api/streams (stream creation)
- **Mechanism**: `Idempotency-Key` request header + SHA-256 fingerprint of normalised body
- **Duration**: Process lifetime (in-memory store); Redis-backed store recommended for production (24-hour TTL)
- **Guarantee**: Same `Idempotency-Key` + same body = same response, served from cache

### Idempotency-Key Format
- **Required**: Yes — missing or malformed key returns `400 VALIDATION_ERROR`
- **Length**: 1–128 characters
- **Charset**: `[A-Za-z0-9:_-]` — letters, digits, colon, underscore, hyphen
- **Recommended**: UUID v4 (`550e8400-e29b-41d4-a716-446655440000`)
- **Validation**: Enforced by `requireIdempotencyKey` middleware before the handler runs

### Response Headers
| Header | Value | Meaning |
|--------|-------|---------|
| `Idempotency-Key` | Echoed from request | Confirms which key was processed |
| `Idempotency-Replayed` | `true` / `false` | `true` = served from cache; `false` = fresh creation |

### Response Body Signal
The `meta` object in every `201` response carries `idempotencyReplayed`:
- **Fresh creation**: `meta.idempotencyReplayed` is absent
- **Replay**: `meta.idempotencyReplayed: true`

### Collision Behaviour (Same Key, Different Body)
- **Status**: `409 CONFLICT`
- **Code**: `CONFLICT`
- **Message**: "Idempotency-Key has already been used for a different request payload"
- **Details**: `{ hint: "Use a new Idempotency-Key or retry with the original request body" }`
- **Security**: The raw key value is **never** included in the error response body or server logs

### Retry Semantics
- **Safe to Retry**: 201 (with same key+body), 400, 409, 413, 422, 503
- **Unsafe to Retry**: 401, 403, 500
- **Recommended Strategy**: Exponential backoff with jitter (1s, 2s, 4s, 8s, 16s)

### Failure Atomicity
If the database upsert fails (e.g. pool exhausted → 503), the idempotency key is **not** stored. The client may safely retry with the same key and body once the dependency recovers.

---

## Error Response Format

All error responses follow this standardized structure:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "details": {
      "field": "fieldName",
      "value": "fieldValue"
    },
    "requestId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

### Fields
- **success**: Always `false` for error responses
- **error.code**: Machine-readable error code (UPPER_SNAKE_CASE)
- **error.message**: Human-readable description
- **error.details**: Optional; additional context (field name, value, etc.)
- **error.requestId**: Correlation ID for debugging (always present when available)

### Error Codes
- `INVALID_JSON`: Malformed JSON
- `VALIDATION_ERROR`: Input validation failed
- `INVALID_STELLAR_ADDRESS`: Address format invalid
- `INVALID_AMOUNT`: Amount validation failed
- `PAYLOAD_TOO_LARGE`: Request exceeds size limit
- `UNAUTHORIZED`: Missing or invalid authentication
- `FORBIDDEN`: Insufficient permissions
- `NOT_FOUND`: Resource not found
- `CONFLICT`: Duplicate submission (Idempotency-Key collision)
- `SERVICE_UNAVAILABLE`: Dependency outage
- `INTERNAL_ERROR`: Unexpected server error
- `DECIMAL_ERROR`: Decimal string serialization error

---

## Observability & Diagnostics

### Request Correlation
- **Header**: `X-Correlation-ID` (auto-generated if missing)
- **Propagation**: Included in all logs and error responses
- **Usage**: Track request through system for debugging

### Health Check Endpoint
- **Path**: GET /health
- **Response**: `{ status: "healthy" | "degraded" | "unhealthy", dependencies: {...} }`
- **Frequency**: Recommended every 30 seconds
- **Timeout**: 5 seconds

### Dependency Health
- **Database**: Connection test + query latency
- **Stellar RPC**: Ledger query latency
- **Workers**: Queue depth + recent error rate

### Logging
- **Level**: INFO for normal operations, WARN for client errors, ERROR for server errors
- **Fields**: timestamp, level, requestId, method, path, status, duration, error
- **Retention**: 30 days

### Metrics
- **Request Rate**: Requests per second (by endpoint, status code)
- **Latency**: p50, p95, p99 (by endpoint)
- **Error Rate**: Errors per second (by code)
- **Dependency Health**: Latency, error rate (by dependency)

---

## Rate Limiting

### Public Endpoints
- **Limit**: 100 requests per minute per IP
- **Header**: `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- **Status**: 429 Too Many Requests (when exceeded)

### Authenticated Endpoints
- **Limit**: 1000 requests per minute per user
- **Header**: `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- **Status**: 429 Too Many Requests (when exceeded)

### Internal Endpoints
- **Limit**: Unlimited (for internal workers)

---

## Operational Runbooks

### Incident: High Error Rate (>5%)

1. **Check health endpoint**: `curl http://localhost:3000/health`
2. **Identify failing dependency**: Check `dependencies` in health response
3. **If database**: Check database connection, query logs
4. **If Stellar RPC**: Check RPC endpoint availability, network connectivity
5. **If workers**: Check worker queue depth, recent errors
6. **Mitigation**: Restart affected service or failover to backup

### Incident: Slow Response Times (p95 > 1s)

1. **Check database query performance**: Analyze slow query logs
2. **Check Stellar RPC latency**: Measure RPC endpoint response time
3. **Check worker queue depth**: If high, scale up workers
4. **Check system resources**: CPU, memory, disk I/O
5. **Mitigation**: Optimize queries, scale up resources, or failover

### Incident: Duplicate Stream Creation

1. **Check Idempotency-Key**: Verify client is using unique keys
2. **Check request fingerprinting**: Verify fingerprint logic is correct
3. **Check cache**: Verify idempotency cache is working
4. **Mitigation**: Clear cache if corrupted; restart service

### Incident: Stale Stream Data

1. **Check indexer worker**: Verify worker is running and processing
2. **Check Stellar RPC**: Verify RPC endpoint is up-to-date
3. **Check database**: Verify database is not lagging
4. **Mitigation**: Restart indexer worker; check RPC endpoint

---

## RPC Degradation Middleware

When the Stellar RPC provider becomes unreachable the backend activates a **degradation policy** enforced by the `rpcDegradation` middleware. The policy is observable, deterministic, and documented here so that clients and operators can reason about behavior during an outage without guessing.

### Circuit Breaker States

| State | Meaning |
|-------|---------|
| `CLOSED` | Normal operation — all requests pass through |
| `OPEN` | Tripped after repeated RPC failures — writes blocked, reads carry staleness warning |
| `HALF_OPEN` | One probe call is allowed to test recovery — treated as degraded until the probe succeeds |

The breaker trips when `failureThreshold` failures occur within the rolling `windowMs` window. It stays `OPEN` for `resetTimeoutMs` before transitioning to `HALF_OPEN`.

### Client-Visible Outcomes

| Condition | HTTP Method | Status | Response Headers | Body |
|-----------|-------------|--------|------------------|------|
| Circuit CLOSED | Any | Normal route response | `X-Degradation-State: CLOSED` | Normal response body |
| Circuit OPEN / HALF_OPEN | GET, HEAD, OPTIONS | 200 (stale data) | `Warning: 199 fluxora-backend "Stellar RPC unavailable - data may be stale"`, `X-Degradation-State: OPEN` | Cached / database-backed response |
| Circuit OPEN / HALF_OPEN | POST, PUT, PATCH, DELETE | 503 | `X-Degradation-State: OPEN` | `{"error":{"code":"SERVICE_UNAVAILABLE","message":"...","degradation":{...}}}` |
| Circuit recovers → CLOSED | Any | Normal route response | `X-Degradation-State: CLOSED` | Normal response body |

### Response Headers

| Header | Present | Description |
|--------|---------|-------------|
| `X-Degradation-State` | Always | Current circuit state: `CLOSED`, `OPEN`, or `HALF_OPEN` |
| `Warning` | Only when degraded + read request | RFC 7234 warning indicating the response data may be stale |

### Error Response Shape (503)

```json
{
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Stellar RPC is currently unavailable — mutating operations are temporarily suspended",
    "degradation": {
      "circuitState": "OPEN",
      "failureCount": 5,
      "openedAt": "2026-04-22T22:30:00.000Z"
    }
  }
}
```

### Trust Boundaries

| Actor | May do | May not do |
|-------|--------|------------|
| Public internet clients | Observe `X-Degradation-State` header, read stale data during degradation | Force the circuit open or closed, bypass the write block |
| Authenticated partners | Same as public clients; additionally retry writes after recovery | Skip the staleness signal or ignore `Warning` headers |
| Administrators / operators | Monitor state via `/health` and `X-Degradation-State`, manually reset the circuit | Disable the degradation middleware at runtime without a deploy |
| Internal workers | Continue read-only operations during degradation | Write to chain-derived state while the circuit is tripped |

### Failure Modes

| Condition | Expected Behavior |
|-----------|-------------------|
| Single RPC failure | `RpcProviderError` thrown; circuit stays `CLOSED` until threshold reached |
| Threshold reached | Circuit trips to `OPEN`; subsequent writes return 503 immediately |
| `OPEN` + read request | 200 with `Warning` header; data served from database/cache |
| `OPEN` + write request | 503 with error body including degradation diagnostics |
| Reset timeout expires | Circuit transitions to `HALF_OPEN`; one probe call is allowed |
| Probe succeeds | Circuit returns to `CLOSED`; normal operation resumes |
| Probe fails | Circuit returns to `OPEN`; degradation continues |
| Manual `resetCircuit()` | Circuit forced to `CLOSED`; use for operator recovery |

### Operator Observability

- **`X-Degradation-State` header**: present on every HTTP response; monitor with edge probes or log analysis
- **`GET /health`**: reports overall service status as `degraded` when the RPC circuit is not `CLOSED`
- **Structured logs**: state transitions emit `rpc_degradation_transition` events; blocked writes emit `rpc_degradation_write_blocked` events
- **Triage flow**:
  1. Check `X-Degradation-State` header on any response or query `/health`
  2. If `OPEN`: inspect structured logs for `rpc_failure` events to identify the RPC provider issue
  3. If sustained: consider manual `resetCircuit()` after verifying RPC provider recovery
  4. If resolved: confirm `X-Degradation-State: CLOSED` on subsequent requests

### Decimal String Serialization Guarantee

The degradation middleware does **not** modify response bodies. All amount fields (`depositAmount`, `ratePerSecond`, etc.) continue to be serialized as decimal strings per the project-wide serialization policy, regardless of degradation state.

### Verification Evidence

- Automated tests: `tests/incidents/rpc_outage.test.ts`
- Manual check: trip the circuit via repeated RPC failures and verify:
  - `GET /api/streams` returns 200 with `Warning` and `X-Degradation-State: OPEN`
  - `POST /api/streams` returns 503 with degradation diagnostics

---

## CORS Policy

### Overview

Cross-Origin Resource Sharing (CORS) is enforced by `corsAllowlistMiddleware` in `src/middleware/cors.ts`, applied globally before all routes. The policy differs between development and production environments.

### Environment Behaviour

| Environment | Allowed origins | Preflight result |
|-------------|-----------------|------------------|
| Non-production (`NODE_ENV !== 'production'`) | Any origin | `204 No Content` with full CORS headers |
| Production | Origins listed in `CORS_ALLOWED_ORIGINS` | `204 No Content` if allowed; `403` if denied |

### Configuration

Set `CORS_ALLOWED_ORIGINS` as a comma-separated list of exact origin strings:

```
CORS_ALLOWED_ORIGINS=https://app.fluxora.io,https://ops.fluxora.io
```

- Whitespace around each entry is trimmed automatically.
- An empty or unset value means **no origin is allowed** in production.

### Response Headers

| Header | When present | Value |
|--------|-------------|-------|
| `Access-Control-Allow-Origin` | Origin is allowed | Echoed request `Origin` value |
| `Vary` | Origin is allowed | `Origin` |
| `Access-Control-Allow-Methods` | Origin is allowed | `GET,POST,PUT,PATCH,DELETE,OPTIONS` |
| `Access-Control-Allow-Headers` | Origin is allowed | Echoed `Access-Control-Request-Headers` if present; otherwise `Content-Type,Authorization,X-Correlation-ID` |
| `Access-Control-Max-Age` | Preflight only | `86400` (24 hours) |

### Preflight Handling

A preflight request is an `OPTIONS` request that carries an `Origin` header.

- **Allowed origin** → `204 No Content` with all CORS headers including `Access-Control-Max-Age: 86400`.
- **Denied origin** → `403 Forbidden` with body `{ "error": { "code": "CORS_ORIGIN_DENIED", "message": "Origin is not allowed by CORS policy" } }`.
- **No `Origin` header** → `204 No Content` with no CORS headers (non-browser probe; passes through).

### Non-Preflight Requests

- **Allowed origin** → CORS headers are set; request continues to the route handler.
- **Denied origin** → No CORS headers; request continues to the route handler (browser will block the response client-side).
- **No `Origin` header** → Request continues to the route handler unchanged.

### Failure Modes

| Condition | Expected behaviour |
|-----------|-------------------|
| `CORS_ALLOWED_ORIGINS` unset in production | All origins denied; preflight returns `403` |
| Origin not in allowlist (preflight) | `403` with `CORS_ORIGIN_DENIED` |
| Origin not in allowlist (non-preflight) | No CORS headers; browser enforces same-origin policy |
| `OPTIONS` without `Origin` | `204` — treated as a non-browser probe |

### Security Notes

- Origins are matched exactly (no wildcard or prefix matching in production).
- The `Vary: Origin` header is always set when an origin is allowed, preventing CDN caching of origin-specific responses.
- `Access-Control-Allow-Headers` echoes the client's `Access-Control-Request-Headers` to avoid blocking legitimate custom headers while still requiring the browser to declare them.
- `Access-Control-Max-Age: 86400` reduces preflight round-trips without weakening security.

### Verification Evidence

- Automated tests: `tests/cors.test.ts` (16 cases, ≥95% coverage of `src/middleware/cors.ts`)

---

## Non-Goals & Deferred Work

### Out of Scope (v0.1.0)
- [ ] WebSocket subscriptions for real-time updates
- [ ] Batch stream creation endpoint
- [ ] Stream cancellation endpoint
- [ ] Advanced filtering (by amount, date range, etc.)
- [ ] Webhook notifications
- [ ] GraphQL API

### Follow-Up Issues
- [ ] #8: WebSocket subscriptions for stream updates
- [ ] #9: Batch stream creation for bulk operations
- [ ] #10: Stream cancellation and refund logic
- [ ] #11: Advanced filtering and search
- [ ] #12: Webhook notifications for stream events

---

## Testing & Verification

### Unit Tests
- **Coverage**: ≥95% for validation, helpers, error handling
- **Location**: `tests/validation-edge-cases.test.ts`, `tests/helpers.test.ts`
- **Run**: `npm test`

### Integration Tests
- **Coverage**: All HTTP endpoints, failure modes, idempotency
- **Location**: `tests/streams.test.ts`, `tests/health.test.ts`
- **Run**: `npm test`

### Load Tests
- **Tool**: k6
- **Scenarios**: Normal load, spike, sustained high load
- **Location**: `k6/scenarios/`
- **Run**: `k6 run k6/main.js`

### Staging Drills
- **Frequency**: Weekly
- **Scenarios**: Database failover, RPC endpoint failure, worker queue full
- **Verification**: All endpoints return appropriate status codes and error messages

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2024-01-01 | Initial release: stream creation, listing, health checks |

---

## References

- OpenAPI Specification: `openapi.yaml`
- Validation Tests: `tests/validation-edge-cases.test.ts`
- Helper Tests: `tests/helpers.test.ts`
- Integration Tests: `tests/streams.test.ts`
- Load Tests: `k6/main.js`
