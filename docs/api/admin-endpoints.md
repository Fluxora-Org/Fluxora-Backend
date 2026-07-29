# Admin API Endpoints

## Authorization and guard contract

`GET /api/admin/status/read-only` is registered before the router's authorization
guard and is public. It returns only the current pause flags. The route remains
available when admin authentication is unconfigured, and an invalid
`Authorization` header is ignored on this route.

Every other request that reaches the `/api/admin` router passes through
`requireAdminAuth` before route matching, handler validation, database access,
state mutation, or handler audit events. This includes requests for unknown
paths and non-GET methods sent to `/status/read-only`. Consequently, an unknown
admin path returns an auth failure to an unauthenticated caller and reaches the
normal `404` response only after successful authentication.

Global middleware runs before the admin router. Content negotiation, JSON
parsing, body-size limits, rate limiting, and similar global checks can
therefore reject a request before the admin guard.

### Accepted credentials

Admin auth is enabled only when `ADMIN_API_KEY` is non-empty. Once it is
configured, either of these credentials is accepted:

- The exact `ADMIN_API_KEY` value. Comparison is length-checked and
  timing-safe; a match establishes `req.user` as `{ role: "admin" }`.
- A valid application JWT whose `role` is exactly `admin` or
  `data-protection-officer`. The verified JWT payload becomes `req.user`.

The router does not call the granular `requirePermission` middleware. JWT
authorization is based on `role`, so an allowed role does not need an
`admin:*` permission claim, and an `operator` or `viewer` is rejected even if
its JWT contains an admin-named permission.

`ADMIN_API_KEY` is still the feature switch for JWT access: when it is unset,
the guard returns `503` before attempting to verify a JWT.

### Header parsing and failures

The accepted header shape is exactly `Authorization: Bearer <token>`:
`Bearer` is case-sensitive, there must be exactly one space, and the complete
header may not exceed 8,192 characters. The guard preserves the existing bare
JSON error shape rather than the standard API error envelope.

| Condition                                                      | Status | Response body                                                                        |
| -------------------------------------------------------------- | -----: | ------------------------------------------------------------------------------------ |
| `ADMIN_API_KEY` unset or empty                                 |  `503` | `{"error":"Admin API is not configured. Set ADMIN_API_KEY to enable admin access."}` |
| Header missing                                                 |  `401` | `{"error":"Missing Authorization header."}`                                          |
| Header longer than 8,192 characters                            |  `401` | `{"error":"Authorization header too large."}`                                        |
| Scheme, spacing, or part count malformed                       |  `401` | `{"error":"Authorization header must use Bearer scheme."}`                           |
| Token present but neither the static key nor an authorized JWT |  `403` | `{"error":"Invalid admin credentials."}`                                             |

No `WWW-Authenticate` or `Retry-After` header is added by this guard.

### Validation, retry, and side effects

- Authorization runs before validation inside admin route handlers. A valid
  JSON request with an invalid or missing credential cannot trigger handler
  validation, state mutation, database work, or a handler audit event.
- The guard is stateless and has no credential lockout of its own. A request
  rejected with `401` or `403` can be retried immediately with corrected
  credentials, subject to the global rate limiter that runs earlier.
- A `503` caused by missing `ADMIN_API_KEY` is recoverable once configuration
  is supplied. The guard does not cache the previous failure.
- Retrying `POST /api/admin/reindex` after a successful `202` while the same
  job is running returns `409`; it does not start a second job.
- If `PUT /api/admin/pause` cannot persist its state, it returns `503` and
  leaves the in-memory pause flags unchanged, so a later retry is safe.

### Observability and audit behavior

Each execution of `requireAdminAuth` records one
`fluxora_auth_apikey_lookup_duration_seconds` histogram observation labeled
only with `outcome="success"` or `outcome="failure"`. The metric never includes
the token, key identifier, address, or role. Requests to the public
`/status/read-only` route do not execute this guard and therefore do not add an
admin-auth observation.

