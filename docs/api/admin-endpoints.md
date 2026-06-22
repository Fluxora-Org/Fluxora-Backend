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

## API key management

### `POST /api/admin/api-keys`

Creates a DB-backed API key record and returns the raw key once:

```json
{
  "id": "ck...",
  "name": "service-a",
  "key": "flx_...",
  "prefix": "flx_1234",
  "createdAt": "2026-06-22T00:00:00.000Z"
}
```

Security behavior:

- The raw key is never stored and is not returned by list responses.
- Stored hashes use a per-key salt plus `API_KEY_PEPPER`.
- Validation uses an indexed peppered `lookup_hash` before constant-time comparison on the candidate row.
- `API_KEY_CREATED`, `API_KEY_ROTATED`, and `API_KEY_REVOKED` are written to `audit_logs`.

### `GET /api/admin/api-keys`

Lists records for operators. Responses include `id`, `name`, `keyHash`, `prefix`, timestamps, and `active`, but never include raw keys, salts, or lookup hashes.
