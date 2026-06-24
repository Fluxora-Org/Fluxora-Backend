# OpenAPI 3.1 Specification

## Endpoints

| URL | Description |
|-----|-------------|
| `GET /openapi.json` | Machine-readable OpenAPI 3.1 document |
| `GET /docs/` | Swagger UI (interactive browser) |

## How the spec is generated

The spec is built from Zod schemas at startup using [`@asteasolutions/zod-to-openapi`](https://github.com/asteasolutions/zod-to-openapi) (v8, Zod 4 compatible).

- **Registry**: `src/openapi/spec.ts` — registers all schemas, security schemes, and route definitions.
- **Route**: `src/routes/docs.ts` — serves `/openapi.json` and mounts Swagger UI at `/docs/`. The spec is built once and cached for the process lifetime.
- **App mount**: `src/app.ts` — `docsRouter` is registered before the 404 handler.

## Security schemes

| Scheme | Type | Used by |
|--------|------|---------|
| `bearerAuth` | HTTP Bearer (JWT) | Stream write, audit, admin routes |
| `indexerWorkerToken` | API key (`x-indexer-worker-token` header) | Internal indexer endpoints |

## Cursor Pagination — `GET /api/streams`

### Encoding

Cursors are **opaque base64url tokens**. Internally they encode `{ v: 1, lastId: "<stream-id>" }`, but this format is not part of the public API and may change. Clients must:

- Treat the token as a black box.
- Never construct or decode it manually.
- Pass the value of `next_cursor` verbatim as the `cursor` query param on the next request.

**Security**: Cursors do not contain raw database row ids or any PII. The embedded `lastId` is the same application-level stream id that already appears in list responses. Server-side ownership scoping is re-applied on every request regardless of the cursor value.

### Ordering

Results are returned in ascending `id` order (deterministic lexicographic sort). Stream ids are SHA-256-derived strings, so the sort is stable and consistent across pages.

### Stability

Cursors survive concurrent inserts because the repository uses keyset semantics (`WHERE id > lastId`). New rows added after a cursor is issued appear on subsequent pages without invalidating the cursor.

Deleting the row referenced by a cursor does not cause an error — the next matching row is returned and the client observes a gap, not a failure.

### Invalid / expired cursor

A cursor that cannot be decoded (wrong base64url, missing version tag, empty `lastId`, or tampered value) is rejected with:

```
HTTP 400 Bad Request
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "cursor must be a valid opaque pagination token"
  }
}
```

No database call is made. The client should discard the cursor and restart from page 1 by omitting the `cursor` parameter.

### Pagination flow

```
# Page 1 — omit cursor
GET /api/streams?limit=20
→ { data: { streams: [...], has_more: true,  next_cursor: "eyJ2..." } }

# Page 2 — pass next_cursor from page 1
GET /api/streams?limit=20&cursor=eyJ2...
→ { data: { streams: [...], has_more: true,  next_cursor: "eyJ3..." } }

# Last page — has_more=false, next_cursor=null → stop
GET /api/streams?limit=20&cursor=eyJ3...
→ { data: { streams: [...], has_more: false, next_cursor: null } }
```

## Adding a new route

1. Register any new Zod schemas with `registry.register(...)` in `src/openapi/spec.ts`.
2. Call `registry.registerPath(...)` with the route config.
3. Run `pnpm test -- tests/routes/docs.test.ts` to verify the spec builds and the new path appears.

## Running locally

```bash
pnpm dev
# spec:  curl http://localhost:3000/openapi.json | jq .info
# docs:  open http://localhost:3000/docs/
```
