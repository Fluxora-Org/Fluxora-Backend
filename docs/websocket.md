# WebSocket Streams

Fluxora exposes stream updates on `/ws/streams`. Clients subscribe by sending a
JSON text frame:

```json
{ "type": "subscribe", "streamId": "stream-id" }
```

Broadcast frames use the `stream_update` envelope:

```json
{
  "type": "stream_update",
  "streamId": "stream-id",
  "eventId": "event-id",
  "payload": {},
  "correlationId": "optional-correlation-id"
}
```

## Backpressure Policy

`StreamHub` checks each server-side `ws.bufferedAmount` before sending a
broadcast frame. Backpressure is handled per connection, so a slow subscriber
does not block delivery to healthy subscribers on the same stream.

Default thresholds:

| Setting | Default | Behavior |
| --- | ---: | --- |
| `BACKPRESSURE_DROP_BYTES` | 1 MiB | Drop the next outbound frame for that connection. |
| `BACKPRESSURE_TERMINATE_BYTES` | 4 MiB | Drop the frame and terminate the connection. |

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
