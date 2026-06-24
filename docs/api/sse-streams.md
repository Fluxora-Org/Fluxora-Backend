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

If the event store returns `STALE_CURSOR`, the supplied cursor has been evicted,
usually because a reorg rollback removed it. The server emits an SSE `error`
event with code `STALE_CURSOR` and closes the response; clients should discard
that cursor and re-sync from the last trusted `fromLedger` checkpoint.

---

## Connection Limits and Maximum Duration

SSE streams are intentionally bounded because each active connection holds an HTTP socket, heartbeat timer, max-duration timer, and live-subscription registry entry. Live fan-out uses one shared `sseEventBus` dispatcher listener for the process rather than one EventEmitter listener per connection, so EventEmitter listener count remains constant while per-event delivery scales with the number of subscribers to the updated stream.

Authentication is evaluated first; unauthenticated or invalid-token requests return `401` and do not consume SSE capacity. After authentication, the server enforces both per-IP and global concurrent connection limits before it performs stream lookup work or flushes `text/event-stream` headers. Limits are process-local; deployments running multiple Node.js processes should pair these controls with load-balancer or ingress-level connection budgets.

| Environment variable | Default | Description |
| --- | ---: | --- |
| `SSE_MAX_CONNECTIONS_PER_IP` | `10` | Maximum active SSE connections accepted from a single client IP. |
| `SSE_MAX_GLOBAL_CONNECTIONS` | `1000` | Maximum active SSE connections accepted process-wide. |
| `SSE_MAX_CONNECTION_DURATION_MS` | `1800000` | Maximum lifetime of one SSE response before the server closes it. Defaults to 30 minutes. Valid range: 1 ms to 24 hours. |
| `SSE_RETRY_AFTER_SECONDS` | `15` | Value sent in the `Retry-After` header when the endpoint rejects a connection with `429`. Valid range: 1 second to 24 hours. |

Client IP extraction reuses the WebSocket limiter helper. `X-Forwarded-For` is trusted only when the immediate peer is listed in `WS_TRUSTED_PROXIES`.

When a connection would exceed either cap, the endpoint returns a normal JSON error envelope and does not open an SSE stream:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 15
Content-Type: application/json
```

```json
{
  "success": false,
  "error": {
    "code": "TOO_MANY_REQUESTS",
    "message": "Too many active SSE connections",
    "details": {
      "reason": "global_limit",
      "maxConnectionsPerIp": 10,
      "maxGlobalConnections": 1000,
      "retryAfterSeconds": 15
    }
  }
}
```

When `SSE_MAX_CONNECTION_DURATION_MS` is reached, the server writes a final `event: close` frame with `{"reason":"max_duration"}` and then ends the response. Browser `EventSource` clients should reconnect according to their normal retry policy.

### Metrics

The endpoint exports these Prometheus metrics through the existing registry:

* `fluxora_sse_active_connections` — gauge of active SSE responses in the current process.
* `fluxora_sse_connections_rejected_total{reason="per_ip_limit|global_limit"}` — counter of rejected SSE connection attempts.

### Live fan-out efficiency

Live updates are indexed by `streamId` in memory. A broadcast for `stream-123` is delivered only to active SSE clients subscribed to `stream-123`; other SSE connections do not run per-event filter checks.

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
