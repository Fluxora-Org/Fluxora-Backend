# Streams API

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

