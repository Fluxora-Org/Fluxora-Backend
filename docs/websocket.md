# WebSocket Streams

<!--
  NatSpec / doc-comment style: this file documents both the public WebSocket
  protocol and internal resilience mechanisms, with explicit security and
  testing notes for each component.
-->

Fluxora exposes real-time treasury stream updates on `/ws/streams` using standard WebSockets.

## Connection Handshake

During the initial upgrade handshake, clients can optionally filter stream updates by specifying query parameters in the connection URL:

- `stream_id` (or `streamId`): Filter broadcasts to a single stream ID.
- `recipient_address` (or `recipientAddress`): Filter broadcasts to streams destined for the specified Stellar public key.

Example handshake URL:
`ws://localhost:3000/ws/streams?recipient_address=GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7`

_Note:_ If neither parameter is supplied during connection handshake, the socket accepts all broadcasts unless filtered later via control messages.

---

## Client Protocol Control Messages

Once the WebSocket connection is open, the client can send JSON control frames. The supported control messages are `subscribe`, `unsubscribe`, and `replay`.

### 1. Subscribe Message

Subscribes to stream updates. The filter parameters can be specified either at the root level of the message envelope or nested inside a `filter` object.

```json
{
  "type": "subscribe",
  "filter": {
    "stream_id": "placeholder-stream-id"
  }
}
```

#### Supported Filter Fields

- **`stream_id` / `streamId`**: The stream identifier to follow. Must be a non-empty string up to 256 characters.
- **`recipient_address` / `recipientAddress`**: Stellar public key (StrKey representation). Must start with `G` (Ed25519 version byte), be exactly 56 characters in length, and contain a valid CRC16-XModem checksum.

#### Invalid & Rejected Cases

Subscription attempts are validated and will be rejected with an `error` frame in the following cases:

- **Mutual Exclusivity**: Specifying both `stream_id` (or its alias) and `recipient_address` (or its alias) in a single filter. A client can only filter by stream ID _or_ recipient address, not both.
- **Invalid Stellar Key Checksum**: Providing a `recipient_address` that fails StrKey decoding or contains an invalid checksum.
- **Missing Required Fields**: Sending a `subscribe` message without `stream_id`, `recipient_address`, or an explicit empty filter (`{}`).

### 2. Unsubscribe Message

Cancels an active subscription filter. Same format and normalization rules as `subscribe`.

```json
{
  "type": "unsubscribe",
  "filter": {
    "recipient_address": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
  }
}
```

### 2.1. Rapid Subscribe/Unsubscribe Flapping

Clients may send multiple `subscribe` and `unsubscribe` frames in quick succession for the same or different filters. The hub is designed to converge on the last successfully processed filter state for that socket and remove any stale internal subscription state.

- The same stream ID may be repeatedly subscribed and unsubscribed within the same event loop tick.
- The last processed control message determines the active subscription state.
- The per-connection message rate limiter still applies, so pathological flapping can be throttled without corrupting subscriptions.

### 3. Replay Message

Requests a replay of historical events from the stream event store.

```json
{
  "type": "replay",
  "afterEventId": "event-123",
  "limit": 100
}
```

Supported fields:

- `afterEventId`: Exclusive cursor to start replay from.
- `fromLedger`: Start replay from a specific ledger number.
- `toledger`: End replay at a specific ledger number.
- `contractId`: Filter replayed events by contract ID.
- `topic`: Filter replayed events by event topic.
- `limit`: Maximum number of events to replay (max 1000).

---

## Server Protocol Messages

The server broadcasts message envelopes in JSON format over the open socket connection.

### 1. Stream Update Broadcast (`stream_update`)

Broadcast when a tracked stream transitions state or performs updates:

```json
{
  "type": "stream_update",
  "streamId": "stream-id",
  "eventId": "event-id",
  "payload": {},
  "correlationId": "optional-correlation-id"
}
```

### 2. Replay Complete (`stream_replay_complete`)

Emitted when all historical events matched by a `replay` request have been delivered:

