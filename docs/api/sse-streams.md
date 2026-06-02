# Server-Sent Events (SSE) Stream Updates

The SSE endpoint at `GET /api/streams/:id/events` provides a lightweight, Server-Sent Events (SSE) alternative to WebSockets for real-time stream updates. This is designed for HTTP/1.1 clients, serverless handlers, or simple dashboards where full duplex WebSocket connections are unnecessary or blocked by firewalls.

---

## Endpoint Definition

```http
GET /api/streams/:id/events
```

### Response Headers
* `Content-Type: text/event-stream`
* `Cache-Control: no-cache, no-transform`
* `Connection: keep-alive`
* `X-Accel-Buffering: no` (Bypasses proxy buffering)

---

## Authentication

Authentication rules for the SSE endpoint mirror those configured for the WebSocket hub (`StreamHub`), governed by `WS_AUTH_REQUIRED`.

If `WS_AUTH_REQUIRED=true`, a valid JWT token is **required**. If absent or invalid, the endpoint returns `401 Unauthorized`.
If `WS_AUTH_REQUIRED=false` (or unset), a token is **optional**. However, if a token is supplied, it *must* be valid; invalid or expired tokens will still return `401 Unauthorized`.

### Token Delivery Methods

You can provide the JWT token using either of these two methods (first match wins):

1. **Authorization Header**:
   ```bash
   curl -N \
     -H "Authorization: Bearer <token>" \
     http://localhost:3000/api/streams/stream-123/events
   ```

2. **Query String Parameter**:
   ```bash
   curl -N \
     "http://localhost:3000/api/streams/stream-123/events?token=<token>"
   ```

---

## Resumption (Last-Event-ID)

The endpoint supports standard cursor-based resumption when a client disconnects. To resume without missing events, send the `Last-Event-ID` header containing the `eventId` of the last successfully processed event.

```bash
curl -N \
  -H "Last-Event-ID: evt_123" \
  http://localhost:3000/api/streams/stream-123/events
```

### Behavior
When `Last-Event-ID` is provided, the server queries the `ContractEventStore` to replay historical events that occurred after the specified cursor before switching to live broadcast delivery.

---

## Heartbeat and Keep-Alive

To prevent intermediate proxies, firewalls, and load balancers (such as Cloudflare or AWS ALB) from abruptly closing inactive connections, the server sends a periodic comment heartbeat every **30 seconds**.

```text
: heartbeat
```

Clients should ignore lines starting with a colon (`:`) as they are comments in the Server-Sent Events specification.

---

## Example SSE Stream Output

Upon initial connection, the server sends an `: ok` acknowledgement. Then, as stream updates or replayed events occur, standard SSE formatted blocks are flushed:

```text
: ok

id: evt-001
event: stream_update
data: {"type":"stream_update","streamId":"stream-123","eventId":"evt-001","payload":{"status":"active","streamedAmount":"100"},"correlationId":"44526bf5-b33d-45f2-bd1d-9ce414f13635"}

: heartbeat

id: evt-002
event: stream_update
data: {"type":"stream_update","streamId":"stream-123","eventId":"evt-002","payload":{"status":"completed","streamedAmount":"1000"},"correlationId":"63ad759f-ba95-4c6b-a5db-86a491fcded9"}
```
