# Response size limits (#1555)

Every response the API produces is bounded. There are three mechanisms, and
every endpoint is covered by at least one of them:

1. **Pagination / explicit item caps.** Collections take a `limit`
   (1–100 unless stated otherwise) and never return more rows than that.
2. **Byte cap on every buffered body.** `src/middleware/responseSizeLimit.ts`
   measures every body sent through `res.send()` / `res.json()`. A body over the
   limit is **not sent**; the client receives `500` with
   `error.details.reason = "RESPONSE_TOO_LARGE"`, and
   `fluxora_response_too_large_total{route}` is incremented. This makes an
   unbounded buffered response impossible by construction, including on
   endpoints that do not paginate.
3. **Streamed responses** (`res.write()`) do not buffer the whole body. They
   are bounded by explicit page caps or by backpressure, as listed below.

## Byte caps

| Path | Limit | Why |
|---|---|---|
| everything (default) | 1 MiB | `DEFAULT_RESPONSE_LIMIT_BYTES` |
| `/metrics` | 8 MiB | Prometheus text grows with series count |
| `/openapi.json` | 2 MiB | Static spec (~45 KiB today) |

Change a limit in `RESPONSE_ROUTE_LIMITS` and update this table in the same PR.

## Per-endpoint limits

| Endpoint | Bound |
|---|---|
| `GET /api/streams` | Cursor pagination, `limit` 1–100 (default 20); repository clamps to 100 |
| `GET /api/streams/:id`, `GET /api/streams/:id/export.jsonld` | Single resource; 1 MiB byte cap |
| `GET /api/streams/export` | NDJSON stream, 100 rows/page, at most 1,000 pages (100,000 rows) |
| `GET /api/streams/:id/events` | SSE stream; replay capped at 10 pages × 100 events |
| `GET /api/streams/:id/poll` | Long-poll; replay capped at 10 pages × 100 events, hold ≤ 30 s; 1 MiB byte cap |
| `GET /api/audit` | Offset pagination, `limit` 1–100 (default 20) |
| `GET /api/audit/export` | CSV/NDJSON stream with backpressure (constant memory per row) |
| `GET /admin/dlq` | `limit` 1–100 (default 50) |
| `GET /admin/dlq/:id` | Single resource; 1 MiB byte cap |
| `GET /internal/indexer/events`, `GET /internal/indexer/events/replay` | `limit` clamped to ≤ 1,000 by the event store (default 100); 1 MiB byte cap |
| `GET /internal/indexer/status` | Fixed-size object |
| `GET /internal/webhooks/deliveries` | Offset pagination, `limit` 1–100 (default 100) |
| `GET /internal/webhooks/outbox` | Offset pagination, `limit` 1–100 (default 100) — **was unbounded before #1555** |
| `GET /internal/webhooks/dlq` | `limit` 1–100 (default 50) |
| `GET /internal/webhooks/deliveries/:deliveryId`, `/circuit-breakers`, `/metrics` | Single resource / per-endpoint snapshot; 1 MiB byte cap |
| `GET /api/admin/api-keys`, `GET /api/admin/restore`, `GET /api/admin/rate-limits/overrides` | Admin-managed collections, not paginated; 1 MiB byte cap |
| `GET /api/admin/*` (status, deprecations, pause, reindex, diagnostics, …) | Fixed-size objects; 1 MiB byte cap |
| `GET /health`, `/health/ready`, `/health/live`, `/health/deployment` | Fixed-size objects |
| `GET /api/privacy/policy`, `/retention`, `/consent/:address` | Fixed-size objects |
| `GET /api/rate-limits`, `/api/rate-limits/config` | Fixed-size objects |
| `GET /api/graphql` | 1 MiB byte cap |
| `GET /metrics` | 8 MiB byte cap |
| `GET /openapi.json` | 2 MiB byte cap |
| `GET /docs/*` | Static Swagger UI assets (served as files) |

## Adding an endpoint

- Return a collection? Paginate it with `OffsetPaginationSchema` or
  `PaginationSchema` (`src/validation/paginationSchema.ts`) and add a row here.
- Need more than 1 MiB for a buffered body? Add an entry to
  `RESPONSE_ROUTE_LIMITS` with a `reason`, and add it to the byte-cap table.
- Streaming? Give the loop an explicit page cap or honour backpressure, and
  document it here.

The bound on the largest-response endpoint (the webhook outbox listing) and the
byte cap itself are asserted in `tests/middleware/responseSizeLimit.test.ts`.