```json
{
  "type": "stream_replay_complete",
  "cursor": "last-delivered-event-id-or-null"
}
```

### 3. Error Envelope (`error`)

Emitted when validation of a client control frame fails or execution encounters an issue:

```json
{
  "type": "error",
  "code": "INVALID_MESSAGE",
  "message": "subscription filter accepts either stream_id or recipient_address, not both"
}
```

## Backpressure Policy

`StreamHub` checks each server-side `ws.bufferedAmount` before sending a
broadcast frame. Backpressure is handled per connection, so a slow subscriber
does not block delivery to healthy subscribers on the same stream.

Default thresholds:

| Setting                        | Default | Behavior                                          |
| ------------------------------ | ------: | ------------------------------------------------- |
| `BACKPRESSURE_DROP_BYTES`      |   1 MiB | Drop the next outbound frame for that connection. |
| `BACKPRESSURE_TERMINATE_BYTES` |   4 MiB | Drop the frame and terminate the connection.      |

When `bufferedAmount > BACKPRESSURE_DROP_BYTES`, the hub drops that frame for
the slow connection and increments `droppedMessages`. When
`bufferedAmount > BACKPRESSURE_TERMINATE_BYTES`, the hub terminates that
connection, increments both `droppedMessages` and `terminatedConnections`, and
removes the connection from subscriptions.

The hub does not queue unbounded per-client messages. Recovery is handled by
future broadcasts after the client's socket drains, or by reconnecting and using
the replay API backed by the event store.

Tests can lower thresholds with:

```ts
hub.setBackpressureThresholds({ dropBytes: 8, terminateBytes: 64 });
```

Production code should keep `terminateBytes` greater than `dropBytes`.

## Observability

On each drop or termination, `StreamHub` emits a `backpressure` event:

```ts
hub.on('backpressure', (event) => {
  // action: 'drop' | 'terminate'
  // streamId, eventId, connectionId, bufferedAmount, thresholdBytes, timestamp
});
```

It also writes a structured `ws_backpressure` warning log with the same metadata.
The event and log intentionally exclude payload bodies, JWTs, API keys, and raw
request headers.

## Network Partition Resilience

Fluxora's `StreamHub` is designed to tolerate network-partitioned clients —
clients whose TCP connection accepts writes into the kernel send buffer but
never reads or acknowledges data. In production, this occurs when a client's
network drops inbound packets while keeping the TCP socket half-open (e.g.
unplugged Wi-Fi, firewall silences inbound traffic, client process hangs).

### Detection via `bufferedAmount`

The hub checks `ws.bufferedAmount` before every outbound frame. When the
remote peer stops reading, the kernel buffer fills and `bufferedAmount` grows.
The hub acts at two thresholds:

| Threshold                        | Action                                              |
| -------------------------------- | --------------------------------------------------- |
| `BACKPRESSURE_DROP_BYTES` (1 MiB) | Drop the frame for that client.                    |
| `BACKPRESSURE_TERMINATE_BYTES` (4 MiB) | Drop the frame, terminate the connection, clean up subscriptions. |

Both thresholds are configurable per-hub instance via
`StreamHubOptions.dropBytes` / `StreamHubOptions.terminateBytes` or at
runtime with `hub.setBackpressureThresholds({ dropBytes, terminateBytes })`.

### Per-connection isolation

Backpressure is applied independently per connection. A partitioned client
never blocks delivery to healthy subscribers on the same stream. The hub
iterates subscribers in a tight loop and skips or terminates slow sockets
without `await` — no slow client can stall the broadcast.

### Events and observability

Each drop or termination emits a `backpressure` event:

```ts
hub.on('backpressure', (event) => {
  // { action: 'drop' | 'terminate', streamId, eventId,
  //   connectionId, bufferedAmount, thresholdBytes, timestamp }
});
```

A structured `ws_backpressure` warning log is written with the same metadata.
Neither the event nor the log includes payload bodies, JWTs, or user
identifiers.

### Testing with simulated network partitions

