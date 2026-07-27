# Streams API

## GET /api/streams

List streams with cursor-based pagination.

This endpoint supports HTTP 103 Early Hints (RFC 8297) for HTTP/2 clients to enable DNS and TLS prefetching of the next page URL while the current page is being computed. Clients that don't support 1xx informational responses transparently ignore Early Hints with no functional impact.

### Query Parameters

| Name | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `limit` | integer | 50 | Number of streams to return. Must be between 1 and 100. |
| `cursor` | string | — | Opaque pagination cursor from a previous response's `next_cursor` field. |
| `status` | string | — | Filter by stream status: `active`, `paused`, `completed`, `cancelled`. |
| `sender` | string | — | Filter by sender Stellar address. |
| `recipient` | string | — | Filter by recipient Stellar address. |
| `include_total` | boolean | false | When `true`, includes a `total` field with the count of all matching streams. |

### Response Body

```json
{
  "success": true,
  "data": {
    "streams": [
      {
        "id": "stream-abc123",
        "sender": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        "recipient": "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN",
        "depositAmount": "1000.00",
        "streamedAmount": "100.00",
        "remainingAmount": "900.00",
        "ratePerSecond": "0.10",
        "startTime": 1700000000,
        "endTime": 0,
        "status": "active"
      }
    ],
    "has_more": true,
    "next_cursor": "eyJ2IjogMSwgImxhc3RJZCI6ICJzdHJlYW0tYWJjMTIzIn0",
    "total": 1000
  },
  "meta": {
    "timestamp": "2024-01-15T10:30:00Z",
    "requestId": "req-12345"
  }
}
```

### Example: Basic Listing

```bash
curl http://localhost:3000/api/streams
```

### Example: Paginated Request

Fetch the second page using the `next_cursor` from the first response:

```bash
curl "http://localhost:3000/api/streams?cursor=<NEXT_CURSOR_VALUE>&limit=50"
```

### Example: Filtered Listing

Fetch streams filtered by status:

```bash
curl "http://localhost:3000/api/streams?status=active&sender=GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"
```

### Example: Count All Results

Include the total count of all matching streams:

```bash
curl "http://localhost:3000/api/streams?include_total=true"
```

### HTTP 103 Early Hints

When paginating forward (i.e., when `has_more: true` and a `next_cursor` is present), the server sends an HTTP 103 Early Hints response with a Link header before the main response:

```http
HTTP/1.1 103 Early Hints
Link: </api/streams?cursor=...&limit=50>; rel="next"

HTTP/1.1 200 OK
Content-Type: application/json
...
```

This allows HTTP/2-aware clients to begin DNS resolution and TLS handshake for the next page URL while the server is still computing the current page's results.

**Graceful Degradation:**
- Clients that don't support 1xx responses (HTTP/1.0, some proxies) silently ignore Early Hints.
- Early Hints are sent asynchronously and never delay the main response (time-to-first-byte is unchanged).
- If Early Hints are sent but headers have already been sent by the time the async task executes, no error is raised.

### Pagination

Streams listing uses **cursor-based pagination** (keyset pagination), which is more efficient than offset-based pagination for large datasets.

- On the first request, omit the `cursor` parameter.
- The response includes `has_more: true` if more results exist, and `next_cursor` contains an opaque token.
- To fetch the next page, pass `cursor=<next_cursor>` in the next request.
- When `has_more: false`, you have reached the end of results and `next_cursor` is `null`.

**Important:** Cursors are opaque and may change between versions. Do not attempt to parse them; treat them as black-box tokens.

### Pagination Validation Contract

All query parameters are validated via Zod (`PaginationSchema`) **before** any database call is made. Invalid parameters return `400 VALIDATION_ERROR` with a descriptive message.

