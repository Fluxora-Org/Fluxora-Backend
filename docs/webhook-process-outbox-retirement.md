# Retired management-outbox processor

`POST /internal/webhooks/process-outbox` now returns HTTP **410 Gone** after
normal admin authentication. Remove scheduled calls to this endpoint. The error
uses the standard API envelope with code `OUTBOX_PROCESSING_ERROR`.

The previous implementation logged queued items and deleted them without any
delivery attempt. The retired endpoint leaves all queue entries and attempt
counts unchanged; it does not claim, send, retry, acknowledge, or delete items,
and does not return misleading processing counts.

The existing `WebhookDispatcher` processes the separate transactional
`webhook_outbox` table for stream events. It is not a replacement processor for
the management queue exposed by `/internal/webhooks/outbox`. Existing management
queue items remain available for inspection; this change does not migrate them
or introduce a new dispatcher. A supported processor for that queue requires a
separate integration. Do not delete preserved entries as a substitute for delivery.

This takes the endpoint-removal option allowed by issue #1942 and leaves the
transactional dispatcher unchanged.