The test fixture in `tests/ws/fixtures/slowClient.ts` provides
`simulatePartition()` which emulates a full TCP receive-window stall:

1. Sets a `partitioned` flag on the raw socket's `write` override.
2. Each `ws.send()` call from that point forward increments an internal
   `bufferedAmount` counter instead of writing to the real socket.
3. The overridden write returns `true` (data accepted into the simulated OS
   buffer) but never fires drain callbacks — the remote peer never acks.
4. The hub sees `bufferedAmount` grow naturally with each broadcast and
   applies the same drop/terminate thresholds as in production.

See `tests/ws/ws.networkPartition.test.ts` for comprehensive tests covering:

- `bufferedAmount` accumulation per broadcast
- Drop-threshold crossing with backpressure event emission
- Terminate-threshold crossing with connection cleanup
- Bounded delivery latency to healthy peers during partition
- Multiple partitioned clients handled independently
- Subscription state cleanup after partition-triggered termination

Example usage in a test:

```ts
const slow = await createSlowClient(port, hub);
slow.subscribe('my-stream');
slow.simulatePartition();

// Each broadcast increases bufferedAmount naturally
await hub.broadcast({ streamId: 'my-stream', eventId: 'e1', payload: {} });
expect(slow.getBufferedAmount()).toBeGreaterThan(0);

// Eventually thresholds are crossed
await hub.broadcast({ streamId: 'my-stream', eventId: 'e2', payload: {} });
// → backpressure event emitted, client may be terminated
```

### Security notes (partition handling)

- No per-client unbounded queuing: the hub never queues messages for slow
  clients beyond a single broadcast cycle.
- Terminated connections have their subscriptions fully cleaned up:
  `streamSubscriptions`, `recipientSubscriptions`, and per-client batch
  accumulators are all purged.
- The `backpressure` event intentionally excludes payloads, JWTs, and PII.
- All termination is unidirectional (server originates close) — a partitioned
  client cannot force the hub to hold state.

## Security Notes

- Only JSON text frames are accepted; binary frames are rejected.
- Inbound client messages are capped by `MAX_MESSAGE_BYTES`.
- Inbound client messages are rate-limited per connection.
- Optional WebSocket JWT authentication can reject unauthenticated upgrades.
- Backpressure metadata must not include sensitive stream payload contents.

---

## Graceful Shutdown

When the server receives SIGTERM or SIGINT it performs an ordered shutdown that
notifies every connected WebSocket client **before** closing the HTTP server,
giving clients enough information to distinguish a planned deploy from an
abnormal termination.

### Client close frame

```
Code:   1001 (RFC 6455 "Going Away")
Reason: {"reason":"server_shutdown"}   ← JSON-encoded, ≤ 125 bytes
```

The `reason` field is one of the documented `WS_CLOSE_REASONS` constants
exported from `src/ws/hub.ts`:

| Reason string      | Meaning                                                  |
|--------------------|----------------------------------------------------------|
| `server_shutdown`  | Planned deploy / SIGTERM — back off before reconnecting. |
| `max_duration`     | Connection hit its max-duration limit — reconnect now.   |

### Recommended client behaviour

```js
ws.onclose = (event) => {
  try {
    const { reason } = JSON.parse(event.reason);
    if (reason === 'server_shutdown') {
      // Planned shutdown — wait for the service to come back, then reconnect.
      scheduleReconnectWithExponentialBackoff();
    } else {
      // Other close reason (e.g. max_duration) — reconnect immediately.
      reconnect();
    }
  } catch {
    // Malformed or empty reason — treat as abnormal, apply backoff.
    scheduleReconnectWithExponentialBackoff();
  }
};
```

### Timeout budget

Each client is given `closeFrameTimeoutMs` (default **5 000 ms**) to
acknowledge the close frame.  Clients that do not reply within the deadline are
force-terminated via `ws.terminate()` so the shutdown never blocks indefinitely
on a single stalled connection.

Configure a tighter deadline if your process shutdown budget is constrained:

```ts
const hub = new StreamHub(server, { closeFrameTimeoutMs: 1_000 });
```