| Parameter | Type | Validation Rules | Default | Error on Violation |
| :--- | :--- | :--- | :--- | :--- |
| `limit` | string → integer | Must be a positive integer string. Parsed to int, clamped to `[1, 100]`. | `50` | `400 VALIDATION_ERROR` |
| `cursor` | string | Must be a non-empty string. Decoded from base64url; must be valid JSON with `{v: 1, lastId: string}` shape. | `undefined` (first page) | `400 VALIDATION_ERROR` |
| `status` | string | Passed as-is to the DB filter. No enum validation at the route level. | `undefined` (no filter) | N/A |
| `sender` | string | Passed as-is to the DB filter. | `undefined` (no filter) | N/A |
| `recipient` | string | Passed as-is to the DB filter. | `undefined` (no filter) | N/A |
| `include_total` | string | Must be `"true"` or `"false"` (exact string match). | `false` | `400 VALIDATION_ERROR` |

#### Cursor structure

Cursors are opaque base64url tokens. Internally they encode:

```json
{ "v": 1, "lastId": "stream-abc123-0" }
```

The `v` field is a version tag for forward compatibility. The `lastId` is the stream ID of the last item on the previous page. The cursor is **never** validated against the database — it is simply passed to `streamRepository.findWithCursor()` as the `afterId` parameter. If the cursor references a deleted or non-existent stream, the query returns results starting from the next valid ID (graceful degradation).

#### Error responses

| Condition | HTTP Status | Code | Message |
| :--- | :--- | :--- | :--- |
| `limit` is not a number string | 400 | VALIDATION_ERROR | `limit must be a positive integer` |
| `limit` < 1 or > 100 | 400 | VALIDATION_ERROR | `limit must be at least 1` / `limit must be at most 100` |
| `cursor` is empty or whitespace | 400 | VALIDATION_ERROR | `cursor must be a valid opaque pagination token` |
| `cursor` is not valid base64url JSON | 400 | VALIDATION_ERROR | `cursor must be a valid opaque pagination token` |
| `cursor` JSON lacks `v` or `lastId` | 400 | VALIDATION_ERROR | `cursor must be a valid opaque pagination token` |
| `include_total` is not `"true"` or `"false"` | 400 | VALIDATION_ERROR | `include_total must be true or false` |
| Database unavailable | 503 | SERVICE_UNAVAILABLE | `Stream list is temporarily unavailable.` |

#### Regression surface

The following behaviors must remain stable:

1. **Default limit**: Omitting `limit` returns 20 results (not 50 as the query-param docs state — the Zod schema default overrides the route-level default).
2. **Cursor opacity**: Clients must never construct cursors manually; they are server-generated and versioned.
3. **`include_total` cost**: When `include_total=true`, an additional `COUNT(*)` query runs against the same filter. This is O(n) and should be used sparingly.
4. **Empty page**: When no streams match the filter, `streams` is `[]`, `has_more` is `false`, and `next_cursor` is `null`.
5. **Cache-Control**: Pages with all-terminal streams get `public, max-age=300`; mutable pages get `private, no-store`.
6. **Read-your-writes**: Clients echoing `X-Fluxora-Write-Fence` from a prior write response are routed to the primary pool.

### Caching

The `Cache-Control` header depends on stream status:

- If all streams on the current page are in a terminal state (`completed` or `cancelled`), the response is cached: `Cache-Control: public, max-age=300, stale-while-revalidate=60`
- Otherwise, the response is private: `Cache-Control: private, no-store`

This ensures that mutable streams (active, paused) are never cached, while terminal streams can be safely cached by clients and CDNs.

## HEAD /api/streams/:id

Use `HEAD` when you only need to know whether a stream exists.
The handler performs a minimal lookup and returns headers without serialising the full stream body.

### Example

```bash
curl -I http://localhost:3000/api/streams/stream-abc123-0
```

### Typical response

```http
HTTP/1.1 200 OK
ETag: W/"H1v3u4P2w0uFJp5TzS2xV6lWm7R9oQ0xZx2gV7fWgJ0"
Last-Modified: Mon, 01 Jan 2024 00:00:00 GMT
```

