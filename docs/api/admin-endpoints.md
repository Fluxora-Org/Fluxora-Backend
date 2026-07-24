# Admin API Endpoints

All endpoints under `/api/admin` require an `Authorization: Bearer <ADMIN_API_KEY>` header unless noted otherwise. Requests without valid admin credentials are rejected by `requireAdminAuth`.

## WebSocket disconnect

### `POST /api/admin/ws/disconnect`

Forcibly closes every WebSocket subscription currently attached to the given `stream_id`.

Request body:

```json
{
  "stream_id": "stream-123"
}
```

Behavior:

- Every active socket subscribed to the stream is closed with code `4000`.
- The close reason is `admin-forced-disconnect`.
- An audit row is written to `audit_logs` with the action `ADMIN_WS_DISCONNECT`.
- If the stream has no active subscribers, the endpoint still succeeds and returns `disconnectedCount: 0`.

Response:

```json
{
  "message": "WebSocket subscribers disconnected.",
  "stream_id": "stream-123",
  "disconnectedCount": 2
}
```

Security notes:

- The endpoint is admin-only and fails closed when `ADMIN_API_KEY` is unset.
- Input is validated server-side; non-string or empty `stream_id` values return `400`.
- Audit persistence is attempted after the disconnect so operators get a durable record of the action.

## Bulk Operations

### `POST /api/admin/streams/bulk-actions`

Accepts a batch of operations to apply to streams atomically. Supports pausing, cancelling, and triggering stream reindexing.
Partial failures are reported per-item in the response without failing the whole batch. Max batch size is 500.

Request body:

```json
{
  "batch": [
    { "streamId": "stream-123", "action": "pause" },
    { "streamId": "stream-456", "action": "cancel" },
    { "streamId": "stream-789", "action": "reindex" }
  ]
}
```

Response:

```json
{
  "results": [
    { "streamId": "stream-123", "action": "pause", "status": "success" },
    { "streamId": "stream-456", "action": "cancel", "status": "failed", "error": "Stream not found" },
    { "streamId": "stream-789", "action": "reindex", "status": "success" }
  ],
  "successCount": 2,
  "failureCount": 1
}
```

## Related admin endpoints

- `GET /api/admin/status`
- `GET /api/admin/pause`
- `PUT /api/admin/pause`
- `GET /api/admin/reindex`
- `POST /api/admin/reindex`
- `GET /api/admin/api-keys`
- `POST /api/admin/api-keys`
- `POST /api/admin/api-keys/:id/rotate`
- `DELETE /api/admin/api-keys/:id`