### Shutdown hook wiring

`StreamHub.gracefulClose()` is registered as a `DrainableService` via
`addDrainableShutdownHook` in `src/websockets/streamChannel.ts`.  It runs in
the correct order relative to HTTP and database draining:

```
SIGTERM received
  → HTTP server stops accepting new TCP connections
  → StreamHub.gracefulClose() — notifies WS clients, waits for ACK
  → HTTP server drains in-flight requests
  → DB pool closes
  → process exits
```

### Security notes

- The close-frame reason payload contains **only** the opaque enum string
  `"server_shutdown"`.  No stream data, user identifiers, internal diagnostics,
  connection IDs, or secrets are included.
- The payload is bounded to ≤ 125 bytes (RFC 6455 §5.5 close-frame limit).
- Per-client timeouts prevent a malicious or stalled client from holding the
  shutdown sequence hostage.

---

## Micro-Batching (opt-in)

When a stream emits many events in a short window (e.g. rapid `stream.updated`
ticks), sending one WebSocket frame per event is wasteful.  The hub supports an
opt-in micro-batching mode that coalesces events for the same `streamId` within
a configurable flush window into a single `stream_update_batch` frame.

### Opting in

Set `batching: true` in the subscription message for the stream you want
batched.  Clients that omit the flag (or set `batching: false`) continue to
receive the existing one-frame-per-event behaviour — no client-side changes are
needed unless you want the optimisation.

```json
{
  "type": "subscribe",
  "streamId": "my-high-throughput-stream",
  "batching": true
}
```

The flag is also accepted inside a nested `filter` object:

```json
{
  "type": "subscribe",
  "filter": {
    "stream_id": "my-high-throughput-stream",
    "batching": true
  }
}
```

### Batch frame schema

```json
{
  "type": "stream_update_batch",
  "streamId": "my-high-throughput-stream",
  "events": [
    { "eventId": "e1", "payload": {}, "correlationId": "…" },
    { "eventId": "e2", "payload": {} }
  ]
}
```

- `events` is always in insertion order (in-order delivery guarantee).
- `correlationId` is omitted from an entry when not present on the source event.
- Each frame is bounded by `MAX_MESSAGE_BYTES` (4 096 bytes). If the full batch
  would exceed that limit, the largest safe prefix (by event count) is sent.

### Configuration

| Env var             | Default | Min | Max   | Description                                           |
|---------------------|--------:|----:|------:|-------------------------------------------------------|
| `WS_BATCH_FLUSH_MS` |    50   |   5 | 5 000 | Flush-window duration in milliseconds.                |
| `WS_BATCH_MAX_SIZE` |    25   |   1 |   500 | Max events per batch before triggering an early flush.|

Both values are clamped to their respective bounds at startup; out-of-range
values fall back to the clamped boundary rather than crashing.

### Flush triggers

A batch for a given `(client, streamId)` is flushed when **either**:

1. **Timer expiry** — `WS_BATCH_FLUSH_MS` milliseconds have elapsed since the
   first event entered the accumulator.
2. **Size cap** — the accumulator has reached `WS_BATCH_MAX_SIZE` events
   (early flush).  The `fluxora_ws_batch_size_exceeded_total` counter
   increments each time this path fires; frequent early ejections suggest
   raising `WS_BATCH_MAX_SIZE` or lowering `WS_BATCH_FLUSH_MS`.

### Dedup semantics

Deduplication is applied at the `broadcast()` level — before an event enters
any accumulator.  A duplicate `(streamId, eventId)` broadcast is dropped by
the dedup cache and never reaches the batch layer.

### Backpressure

The same `BACKPRESSURE_DROP_BYTES` / `BACKPRESSURE_TERMINATE_BYTES` thresholds
apply to `stream_update_batch` frames.  A slow client that exceeds the drop
threshold will have the entire batch frame dropped for that flush cycle.

### Observability

Three new Prometheus counters are emitted:

