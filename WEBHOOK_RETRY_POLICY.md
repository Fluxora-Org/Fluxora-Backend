# Webhook Retry Policy for Fluxora Backend

## Overview

This document specifies the retry policy for failed webhook deliveries in the Fluxora backend. The policy ensures operator-grade reliability with predictable behavior for webhook consumers and clear failure modes for integrators.

## Service-Level Outcomes

The Fluxora backend guarantees:

1. **Durable delivery attempts** - Failed webhooks are retried with exponential backoff
2. **Predictable retry behavior** - Consumers can rely on consistent retry timing and limits
3. **Deduplication support** - Delivery IDs enable idempotent webhook processing
4. **Observable health** - Operators can monitor delivery status and diagnose failures
5. **Secure delivery** - HMAC-SHA256 signatures prevent tampering and replay attacks

## Retry Policy Configuration

### Default Policy

```typescript
{
  maxAttempts: 5,                    // Maximum delivery attempts
  initialBackoffMs: 1000,            // First retry after 1 second
  backoffMultiplier: 2,              // Exponential backoff multiplier
  maxBackoffMs: 60000,               // Cap backoff at 60 seconds
  jitterPercent: 10,                 // ±10% jitter to prevent thundering herd
  timeoutMs: 30000,                  // 30 second timeout per attempt
  retryableStatusCodes: [408, 429, 500, 502, 503, 504]
}
```

### Backoff Schedule

With the default policy, retry attempts occur at:

- Attempt 1: Immediate
- Attempt 2: ~1 second delay
- Attempt 3: ~2 seconds delay
- Attempt 4: ~4 seconds delay
- Attempt 5: ~8 seconds delay
- Attempt 6: ~16 seconds delay (if configured)

Total maximum delivery window: ~31 seconds

## Trust Boundaries

### Public Internet Clients

**Trusted for:**
- Valid request shape and format
- Possession of webhook secret (if configured)

**Not trusted for:**
- Payload integrity (verified via signature)
- Replay prevention (verified via timestamp)
- Skipping signature checks

### Authenticated Partners / Webhook Consumers

**Trusted for:**
- Possession of shared webhook secret
- Endpoint ownership (HTTPS endpoint)
- Idempotent processing of duplicate deliveries

**Not trusted for:**
- Bypassing signature verification
- Modifying webhook payloads
- Skipping deduplication checks

### Administrators / Operators

**Trusted for:**
- Secret rotation and management
- Incident response and diagnostics
- Delivery monitoring and alerting

**Not trusted for:**
- Reading secrets from logs
- Bypassing audit trails
- Silently dropping verified deliveries

### Internal Workers

**Trusted for:**
- Constructing signed payloads
- Retry scheduling and execution
- Durable delivery state management

**Not trusted for:**
- Mutating verified deliveries
- Dropping failed deliveries without logging
- Bypassing retry policy

## Failure Modes and Expected Behavior

| Condition | Expected Result | HTTP Status | Retry? |
|-----------|-----------------|-------------|--------|
| Network timeout | Log error, schedule retry | N/A | Yes |
| Connection refused | Log error, schedule retry | N/A | Yes |
| 408 Request Timeout | Log error, schedule retry | 408 | Yes |
| 429 Too Many Requests | Log error, schedule retry | 429 | Yes |
| 500 Internal Server Error | Log error, schedule retry | 500 | Yes |
| 502 Bad Gateway | Log error, schedule retry | 502 | Yes |
| 503 Service Unavailable | Log error, schedule retry | 503 | Yes |
| 504 Gateway Timeout | Log error, schedule retry | 504 | Yes |
| 400 Bad Request | Log error, mark permanent failure | 400 | No |
| 401 Unauthorized | Log error, mark permanent failure | 401 | No |
| 403 Forbidden | Log error, mark permanent failure | 403 | No |
| 404 Not Found | Log error, mark permanent failure | 404 | No |
| 200 OK | Mark delivered, log success | 200 | No |
| 201 Created | Mark delivered, log success | 201 | No |
| 204 No Content | Mark delivered, log success | 204 | No |
| Max attempts exceeded | Mark permanent failure, log error | N/A | No |

## Webhook Delivery Lifecycle

### States

1. **pending** - Delivery queued or waiting for retry
2. **delivered** - Successfully delivered (2xx response)
3. **failed** - Delivery failed but may be retried
4. **permanent_failure** - Delivery failed and will not be retried

### State Transitions

```
pending
  ├─→ delivered (on 2xx response)
  ├─→ pending (on retryable error, schedule next retry)
  └─→ permanent_failure (on non-retryable error or max attempts exceeded)
```

## Webhook Delivery Endpoints

### Queue a Webhook Delivery

```
POST /api/webhooks/queue
Content-Type: application/json

{
  "event": {
    "id": "event_123",
    "type": "stream.created",
    "timestamp": 1710000000000,
    "data": { "streamId": "stream_123" }
  },
  "endpointUrl": "https://consumer.example.com/webhook",
  "secret": "webhook_secret_123"
}
```

### Get Delivery Status

```
GET /api/webhooks/deliveries/:deliveryId
```

Response:
```json
{
  "id": "delivery_123",
  "deliveryId": "deliv_123",
  "eventId": "event_123",
  "eventType": "stream.created",
  "status": "pending",
  "attempts": [
    {
      "attemptNumber": 1,
      "timestamp": "2024-03-10T12:00:00Z",
      "statusCode": 503,
      "error": null,
      "nextRetryAt": "2024-03-10T12:00:01Z"
    }
  ],
  "createdAt": "2024-03-10T12:00:00Z",
  "updatedAt": "2024-03-10T12:00:00Z"
}
```

