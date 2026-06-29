# WebSocket Stream Protocol — Developer Guide

**Version:** 1.0 — align with `src/ws/messageHandler.ts` and `src/ws/hub.ts`.

Cross-references:
| Concern | Source |
|---|---|
| Message parsing, validation, filter normalization | `src/ws/messageHandler.ts` |
| Hub lifecycle, broadcast, backpressure, replay | `src/ws/hub.ts` |
| Per-IP connection limiting & ban logic | `src/ws/connectionLimiter.ts` |
| JWT token verification | `src/middleware/tokenAuth.ts` |
| Dedup (Redis / in-memory) | `src/redis/dedup.ts` |
| Event store replay | `src/indexer/store.ts` |

---

## 1. Connection

### 1.1 Endpoint

```
ws://<host>:<port>/ws/streams
```

Only `ws://` (plain) and `wss://` (TLS) are supported. All other paths are ignored by the upgrade handler (`src/ws/hub.ts:283-284`).

### 1.2 Upgrade Handshake

The server uses HTTP upgrade (WebSocket protocol). The upgrade verifies:

1. **Per-IP connection limit** — atomic check-and-reserve (`connectionLimiter.ts:102-129`). If the IP already has `WS_MAX_CONNECTIONS_PER_IP` (default `10`) open sockets the upgrade is rejected with HTTP `429`.
2. **JWT authentication** (optional, see §1.4).
3. **Handshake subscription** — query parameters may pre-subscribe the socket on connect (see §1.3).

> **Note:** If the per-IP connection cap is exceeded the responder sends a plain HTTP `429 Too Many Requests` response **before** the WebSocket upgrade completes. The client will see an HTTP error, not a WebSocket close frame.

### 1.3 Handshake Subscription via Query Parameters

Clients can supply subscription filters directly in the connection URL. The filter is applied immediately after the WebSocket opens, before any `message` event handler fires.

```
ws://localhost:3000/ws/streams?streamId=my-stream
ws://localhost:3000/ws/streams?recipient_address=GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7
```

Accepted query parameters:

| Parameter | Alias | Description |
|---|---|---|
| `stream_id` | `streamId` | Subscribe to a single stream ID |
| `recipient_address` | `recipientAddress` | Subscribe to streams for a Stellar public key |

If neither parameter is supplied the socket connects unfiltered and must use explicit `subscribe` messages later.

The same validation rules and mutual-exclusivity constraint (§2.2) apply to handshake filters.

### 1.4 JWT Authentication (Optional)

Controlled by two environment variables:

| Variable | Default | Effect |
|---|---|---|
| `WS_AUTH_REQUIRED` | `false` | When `true`, reject unauthenticated upgrades with HTTP `401`. |
| `JWT_SECRET` | — | HMAC-SHA256 secret used to verify tokens. |

Token delivery (first match wins):

1. `Authorization: Bearer <token>` HTTP header on the upgrade request.
2. `?token=<jwt>` query-string parameter.

On auth failure the server sends HTTP `401` **before** the WebSocket handshake completes, so the client **never enters the OPEN state**.

When `WS_AUTH_REQUIRED` is `false` (the default) all connections are accepted regardless of token presence. This enables a zero-downtime rollout: deploy with auth disabled, issue tokens to clients, then flip the flag.

When a valid token is present, `sub` (subject) is extracted and used for `recipient_address` subscription authorization (§2.2).

---

## 2. Client-to-Server Messages

All client frames must be **UTF-8 text**. Binary frames are rejected (see §×Error codes).

Messages are JSON objects. Maximum inbound payload: **4,096 bytes** (`MAX_MESSAGE_BYTES`).