If the stream does not exist, the endpoint returns `404 Not Found`.

## GET /api/streams/:id

`GET` still returns the full stream document. If you only need existence checks, prefer `HEAD` to avoid unnecessary payload transfer.

## GET /api/streams/export

Bulk export of all streams in the database in NDJSON format.

This endpoint streams records row-by-row, ensuring low memory usage even for large tables.

### Query Parameters

| Name | Type | Description |
| :--- | :--- | :--- |
| `resume_from` | `string` | Optional cursor to resume a previous interrupted export. |

### Example

```bash
curl http://localhost:3000/api/streams/export
```

Each line in the response is a JSON object. The final line of each batch contains a `resumption_cursor` field.

```json
{"id":"...","sender":"...","recipient":"...","depositAmount":"...","streamedAmount":"...","remainingAmount":"...","ratePerSecond":"...","startTime":...,"endTime":...,"status":"..."}
{"resumption_cursor":"..."}
```

To resume after a connection drop:

```bash
curl "http://localhost:3000/api/streams/export?resume_from=<CURSOR_VALUE>"
```

## GET /api/streams/:id/export.jsonld

Returns a JSON-LD document for a single stream, conforming to the Fluxora
vocabulary (`https://fluxora.dev/ns/v1`). Use this endpoint for
data-portability requirements — archives, semantic-web tooling, compliance
exports, and cross-system interoperability — where the standard
`application/json` envelope of `GET /api/streams/:id` is not appropriate.

### Authentication

Requires the same API key + `streams:read` scope as `GET /api/streams/:id`.

### Response headers

| Header | Value | Notes |
| :--- | :--- | :--- |
| `Content-Type` | `application/ld+json` | Always set; never `application/json` |
| `ETag` | `W/"<fingerprint>"` | Weak entity-tag; same fingerprint as `GET /:id` |
| `Last-Modified` | RFC 7231 date | Derived from `updated_at` |
| `Cache-Control` | `public, max-age=300, stale-while-revalidate=60` | Terminal streams only |
| `Cache-Control` | `private, no-store` | Active and paused streams |
| `Link` | `<https://fluxora.dev/ns/v1>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"` | JSON-LD context advertisement per spec §4.1 |

### Conditional GET

The endpoint honours `If-None-Match`. Pass the `ETag` value from a previous
response to skip transferring an unchanged document:

```http
GET /api/streams/stream-abc123-0/export.jsonld
If-None-Match: W/"abc123"
X-API-Key: <key>
```

Returns `304 Not Modified` (no body) when the stream has not changed.

### Response body

The response is a raw JSON-LD object — **not** wrapped in the standard
`{ success, data, meta }` envelope — so that linked-data processors can
consume it directly.

```json
{
  "@context": "https://fluxora.dev/ns/v1",
  "@type": "PaymentStream",
  "@id": "https://fluxora.dev/streams/stream-abc123-0",
  "identifier": "stream-abc123-0",
  "sender": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
  "recipient": "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN",
  "depositAmount": "1000",
  "streamedAmount": "100",
  "remainingAmount": "900",
  "ratePerSecond": "0.1",
  "startTime": 1700000000,
  "endTime": 0,
  "status": "active",
  "contractId": "CABC1234CONTRACT",
  "transactionHash": "aaaa...aaaa"
}
```

### Field reference

