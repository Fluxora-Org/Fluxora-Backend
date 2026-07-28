# Implementation

- Added `src/ws/messageHandler.ts` with Zod validation for WebSocket `subscribe`, `unsubscribe`, and `replay` messages.
- Added `SubscriptionFilter` support for `stream_id` and `recipient_address`, while preserving existing `streamId` compatibility.
- Updated `src/ws/hub.ts` to keep per-client subscription filters and indexed lookup maps for streams and recipients.
- Updated `StreamHub.broadcast()` to deliver only to clients whose active stream or recipient filters match the outgoing event.
- Preserved existing deduplication, inbound rate limiting, replay handling, metrics, tracing, and backpressure behavior.
- Added authenticated empty-filter support: `{ "type": "subscribe", "filter": {} }` resolves to the JWT `sub`.
- Added recipient authorization: `recipient_address` subscriptions require an authenticated WebSocket subject and must match it.
- Added handshake subscription support with `?stream_id=` or `?recipient_address=`.
- Added tests in `tests/ws/hub.subscriptionFiltering.test.ts`.
- Added protocol documentation in `docs/websocket.md`.

## Complexity

- Subscribe/unsubscribe: O(1) average time and O(1) additional index entries per filter.
- Broadcast lookup: O(S + R), where S is the number of clients subscribed to the event stream and R is the number subscribed to the event recipient.
- No full scan of all connected clients is required during broadcast.

## Security Notes

- `stream_id` subscriptions are opaque filter subscriptions and do not reveal stream existence.
- `recipient_address` subscriptions require a verified WebSocket JWT subject.
- Empty filters are allowed only for authenticated clients and resolve to the JWT `sub`.
- A recipient event can match `recipientAddress`, `payload.recipient_address`, `payload.recipientAddress`, or `payload.recipient`.

## Verification

- `pnpm exec tsc --noEmit`: passed.
- `pnpm exec vitest run tests/ws/hub.subscriptionFiltering.test.ts tests/ws.test.ts`: passed, 2 files and 51 tests.
- `pnpm test`: ran full suite; 62 files passed, 2 skipped, 1 pre-existing streams pagination test failed in `tests/streams.test.ts` expecting 2 rows and receiving 1. Isolated rerun of `tests/streams.test.ts` reproduced the same failure.
