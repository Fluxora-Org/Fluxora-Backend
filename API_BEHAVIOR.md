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

### 200 OK
- **When**: Request succeeded; response body contains result
- **Body**: JSON object with requested data
- **Idempotent**: Yes (safe to retry)
- **Example**: GET /api/streams returns stream list

### 201 Created
- **When**: Resource created successfully
- **Body**: JSON object with created resource
- **Idempotent**: Yes (via Idempotency-Key)
- **Example**: POST /api/streams returns new stream

### 202 Accepted
- **When**: Request accepted for async processing
- **Body**: JSON object with status (e.g., "queued")
- **Idempotent**: Yes
- **Example**: POST /internal/indexer/sync queues sync job

### 400 Bad Request
- **When**: Malformed request (invalid JSON, missing fields, wrong types)
- **Body**: Error response with code and message
- **Idempotent**: No (retry may succeed with corrected request)
- **Examples**:
  - Invalid JSON: `{"error": {"code": "invalid_json", "message": "Request body must be valid JSON"}}`
  - Missing field: `{"error": {"code": "validation_error", "message": "sender is required"}}`

### 401 Unauthorized
- **When**: Missing or invalid authentication token
- **Body**: Error response with code "unauthorized"
- **Idempotent**: No (retry with valid token may succeed)
- **Cause**: Missing Authorization header, expired token, invalid signature

### 403 Forbidden
- **When**: Authenticated but insufficient permissions
- **Body**: Error response with code "forbidden"
- **Idempotent**: No (retry with different credentials may succeed)
- **Example**: Non-admin trying to access /internal/indexer

### 404 Not Found
- **When**: Resource does not exist
- **Body**: Error response with code "not_found"
- **Idempotent**: Yes (resource will not exist on retry)
- **Example**: GET /api/streams/stream-invalid returns 404

### 409 Conflict
- **When**: Duplicate submission detected (Idempotency-Key collision with different body)
- **Body**: Error response with code "conflict"
- **Idempotent**: No (retry with same body returns 201; different body returns 409)
- **Cause**: Same Idempotency-Key used with different request body
- **Recovery**: Use new Idempotency-Key or retry with original body

### 413 Payload Too Large
- **When**: Request body exceeds 256 KiB
- **Body**: Error response with code "payload_too_large"
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
- **Body**: Error response with code "internal_error" and requestId
- **Idempotent**: Unknown (check logs with requestId)
- **Action**: Log requestId; contact support

### 503 Service Unavailable
- **When**: Dependency is unhealthy (database, Stellar RPC, workers)
- **Body**: Error response with code "service_unavailable"
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
- **Code**: `validation_error`
- **Message**: "sender and recipient must be different addresses"
- **Recovery**: Use different addresses

#### Insufficient Deposit
- **Trigger**: `depositAmount < ratePerSecond`
- **Status**: 422
- **Code**: `validation_error`
- **Message**: "depositAmount must be at least equal to ratePerSecond (minimum 1 second of streaming)"
- **Recovery**: Increase depositAmount or decrease ratePerSecond

#### Invalid Timestamp
- **Trigger**: `startTime < now - 1 hour` or `startTime` is not a valid Unix timestamp
- **Status**: 400 or 422
- **Code**: `validation_error`
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
- **Code**: `conflict`
- **Message**: "Duplicate Idempotency-Key with different request body"
- **Recovery**: Use new Idempotency-Key or retry with original body

#### Missing Idempotency-Key
- **Trigger**: POST /api/streams without Idempotency-Key header
- **Status**: 400
- **Code**: `validation_error`
- **Message**: "Idempotency-Key header is required"
- **Recovery**: Add Idempotency-Key header with unique value

### Dependency Outages

#### Database Connection Failed
- **Trigger**: Cannot connect to database
- **Status**: 503
- **Code**: `service_unavailable`
- **Message**: "Service temporarily unavailable"
- **Behavior**: All endpoints return 503
- **Recovery**: Automatic; retry after 30 seconds

#### Stellar RPC Timeout
- **Trigger**: Stellar RPC endpoint does not respond within timeout
- **Status**: 503
- **Code**: `service_unavailable`
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
- **Code**: `service_unavailable`
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
- **Mechanism**: Idempotency-Key header + request fingerprint
- **Duration**: 24 hours (idempotency key stored in cache)
- **Guarantee**: Same Idempotency-Key + same body = same response

### Idempotency-Key Format
- **Required**: Yes (for POST /api/streams)
- **Format**: UUID or unique string (20+ chars recommended)
- **Example**: `550e8400-e29b-41d4-a716-446655440000`
- **Validation**: Must be non-empty string

### Retry Semantics
- **Safe to Retry**: 201, 400, 409, 413, 422, 503
- **Unsafe to Retry**: 401, 403, 500
- **Recommended Strategy**: Exponential backoff with jitter (1s, 2s, 4s, 8s, 16s)

---

## Error Response Format

All error responses follow this structure:

```json
{
  "error": {
    "code": "error_code",
    "message": "Human-readable message",
    "status": 400,
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "details": {
      "field": "fieldName",
      "value": "fieldValue"
    }
  }
}
```

### Fields
- **code**: Machine-readable error code (snake_case)
- **message**: Human-readable description
- **status**: HTTP status code (for reference)
- **requestId**: Correlation ID for debugging (always present)
- **details**: Optional; additional context (field name, value, etc.)

### Error Codes
- `invalid_json`: Malformed JSON
- `validation_error`: Input validation failed
- `invalid_stellar_address`: Address format invalid
- `invalid_amount`: Amount validation failed
- `payload_too_large`: Request exceeds size limit
- `unauthorized`: Missing or invalid authentication
- `forbidden`: Insufficient permissions
- `not_found`: Resource not found
- `conflict`: Duplicate submission (Idempotency-Key collision)
- `service_unavailable`: Dependency outage
- `internal_error`: Unexpected server error

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
