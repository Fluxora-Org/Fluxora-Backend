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

## GET /api/streams/:id/export.jsonld

Returns a JSON-LD document with a Fluxora-defined `@context`, enabling machine-readable, self-describing data portability for a single stream.
The response uses `application/ld+json` Content-Type and uses string serialization for all amount fields to preserve full precision.

## Method Overrides

For legacy clients that cannot issue HTTP methods like `PATCH`, `PUT`, or `DELETE`, you can use the method override feature. This allows you to send a `POST` request with the intended method specified in either:

1. The `X-HTTP-Method-Override` HTTP header
2. The `_method` query parameter

This feature is only available for authenticated requests and is restricted to `PATCH`, `DELETE`, and `PUT`. Attempts to override unauthenticated routes or use unsupported methods will result in a `400 Bad Request`.

### Examples

Using the HTTP header:
```http
POST /api/streams/stream-abc123-0/status
Authorization: Bearer <token>
X-HTTP-Method-Override: PATCH
Content-Type: application/json

{ "status": "paused" }
```

Using the query parameter:
```http
POST /api/streams/stream-abc123-0/status?_method=PATCH
Authorization: Bearer <token>
Content-Type: application/json

{ "status": "paused" }
```
