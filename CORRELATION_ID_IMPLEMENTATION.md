# Correlation ID Implementation — Complete ✓

## Overview

End-to-end correlation ID propagation has been successfully implemented across HTTP middleware, WebSocket hub, and webhook dispatcher. All correlation IDs are:

- Generated as UUID v4 (or reused from request headers)
- Extracted and validated on request entry
- Stored in async-local storage for propagation across async boundaries
- Echoed in response headers
- Attached to WebSocket event metadata
- Included in outgoing webhook request headers

## Implementation Details

### 1. Middleware Layer: [src/middleware/correlationId.ts](src/middleware/correlationId.ts)

**Exports:**
- `CORRELATION_ID_HEADER = 'x-correlation-id'` — canonical header name
- `isValidCorrelationId(value: string): boolean` — UUID v4 regex validation
- `correlationIdMiddleware()` — Express middleware

**Behavior:**
```typescript
// If incoming request has x-correlation-id header with valid UUID v4, reuse it
// Otherwise, generate new UUID v4 via crypto.randomUUID()
// Attach to req.correlationId
// Echo in x-correlation-id response header
// Propagate through correlationStore for async access
```

**Registration:** Registered first in middleware stack ([src/app.ts](src/app.ts#L46))

---

### 2. Async Context Propagation: [src/tracing/middleware.ts](src/tracing/middleware.ts)

**Exports:**
- `correlationStore: AsyncLocalStorage<string>` — Node.js built-in
- `getCorrelationId(): string` — retrieve current context value or 'unknown'

**Pattern:**
```typescript
// In correlationIdMiddleware:
correlationStore.run(correlationId, () => {
  req.correlationId = correlationId;
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  next();  // All downstream callbacks inherit this context
});

// Anywhere in the async call chain:
const cid = getCorrelationId(); // Returns the active value
```

**Isolation:** Each request maintains its own correlation ID via AsyncLocalStorage; concurrent requests never cross-contaminate.

---

### 3. WebSocket Transport: [src/ws/hub.ts](src/ws/hub.ts)

**Connection Lifecycle:**

```typescript
// onConnect: extract correlationId from upgrade request headers
private extractCorrelationId(headers: IncomingHttpHeaders): string | undefined {
  const incoming = headers[CORRELATION_ID_HEADER];
  if (typeof incoming === 'string') {
    const trimmed = incoming.trim();
    if (trimmed.length > 0 && isValidCorrelationId(trimmed)) {
      return trimmed;  // Return client's correlation ID
    }
  }
  return undefined;  // No valid incoming ID
}

// Store in ClientState for the duration of the connection
this.clients.set(ws, {
  id: connectionId,
  correlationId,  // Stored here
  // ...
});

logger.info('WebSocket connected', correlationId, {
  event: 'ws_connect',
  // ...
});
```

**Event Broadcast:**

```typescript
// broadcast() — called when a stream update arrives
async broadcast(event: StreamUpdateEvent): Promise<void> {
  // Get the current request's correlation ID
  const correlationId = getCorrelationId();
  
  // Include it in the outbound stream_update message
  const message = JSON.stringify({
    type: 'stream_update',
    streamId,
    eventId,
    payload,
    correlationId  // <<< Propagated to client
  });
  
  // Send to all subscribed clients
  // ...
}
```

**Client State Tracking:**
```typescript
interface ClientState {
  id: string;
  correlationId?: string;  // From upgrade request
  metrics: ConnectionMetrics;
  subscriptions: Set<string>;
  // ...
}
```

---

### 4. Webhook Dispatcher: [src/webhooks/dispatcher.ts](src/webhooks/dispatcher.ts)

**Dispatch Method:**

```typescript
async dispatch(options: WebhookDispatchOptions): Promise<WebhookDispatchResult> {
  const { url, secret, payload, deliveryId, eventType, attemptNumber = 1, correlationId } = options;
  
  // Use provided correlationId or fetch from async context
  const effectiveCorrelationId = correlationId ?? getCorrelationId();
  
  // Log with correlation ID
  logger.info('Dispatching webhook', 
    effectiveCorrelationId !== 'unknown' ? effectiveCorrelationId : undefined,
    { deliveryId, eventType, attemptNumber, url }
  );
  
  // Send request with correlation header
  const response = await this.sendRequest(
    url, payload, deliveryId, eventType, timestamp, signature,
    effectiveCorrelationId
  );
  // ...
}

private async sendRequest(
  url: string,
  payload: string,
  deliveryId: string,
  eventType: string,
  timestamp: string,
  signature: string,
  correlationId?: string,  // <<< Receives correlation ID
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-fluxora-delivery-id': deliveryId,
    'x-fluxora-timestamp': timestamp,
    'x-fluxora-signature': signature,
    'x-fluxora-event': eventType,
    'User-Agent': 'Fluxora-Webhook-Dispatcher/2.0',
  };
  
  // Attach correlation ID header
  if (correlationId && correlationId !== 'unknown') {
    headers[CORRELATION_ID_HEADER] = correlationId;  // x-correlation-id
  }
  
  return fetch(url, {
    method: 'POST',
    headers,
    body: payload,
    signal: controller.signal,
  });
}
```

---

### 5. Webhook Service: [src/webhooks/service.ts](src/webhooks/service.ts)

**Delivery Attempt:**

```typescript
async attemptDelivery(
  delivery: WebhookDelivery,
  secret: string,
  timestamp?: string,
): Promise<void> {
  // Fetch correlation ID from async context
  const correlationId = getCorrelationId();
  
  logger.info('Attempting webhook delivery',
    correlationId !== 'unknown' ? correlationId : undefined,
    { deliveryId: delivery.deliveryId, attempt: attemptNumber, ... }
  );
  
  // Send webhook with correlation ID
  const response = await this.sendWebhook(
    delivery.endpointUrl,
    delivery.payload,
    delivery.deliveryId,
    ts,
    signature,
    correlationId  // <<< Passed to sendWebhook
  );
  // ...
}

private async sendWebhook(
  url: string,
  payload: string,
  deliveryId: string,
  timestamp: string,
  signature: string,
  correlationId?: string,  // <<< Receives correlation ID
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-fluxora-delivery-id': deliveryId,
    'x-fluxora-timestamp': timestamp,
    'x-fluxora-signature': signature,
    'x-fluxora-event': 'webhook.event',
  };
  
  // Attach correlation ID header
  if (correlationId && correlationId !== 'unknown') {
    headers[CORRELATION_ID_HEADER] = correlationId;  // x-correlation-id
  }
  
  return fetch(url, {
    method: 'POST',
    headers,
    body: payload,
    signal: controller.signal,
  });
}
```

---

## Test Coverage: [tests/correlationId.test.ts](tests/correlationId.test.ts)

### ID Generation & Validation

- ✓ Generates UUID v4 when no header provided
- ✓ Generated IDs match UUID v4 regex pattern
- ✓ Each request gets a unique ID
- ✓ Reuses valid `x-correlation-id` header
- ✓ Trims whitespace from header
- ✓ Generates new ID for empty header
- ✓ Generates new ID for whitespace-only header

### Concurrency Isolation

- ✓ Concurrent requests maintain separate correlation IDs
- ✓ setImmediate callbacks preserve correct context
- ✓ Promise chains inherit parent context
- ✓ No cross-contamination between concurrent tasks

### Cross-Transport Propagation

- ✓ WebSocket events carry initiating request's correlation ID
- ✓ WebSocket connection state stores client's correlation ID
- ✓ Webhook dispatcher includes correlation header
- ✓ Webhook service propagates correlation through retries

---

## HTTP Headers

### Request
```
GET /api/streams HTTP/1.1
x-correlation-id: 550e8400-e29b-41d4-a716-446655440000
```

### Response
```
HTTP/1.1 200 OK
x-correlation-id: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json
```

### WebSocket Upgrade
```
GET /ws/streams HTTP/1.1
Upgrade: websocket
Connection: Upgrade
x-correlation-id: 550e8400-e29b-41d4-a716-446655440000
```

### Outgoing Webhook
```
POST /webhook/endpoint HTTP/1.1
Content-Type: application/json
x-correlation-id: 550e8400-e29b-41d4-a716-446655440000
x-fluxora-delivery-id: deliv_12345
x-fluxora-timestamp: 1700000000
x-fluxora-signature: sha256=...
```

---

## CORS Configuration

[src/middleware/cors.ts](src/middleware/cors.ts) includes `X-Correlation-ID` in allowed headers:

```typescript
const DEFAULT_ALLOWED_HEADERS = 'Content-Type,Authorization,X-Correlation-ID';
```

This allows CORS requests to include the correlation header.

---

## Observability & Logging

All structured logs include `correlationId` field:

```json
{
  "timestamp": "2024-01-15T12:00:00Z",
  "level": "info",
  "message": "Dispatching webhook",
  "correlationId": "550e8400-e29b-41d4-a716-446655440000",
  "deliveryId": "deliv_abc123",
  "eventType": "stream.created"
}
```

Logs can be easily grouped by correlation ID for distributed tracing.

---

## Backward Compatibility

✓ **No breaking changes**

- Correlation ID generation is automatic; clients don't need to provide one
- Existing requests without a correlation ID header will receive a generated one
- Response header is always present (helpful for troubleshooting)
- WebSocket events now include `correlationId` field (additive, not breaking)
- Webhook headers include `x-correlation-id` (additive, not breaking)

---

## Implementation Notes

### UUID v4 Validation

Regex pattern validates RFC 4122 UUID v4:
```typescript
/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
```

- Requires version nibble 1-5 (typically 4 for random UUIDs)
- Requires variant nibble 8, 9, a, or b

### AsyncLocalStorage Pattern

```typescript
// Initialization (in tracing/middleware.ts)
export const correlationStore = new AsyncLocalStorage<string>();

// Propagation (in correlationId middleware)
correlationStore.run(correlationId, () => {
  // All code here + any async callbacks inherit correlationId
  next();
});

// Retrieval (anywhere in async chain)
getCorrelationId(); // Returns the active value or 'unknown'
```

This is the standard Node.js pattern for async context; no additional libraries needed.

### "unknown" Sentinel Value

When `getCorrelationId()` is called outside a request context, it returns the string `'unknown'`. This is checked before including in headers:

```typescript
if (correlationId && correlationId !== 'unknown') {
  headers[CORRELATION_ID_HEADER] = correlationId;
}
```

This prevents sending `x-correlation-id: unknown` headers and allows out-of-band operations to proceed gracefully.

---

## Deployment Checklist

- [x] Middleware registered first in stack
- [x] AsyncLocalStorage properly initialized
- [x] All transport layers (HTTP, WebSocket, Webhooks) include correlation ID
- [x] Tests cover generation, propagation, and concurrency
- [x] Logging includes correlation ID field
- [x] CORS headers allow x-correlation-id
- [x] No breaking changes to existing APIs
- [x] Backward compatible with clients that don't provide header

**Ready for merge and deployment.**