| Field | JSON-LD term | Type | Description |
| :--- | :--- | :--- | :--- |
| `@context` | — | string | Always `https://fluxora.dev/ns/v1` |
| `@type` | — | string | Always `PaymentStream` |
| `@id` | — | URI | Resolvable URI uniquely identifying this stream |
| `identifier` | `identifier` | string | Opaque stream ID derived from the on-chain event |
| `sender` | `sender` | string | Stellar address of the fund sender |
| `recipient` | `recipient` | string | Stellar address of the fund recipient |
| `depositAmount` | `depositAmount` | decimal string | Total deposited amount; full precision |
| `streamedAmount` | `streamedAmount` | decimal string | Amount already streamed; full precision |
| `remainingAmount` | `remainingAmount` | decimal string | Amount yet to be streamed; full precision |
| `ratePerSecond` | `ratePerSecond` | decimal string | Streaming rate in tokens/second; full precision |
| `startTime` | `startTime` | integer | Unix timestamp (seconds) when the stream starts |
| `endTime` | `endTime` | integer | Unix timestamp (seconds) when the stream ends; `0` = indefinite |
| `status` | `status` | string | `active` \| `paused` \| `completed` \| `cancelled` |
| `contractId` | `contractId` | string | Soroban contract ID governing this stream |
| `transactionHash` | `transactionHash` | string | On-chain transaction hash |

> **Precision note** — all amount fields are decimal strings to avoid
> floating-point rounding. Trailing fractional zeros are stripped
> (e.g. `"100.50"` is serialised as `"100.5"`).

### Example

```bash
curl https://api.example.com/api/streams/stream-abc123-0/export.jsonld \
  -H "X-API-Key: <key>" \
  -H "Accept: application/ld+json"
```

### Error responses

| Status | Code | Cause |
| :--- | :--- | :--- |
| `401` | `UNAUTHORIZED` | Missing or invalid API key |
| `403` | `FORBIDDEN` | API key lacks `streams:read` scope |
| `404` | `NOT_FOUND` | Stream does not exist |
| `503` | `SERVICE_UNAVAILABLE` | Database connection pool exhausted |

## GET /api/streams/:id/poll

Long-polling fallback endpoint for WebSocket-incapable clients or clients behind enterprise proxies that block WebSocket/SSE upgrades.
Holds the connection open (bounded by a timeout) until a new event for the stream arrives or the timeout elapses. Returns the same event envelope shape used by the WebSocket/SSE hub.

### Query Parameters

| Name | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `since` | string | — | Optional. Event ID cursor to fetch missed events. Replays from the since point before holding for live updates. |
| `timeout` | integer | 30 | Optional. Maximum duration in seconds to hold the connection open. Capped at a maximum of 30 seconds. |

### Response Body

#### If an event is found (either immediately or during the poll duration):
Returns a standard event envelope:
```json
{
  "success": true,
  "data": {
    "type": "stream_update",
    "streamId": "stream-abc123-0",
    "eventId": "evt-12345",
    "payload": {
      "id": "stream-abc123-0",
      "depositAmount": "1000",
      "streamedAmount": "100",
      "remainingAmount": "900",
      "ratePerSecond": "0.1",
      "status": "active"
    },
    "correlationId": "req-98765"
  },
  "meta": {
    "timestamp": "2024-01-15T10:30:00Z",
    "requestId": "req-98765"
  }
}
```

#### If the timeout elapses with no new events:
Returns a success envelope with `null` data:
```json
{
  "success": true,
  "data": null,
  "meta": {
    "timestamp": "2024-01-15T10:30:30Z",
    "requestId": "req-98765"
  }
}
```

### Rate Limiting and Capacity Limits

To prevent resource exhaustion, the long-poll endpoint enforces a dedicated limiter:
- **Maximum hold duration**: 30 seconds.
- **Per-IP concurrent connection cap**: Clamped by `LONG_POLL_MAX_CONNECTIONS_PER_IP` (default: `10`).
- **Global concurrent connection cap**: Clamped by `LONG_POLL_MAX_GLOBAL_CONNECTIONS` (default: `1000`).

Reaching these limits will return a `429 Too Many Requests` error with a `Retry-After` header.

### Example

```bash
curl "http://localhost:3000/api/streams/stream-abc123-0/poll?since=evt-100&timeout=20" \
  -H "X-API-Key: <your-api-key>"
```

### Error responses