| Metric                                     | Description                                          |
|--------------------------------------------|------------------------------------------------------|
| `fluxora_ws_batch_flush_total`             | Total flush operations (one frame emitted per flush).|
| `fluxora_ws_batch_events_coalesced_total`  | Total individual events coalesced across all flushes.|
| `fluxora_ws_batch_size_exceeded_total`     | Flushes triggered early by hitting `WS_BATCH_MAX_SIZE`.|

Average batch fill ratio (PromQL):

```promql
rate(fluxora_ws_batch_events_coalesced_total[5m])
  / rate(fluxora_ws_batch_flush_total[5m])
```

### Security notes

- No client-supplied data flows into the accumulator unvalidated; only events
  that have already passed `broadcast()` dedup and subscription-filter checks
  are enqueued.
- The accumulator key is `${server-generated-connectionId}:${streamId}`.
  Neither field is client-controlled in a way that allows key collision.
- Pending timers are cancelled immediately on client disconnect and on
  `hub.close()` — no frames are ever sent to a closed socket.
- Each outbound frame is checked against `MAX_MESSAGE_BYTES` before delivery.
  Oversized frames are truncated to the largest event prefix that fits, rather
  than silently dropped.

### Broadcast Resilience

`StreamHub.broadcast()` fans out to all matching subscribers in a tight loop.
The hub tolerates client disconnects (abrupt `terminate()` or clean `close()`)
that occur **during** the fan-out iteration:

- Disconnected clients are silently skipped via the `readyState` check before
  each `ws.send()` call, and the loop continues to the next subscriber without
  interruption.
- The `broadcast()` promise always resolves cleanly — no exception escapes.
- `BackpressureMetrics` counters (`sentMessages`, `droppedMessages`,
  `terminatedConnections`) remain consistent: no double-count or under-count
  for the disconnected client.
- Pending batch-accumulator timers for the disconnected client are cancelled
  by `onDisconnect`, preventing stale frame delivery.

## Broadcast Authorization & Audit

All WebSocket broadcasts originate from the blockchain indexer service, not from HTTP API endpoints. This section documents the broadcast trigger surface and authorization model.

### Trigger Surface

Broadcasts are triggered exclusively by `src/services/streamEventService.ts` when processing blockchain events:

| Event Type | Function | Broadcast Payload |
|------------|----------|-------------------|
| `stream.created` | `processStreamCreated()` | Full stream details (id, parties, amounts, contract metadata) |
| `stream.updated` | `processStreamUpdated()` | Updated fields (status, amounts, timestamps) |
| `stream.cancelled` | `processStreamCancelled()` | Stream ID and cancellation status |

### Authorization Model

**No admin authentication is required** for broadcasts because:

1. **Indexer-only origin**: Broadcasts are triggered by the blockchain indexer service ingesting on-chain events, not by HTTP API requests
2. **No user-controlled path**: There is no HTTP endpoint that allows external users to trigger broadcasts directly
3. **Chain of trust**: The indexer processes verified blockchain events from the Stellar network, establishing trust at the chain level

The broadcast path:
```
Blockchain Event → Indexer Service → StreamEventService.process*() → Hub.broadcast() → WebSocket clients
```

### Audit Logging

Every broadcast is logged via `recordAuditEvent()` with:

- **Action**: `STREAM_BROADCAST`
- **Resource**: `stream`
- **Resource ID**: Stream ID
- **Metadata**: Event type (`stream.created`, `stream.updated`, `stream.cancelled`) and event ID

This provides a complete audit trail of all broadcasts for compliance and debugging purposes.

### Security Properties

- **No spoofing risk**: Broadcasts cannot be triggered by external HTTP requests
- **Idempotency**: The indexer deduplicates events before broadcasting
- **Recipient filtering**: Broadcasts include `recipientAddress` for client-side filtering
- **Payload validation**: All broadcast payloads are validated before transmission

### Testing

The broadcast authorization model is tested in:
- `tests/integration/broadcast-auth.test.ts` — Verifies no HTTP endpoint can trigger broadcasts
- `tests/services/streamEventService.test.ts` — Validates audit logging for all event types