### List All Deliveries

```
GET /api/webhooks/deliveries
```

Response:
```json
{
  "total": 42,
  "deliveries": [
    {
      "id": "delivery_123",
      "deliveryId": "deliv_123",
      "eventId": "event_123",
      "eventType": "stream.created",
      "status": "pending",
      "attemptCount": 1,
      "createdAt": "2024-03-10T12:00:00Z",
      "updatedAt": "2024-03-10T12:00:00Z"
    }
  ]
}
```

### Verify Webhook Signature

```
POST /api/webhooks/verify?secret=webhook_secret_123
Content-Type: application/json
x-fluxora-delivery-id: deliv_123
x-fluxora-timestamp: 1710000000
x-fluxora-signature: <hex-encoded-signature>

{"event": "stream.created", "data": {...}}
```

### Process Pending Retries

```
POST /internal/webhooks/retry?secret=webhook_secret_123
```

This endpoint should be called periodically (e.g., every 10 seconds) by a background job to process pending retries.

## Webhook Headers

All webhook deliveries include these headers:

| Header | Value | Purpose |
|--------|-------|---------|
| `x-fluxora-delivery-id` | UUID | Deduplication and tracking |
| `x-fluxora-timestamp` | Unix seconds | Replay attack prevention |
| `x-fluxora-signature` | HMAC-SHA256 hex | Payload integrity verification |
| `x-fluxora-event` | Event type | Event classification |
| `Content-Type` | application/json | Payload format |

## Signature Verification

Consumers should verify webhook signatures using the canonical algorithm:

```typescript
import { verifyWebhookSignature } from './src/webhooks/signature.js';

const verification = verifyWebhookSignature({
  secret: process.env.FLUXORA_WEBHOOK_SECRET,
  deliveryId: req.header('x-fluxora-delivery-id'),
  timestamp: req.header('x-fluxora-timestamp'),
  signature: req.header('x-fluxora-signature'),
  rawBody: req.rawBody,
  isDuplicateDelivery: (deliveryId) => seenDeliveryIds.has(deliveryId),
});

if (!verification.ok) {
  return res.status(verification.status).json({
    error: verification.code,
    message: verification.message,
  });
}

// Process webhook
```

## Operator Observability and Diagnostics

### Health Checks

- `GET /health` - Service health and indexer status
- `GET /api/webhooks/deliveries` - Webhook delivery queue status

### Monitoring Metrics

Operators should monitor:

1. **Delivery success rate** - Percentage of webhooks delivered successfully
2. **Retry rate** - Percentage of webhooks requiring retries
3. **Permanent failure rate** - Percentage of webhooks that failed permanently
4. **Average delivery time** - Time from event to successful delivery
5. **Queue depth** - Number of pending deliveries

### Diagnostic Checklist

When webhook deliveries are failing:

1. Check `/health` endpoint for service status
2. Query `/api/webhooks/deliveries` to see pending deliveries
3. Inspect logs for delivery attempt details and errors
4. Verify consumer endpoint is accessible and responding
5. Check consumer logs for webhook processing errors
6. Verify webhook secret is correct on both sides
7. Check network connectivity between services
8. Review retry policy configuration

### Logging

All webhook operations are logged with:

- Delivery ID for correlation
- Event ID and type
- Attempt number and status code
- Error messages for failures
- Next retry time for pending deliveries
- Request correlation ID for tracing

## Testing and Verification

### Unit Tests

Run webhook tests:

```bash
npm test -- src/webhooks/
```

Coverage includes:

- Retry backoff calculation
- Status code classification
- Delivery state transitions
- Deduplication logic
- Signature verification

### Integration Tests

Run full integration tests:

```bash
npm test -- tests/webhooks.test.ts
```

Coverage includes:

- End-to-end webhook delivery
- Retry behavior under various failure modes
- Header validation
- Deduplication across attempts

### Manual Testing

Test webhook delivery locally:

```bash
# Start the server
npm run dev

# Queue a webhook delivery
curl -X POST http://localhost:3000/api/webhooks/queue \
  -H "Content-Type: application/json" \
  -d '{
    "event": {
      "id": "event_test",
      "type": "stream.created",
      "timestamp": '$(date +%s)'000,
      "data": {"streamId": "stream_test"}
    },
    "endpointUrl": "https://webhook.site/unique-id",
    "secret": "test_secret"
  }'

# Check delivery status
curl http://localhost:3000/api/webhooks/deliveries
```

## Non-Goals and Follow-Up Work

### Intentionally Deferred

1. **Database persistence** - Currently uses in-memory store; production should use database
2. **Webhook subscriptions** - No consumer endpoint registration yet
3. **Circuit breaker** - No automatic disabling of failing endpoints
4. **Rate limiting per endpoint** - No per-consumer rate limits
5. **Webhook secret rotation** - No automated secret rotation
6. **Dead-letter queue** - No separate handling for permanently failed deliveries

### Recommended Follow-Up Issues

1. Add database-backed webhook delivery store
2. Implement webhook subscription management
3. Add circuit breaker for failing endpoints
4. Implement per-endpoint rate limiting
5. Add webhook secret rotation mechanism
6. Create dead-letter queue for failed deliveries
7. Add webhook delivery metrics and dashboards
8. Implement webhook replay functionality

## References

- [Webhook Signature Verification](src/webhooks/signature.ts)
- [Retry Policy Implementation](src/webhooks/retry.ts)
- [Webhook Service](src/webhooks/service.ts)
- [Webhook Store](src/webhooks/store.ts)
- [Webhook Routes](src/routes/webhooks.ts)