| Status | Code | Cause |
| :--- | :--- | :--- |
| `400` | `VALIDATION_ERROR` | Invalid `since` or `timeout` parameters, or stale cursor error |
| `401` | `UNAUTHORIZED` | Missing or invalid authentication token |
| `404` | `NOT_FOUND` | Stream does not exist |
| `429` | `TOO_MANY_REQUESTS` | Active long-poll capacity limit exceeded |
| `503` | `SERVICE_UNAVAILABLE` | Database connection pool exhausted |

## Method Overrides

For legacy infrastructure or middleboxes that can only issue `POST` requests, Fluxora supports HTTP Method Override. You can submit a `POST` request and specify the target HTTP method using:

1. **HTTP Header**: `X-HTTP-Method-Override: <METHOD>` (Recommended)
2. **Query Parameter**: `POST /api/resource?_method=<METHOD>`

### Supported Override Methods

Method overrides are strictly limited to mutating or idempotent methods:
- `PATCH` — Partial updates (e.g. updating stream status)
- `PUT` — Full resource updates
- `DELETE` — Resource cancellation or erasure

### Security & Restrictions

- **Authentication Requirement**: Method override is only enabled for authenticated requests carrying valid Bearer tokens (`Authorization: Bearer <token>`) or API keys (`X-API-Key: <key>`).
- **Public & Unauthenticated Endpoints**: Method override is strictly disabled on public endpoints (`/`), health probes (`/health`), authentication routes (`/api/auth/*`), webhooks (`/internal/webhooks/*`), indexer endpoints (`/internal/indexer/*`), and documentation routes (`/docs`).
- **Priority Rule**: When both the `X-HTTP-Method-Override` header and `_method` query parameter are present, the header value takes precedence.
- **Validation**: Override values are normalized to uppercase (e.g. `patch` → `PATCH`). Attempting to override to unsupported methods (`GET`, `POST`, `OPTIONS`, `HEAD`, `TRACE`, `CONNECT`, or arbitrary strings) will return `400 Bad Request` with a `VALIDATION_ERROR` error envelope.
- **Audit Logging**: Every method override is logged in structured server logs with the original method (`POST`), effective method, authenticated user identifier, request path, and timestamp.

### Request Examples

#### 1. PATCH Request (Header Override)

Update a stream's status to `paused` using the `X-HTTP-Method-Override` header:

```http
POST /api/streams/stream-abc123-0/status HTTP/1.1
Host: api.fluxora.io
Authorization: Bearer <JWT_TOKEN>
X-HTTP-Method-Override: PATCH
Content-Type: application/json

{
  "status": "paused"
}
```

Equivalent cURL:

```bash
curl -X POST "http://localhost:3000/api/streams/stream-abc123-0/status" \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "X-HTTP-Method-Override: PATCH" \
  -H "Content-Type: application/json" \
  -d '{"status":"paused"}'
```

#### 2. PUT Request (Query Parameter Override)

Full update of stream configuration using `?_method=PUT`:

```http
POST /api/streams/stream-abc123-0?_method=PUT HTTP/1.1
Host: api.fluxora.io
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json

{
  "ratePerSecond": "0.50"
}
```

Equivalent cURL:

```bash
curl -X POST "http://localhost:3000/api/streams/stream-abc123-0?_method=PUT" \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"ratePerSecond":"0.50"}'
```

#### 3. DELETE Request (Header Override)

Cancel a stream using `X-HTTP-Method-Override: DELETE`:

```http
POST /api/streams/stream-abc123-0/cancel HTTP/1.1
Host: api.fluxora.io
Authorization: Bearer <JWT_TOKEN>
X-HTTP-Method-Override: DELETE
Content-Type: application/json
```

Equivalent cURL:

```bash
curl -X POST "http://localhost:3000/api/streams/stream-abc123-0/cancel" \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "X-HTTP-Method-Override: DELETE"
```

#### 4. Invalid Method Response (400 Bad Request)

If an unsupported method override (such as `GET`) is supplied:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Unsupported method override: GET. Only PATCH, PUT, and DELETE are supported.",
    "requestId": "req-98765"
  }
}
```