Rate limit: **30 messages per 10-second window** per connection (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`).

### 2.1 Subscribe

```json
{
  "type": "subscribe",
  "filter": {
    "stream_id": "my-stream-id"
  }
}
```

```json
{
  "type": "subscribe",
  "recipientAddress": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
}
```

```json
{
  "type": "subscribe",
  "filter": {}
}
```

**Filter field semantics:**

| Field | Aliases | Required | Description |
|---|---|---|---|
| `stream_id` | `streamId` | No\* | Non-empty string, max 256 characters. |
| `recipient_address` | `recipientAddress` | No\* | Valid Stellar Ed25519 public key (StrKey), 56 chars, base32 with CRC16-XModem. Must start with `G`. |

\* At least one of `stream_id`, `recipient_address`, or an explicit `filter: {}` must be present.

**Mutual exclusivity:** `stream_id` and `recipient_address` **cannot** appear together in a single message. If both are present the server returns an error.

**Aliases:** Fields may appear at the top level or inside a `filter` object. All locations are checked for consistency and must not contain conflicting values.

```json
// VALID — stream_id at root level
{ "type": "subscribe", "stream_id": "abc" }

// VALID — stream_id inside filter object
{ "type": "subscribe", "filter": { "streamId": "abc" } }

// VALID — empty filter (authenticated client subscribes to own recipient_address)
{ "type": "subscribe", "filter": {} }

// INVALID — conflicting aliases
{ "type": "subscribe", "stream_id": "a", "filter": { "streamId": "b" } }

// INVALID — both stream_id and recipient_address
{ "type": "subscribe", "stream_id": "a", "recipientAddress": "G..." }
```

**Authorization rules** (`hub.ts:537-581`):

| Filter | Unauthenticated | Authenticated (valid JWT `sub`) |
|---|---|---|
| `streamId` | Allowed | Allowed |
| `recipientAddress` | **Rejected** (UNAUTHORIZED) | Allowed only if it matches JWT `sub` |
| Empty `filter: {}` | **Rejected** (UNAUTHORIZED) | Implicitly subscribes to `recipientAddress` from JWT `sub` |

### 2.2 Unsubscribe

Cancels an active subscription filter. Same format and normalization rules as `subscribe`. The unsubscribe is a no-op if the filter is not currently subscribed.

```json
{
  "type": "unsubscribe",
  "filter": {
    "recipient_address": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
  }
}
```

### 2.3 Replay

Requests historical events from the event store.

```json
{
  "type": "replay",
  "afterEventId": "evt-001",
  "fromLedger": 100,
  "toledger": 200,
  "contractId": "CCONTRACT...",
  "topic": "stream.created",
  "limit": 100
}
```

**Replay filter fields** (`messageHandler.ts:95-103`):

| Field | Type | Required | Description |
|---|---|---|---|
| `afterEventId` | string | No | Exclusive cursor — start after this event |
| `fromLedger` | integer ≥0 | No | Start replay at this ledger number |
| `toledger` | integer ≥0 | No | End replay at this ledger number |
| `contractId` | string (≤256) | No | Filter by Soroban contract ID |
| `topic` | string (≤256) | No | Filter by event topic string |
| `limit` | integer (1–1000) | No | Max events per page (default 100) |

Events are returned as `stream_replay` frames (§3.2), followed by a `stream_replay_complete` frame (§3.3). If `afterEventId` has been evicted from the store the server returns a `STALE_CURSOR` error.

If no event store is configured the server returns a `REPLAY_UNAVAILABLE` error.

---

## 3. Server-to-Client Messages

### 3.1 Stream Update (`stream_update`)

Broadcast to all matching subscribers when a stream transitions state.

```json
{
  "type": "stream_update",
  "streamId": "stream-abc-123",
  "eventId": "evt-001",
  "payload": {
    "amount": "12345678901234567890.000000000000000001",
    "recipientAddress": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
  },
  "correlationId": "req-abc-123"
}
```

Fields:

| Field | Type | Description |
|---|---|---|
| `type` | `"stream_update"` | Discriminant |
| `streamId` | string | Stream identifier |
| `eventId` | string | Unique event identifier (used for dedup) |
| `payload` | object | Stream event payload (decimal strings preserved verbatim) |
| `correlationId` | string | Optional request correlation ID |

**String preservation:** Numeric payload values that exceed `Number.MAX_SAFE_INTEGER` are transmitted as strings, never coerced to JavaScript `Number`. The framework serialises the payload with `JSON.stringify` so decimal strings like `"12345678901234567890.000000000000000001"` are preserved verbatim.

**Deduplication:** The hub deduplicates by `(streamId, eventId)` pair. Repeated `broadcast` calls with the same pair are silently dropped after the first delivery (`hub.ts:654-657`). This covers indexer at-least-once retries.

**Fan-out batching:** When fanning out to >256 subscribers (`FANOUT_YIELD_BATCH`) the hub yields to the event loop every 256 deliveries via `setImmediate`. This prevents blocking the event loop under heavy load (`hub.ts:681-688`).

### 3.2 Replay Event (`stream_replay`)

Sent in response to a `replay` request (one frame per historical event).

```json
{
  "type": "stream_replay",
  "eventId": "evt-001",
  "ledger": 100,
  "topic": "stream.created",
  "payload": {
    "depositAmount": "100.0000000",
    "ratePerSecond": "0.0000001"
  },
  "happenedAt": "2026-01-01T00:00:00.000Z"
}
```

### 3.3 Replay Complete (`stream_replay_complete`)

Sent after all replay frames have been delivered.

```json
{
  "type": "stream_replay_complete",
  "cursor": "last-event-id-or-null"
}
```

### 3.4 Error (`error`)

Sent when a client message fails validation, authorization, or execution.

```json
{
  "type": "error",
  "code": "INVALID_MESSAGE",
  "message": "subscription filter accepts either stream_id or recipient_address, not both"
}
```

**Error codes:**

| Code | HTTP Analog | Description |
|---|---|---|
| `UNKNOWN_TYPE` | 400 | Message type is not `subscribe`, `unsubscribe`, or `replay` |
| `INVALID_MESSAGE` | 400 | Malformed JSON, missing required fields, validation failure |
| `INVALID_JSON` | 400 | Payload is not valid JSON |
| `PAYLOAD_TOO_LARGE` | 413 | Message exceeds 4,096 bytes |
| `BINARY_NOT_SUPPORTED` | 415 | Binary frames are not accepted |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many messages in the current window |
| `UNAUTHORIZED` | 401 | Authentication required for this operation |
| `FORBIDDEN` | 403 | `recipientAddress` does not match authenticated subject |
| `REPLAY_UNAVAILABLE` | 503 | Event store is not configured |
| `STALE_CURSOR` | 410 | Replay cursor has been evicted from the store |

---

## 4. Heartbeat & Ping / Pong

The server **does not** send application-level WebSocket pings or heartbeats. The underlying `ws` library supports RFC 6455 ping/pong frames; clients may implement keep-alive by sending WebSocket pings (opcode `0x9`). The server responds with pongs (opcode `0xA`) automatically.

For proxy / load-balancer environments that drop idle connections, clients should either:
- Send periodic WebSocket pings every 30-60 seconds, **or**
- Send lightweight subscribe messages to the same filter (subject to rate limiting).

> **SSE users:** The HTTP Server-Sent Events endpoint sends `: heartbeat\n\n` comment lines every `SSE_HEARTBEAT_INTERVAL_MS` (configurable via environment). The WebSocket protocol does not use this mechanism.

---

## 5. Backpressure

`StreamHub` checks each connection's `ws.bufferedAmount` before every broadcast frame. Backpressure is handled **per connection**, so a slow subscriber does not block delivery to healthy subscribers on the same stream.

| Setting | Default | Behavior |
|---|---|---|
| `BACKPRESSURE_DROP_BYTES` | 1 MiB | Buffered data exceeds this → drop the outbound frame, increment `droppedMessages` |
| `BACKPRESSURE_TERMINATE_BYTES` | 4 MiB | Buffered data exceeds this → drop the frame, terminate the connection, increment both counters |

When a connection is terminated the hub:
1. Calls `ws.terminate()` (immediate close, no close frame handshake).
2. Runs the normal disconnect cleanup: untrack IP counter, remove subscriptions, log metrics.
3. Emits a `backpressure` event with action `terminate`.

```ts
hub.on('backpressure', (event: StreamHubBackpressureEvent) => {
  // { action, streamId, eventId, connectionId, bufferedAmount, thresholdBytes, timestamp }
});
```

The hub does **not** queue messages for slow clients. Recovery happens via the indexer's at-least-once delivery or by the client reconnecting and using the `replay` API.

---

## 6. Rate Limiting & Connection Limits

### 6.1 Per-Connection Rate Limit

| Parameter | Value |
|---|---|
| Max messages per window | 30 |
| Window duration | 10,000 ms |
| Enforcement | Return error frame with code `RATE_LIMIT_EXCEEDED` |

### 6.2 Per-IP Connection Limit

| Parameter | Default | Env Variable |
|---|---|---|
| Max connections per IP | 10 | `WS_MAX_CONNECTIONS_PER_IP` |
| Abuse threshold | 5 rejections/min | `WS_ABUSE_THRESHOLD` |
| Ban TTL | 3,600 s (1 hour) | `WS_BAN_TTL_S` |

When an IP exceeds the connection limit, it receives HTTP `429` on upgrade. Repeated rejections within a sliding 60-second window trigger an automatic ban (Redis-backed with local in-memory fallback).

---

## 7. Close Codes

| Code | Constant | Description |
|---|---|---|
| `1000` | `WS_CLOSE_NORMAL` | Normal closure (client-initiated or server cleanup) |
| `1011` | `WS_CLOSE_INTERNAL_ERROR` | Internal server error; sent when a `ws.on('error')` fires |
| `4000` | — | Admin-forced disconnect (`disconnectByStreamId`) |

---

## 8. Security Notes

- Only JSON text frames are accepted; binary frames return an error and are discarded.
- Inbound messages are capped at 4,096 bytes.
- Messages are rate-limited per connection (30 / 10 s).
- Per-IP connection limit (default 10) with automatic ban for abusive IPs.
- Optional JWT authentication on upgrade (`WS_AUTH_REQUIRED`).
- `recipient_address` subscriptions are scoped to the JWT subject — a client can only subscribe to its own address.
- Backpressure metadata (`backpressure` event, `ws_backpressure` log) excludes payload bodies, JWTs, API keys, and request headers.
- Connection counter is atomic and TOCTOU-safe (see `connectionLimiter.ts:53-101` for the thread-safety model).
- Per-IP slot reservation is released exactly once via a `cleaned` flag pattern in the upgrade handler.
