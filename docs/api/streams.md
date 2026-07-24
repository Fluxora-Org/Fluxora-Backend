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