The guard itself does not create business audit records. Mutation handlers
write their documented audit events only after authorization and their
operation-specific success point; rejected authorization attempts do not
produce those events. All requests still pass through the application's
request logging and HTTP metrics middleware before reaching the router.

### Regression surface

Changes to any of the following are externally observable and require an
intentional compatibility decision:

- moving `/status/read-only` below the router guard or registering another
  route above it;
- changing the static-key/JWT role rules, or adding granular permission checks;
- normalizing Bearer scheme casing or whitespace;
- changing `503`/`401`/`403` classification or the legacy bare error bodies;
- moving handler validation or side effects ahead of the guard;
- allowing unknown `/api/admin/*` paths to bypass authorization;
- adding auth retries, lockout, audit writes, identity metric labels, or token
  material to logs;
- changing reindex conflict or pause-persistence retry semantics.

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
    {
      "streamId": "stream-456",
      "action": "cancel",
      "status": "failed",
      "error": "Stream not found"
    },
    { "streamId": "stream-789", "action": "reindex", "status": "success" }
  ],
  "successCount": 2,
  "failureCount": 1
}
```

## System Diagnostics

### `GET /api/admin/diagnostics`

Returns an aggregated system diagnostics snapshot for fast operator triage.
Aggregates DB pool stats, Redis connectivity, Stellar RPC circuit-breaker state,
and current indexer ledger lag into a single JSON response. Each sub-check is
individually timeout-bounded (default 5 seconds) so a single hung dependency
cannot stall the whole endpoint.

Response (200):

```json
{
  "success": true,
  "data": {
    "timestamp": "2026-07-29T12:00:00.000Z",
    "dbPool": {
      "status": "ok",
      "latencyMs": 2,
      "value": {
        "active": 3,
        "idle": 5,
        "waiting": 0
      }
    },
    "redis": {
      "status": "ok",
      "latencyMs": 1,
      "value": {
        "pingMs": 0.5
      }
    },
    "circuitBreaker": {
      "status": "ok",
      "latencyMs": 0,
      "value": {
        "state": "CLOSED",
        "transitionedAt": null,
        "failureCount": 0,
        "degraded": false
      }
    },
    "indexer": {
      "status": "ok",
      "latencyMs": 0,
      "value": {
        "lagSeconds": 0,
        "isReplaying": false,
        "rowsReplayed": 0,
        "totalRows": 0
      }
    }
  },
  "meta": {
    "timestamp": "2026-07-29T12:00:00.000Z",
    "requestId": "req-abc-123"
  }
}
```

Each sub-check status is one of:
- `"ok"` — check succeeded
- `"error"` — check failed with an error
- `"timeout"` — check exceeded its timeout

When a sub-check fails, a sanitised `error` field is included (connection
strings and credentials are redacted).

Error response (503):

```json
{
  "success": false,
  "error": {
    "code": "DIAGNOSTICS_ERROR",
    "message": "Diagnostics check failed",
    "requestId": "req-abc-123"
  }
}
```

Security notes:

- The endpoint is admin-only and fails closed when `ADMIN_API_KEY` is unset.
- Error messages are sanitised — connection URLs, passwords, and hostnames are
  stripped before being returned.
- No authentication tokens, API keys, or session identifiers are ever included
  in diagnostics output.
- Each sub-check runs with its own timeout so a single hung dependency cannot
  stall the entire endpoint (DoS protection).

## Related admin endpoints

- `GET /api/admin/status`
- `GET /api/admin/pause`
- `PUT /api/admin/pause`
- `GET /api/admin/reindex`
- `POST /api/admin/reindex`
- `GET /api/admin/diagnostics`
- `GET /api/admin/api-keys`
- `POST /api/admin/api-keys`
- `POST /api/admin/api-keys/:id/rotate`
- `DELETE /api/admin/api-keys/:id`
