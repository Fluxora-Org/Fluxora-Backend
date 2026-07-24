# WebSocket Streams

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

## Security Notes

- Only JSON text frames are accepted; binary frames are rejected.
- Inbound client messages are capped by `MAX_MESSAGE_BYTES`.
- Inbound client messages are rate-limited per connection.
- Optional WebSocket JWT authentication can reject unauthenticated upgrades.
- Backpressure metadata must not include sensitive stream payload contents.

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
