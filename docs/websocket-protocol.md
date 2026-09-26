# Fluxora WebSocket protocol

The backend WebSocket endpoint streams live stream updates and can replay
historical events. Clients should treat every frame as JSON and reconnect with
exponential backoff after a network failure or a server close.

## Connection and messages

Clients connect to the WebSocket endpoint exposed by the deployment and may
send these control messages:

```json
{"type":"subscribe","stream_id":"stream-123"}
{"type":"subscribe","recipient_address":"G..."}
{"type":"subscribe","filter":{},"batching":true}
{"type":"unsubscribe","stream_id":"stream-123"}
{"type":"replay","afterEventId":"event-100","limit":100}
```

`stream_id` and `recipient_address` are mutually exclusive. The aliases
`streamId` and `recipientAddress` are accepted for compatibility. A replay
filter may also include `fromLedger`, `toledger`, `contractId`, and `topic`;
`limit` is bounded by 1000.

An empty subscription filter subscribes to all authorized stream updates.
`batching: true` opts into `stream_update_batch` frames; without it, updates
are delivered one event per frame.

## Server frames

- `stream_update` — one live stream event.
- `stream_update_batch` — a batch of live events for batching subscribers.
- `stream_replay` — one historical event returned by a replay request.
- `stream_replay_complete` — replay finished; `cursor` is the resume cursor
  for a subsequent request.
- `error` — a rejected message or request, with `code` and `message` fields.

Clients should persist the last event identifier and use `afterEventId` when
reconnecting. Replay is ledger-ordered, and clients must deduplicate events by
identifier because a reconnect can overlap the last successfully received
frame.

## Errors and reconnects

Malformed JSON, unknown message types, invalid filters, and oversized messages
produce an `error` frame and do not create a subscription. The server may
close a connection with code 1001 and a JSON reason of `server_shutdown` or
`max_duration`. Stop reconnecting during `server_shutdown`; reconnect with
backoff for `max_duration` and transient network failures.

The protocol is intentionally additive: clients must ignore unknown response
fields and preserve their last valid cursor when a replay fails.
