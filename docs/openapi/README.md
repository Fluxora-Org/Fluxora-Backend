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
