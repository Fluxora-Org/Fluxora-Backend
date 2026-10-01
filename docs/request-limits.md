# Request limits (#1468)

Every inbound request body is bounded **while it is being read**, never after.
A limit that is only checked once the payload has been buffered does not
protect memory — by the time the refusal happens, the process has already paid
for the bytes it was trying to avoid.

Implementation: `src/middleware/requestProtection.ts`, wired in `src/app.ts`.

## The three layers

| Layer | Middleware | Runs | Refusal |
|---|---|---|---|
| Raw body size | `bodySizeLimitMiddleware` | before any body is parsed | `413 PAYLOAD_TOO_LARGE` |
| JSON nesting depth | `jsonDepthLimitMiddleware` | on the raw stream, before `express.json()` | `400 VALIDATION_ERROR` |
| Decompressed size / post-parse depth | `dynamicJsonParser`, `jsonDepthMiddleware` | during/after parsing | `413` / `400` |

Layer 3 is a second line of defence. It also covers the case the streaming scan
cannot see: a **compressed** body, whose bytes on the wire are not JSON and are
therefore not depth-scanned. The decompressed size is bounded by the parser
limit, and the nesting is validated once the object graph exists.

## Why the order matters

`src/app.ts` registers the guards before the parser:

```ts
app.use(bodySizeLimitMiddleware);      // 1. refuse oversized bodies mid-read
app.use(jsonDepthLimitMiddleware(depth)); // 2. refuse deep nesting mid-read
app.use(dynamicJsonParser);           // 3. parse (bounded by the decompressed limit)
app.use(jsonDepthMiddleware(depth));  // 4. re-check depth after parsing
```

## Refusal mechanics

When a guard trips mid-read it:

1. counts the bytes that arrived and compares them with the limit,
2. calls `req.pause()` so the rest of the payload is never buffered — neither
   by this process nor by `express.json()` downstream,
3. responds `413`/`400` with `Connection: close`, so Node closes the socket
   after the (small) refusal has been flushed.

The socket is deliberately **not** destroyed eagerly: destroying it while the
refusal is still in the write queue resets the connection, and the client sees
a transport error instead of the `413`.

A per-request guard makes sure two guards cannot both answer the same request
(a second `next(err)` after the response is flushed would raise
`ERR_HTTP_HEADERS_SENT`), and that a request is counted once.

## Limits and how to change them

| Limit | Default | Configured by |
|---|---|---|
| Default raw body size | 256 KiB (`DEFAULT_RAW_LIMIT_BYTES`) | `MAX_REQUEST_SIZE` (lowers it) |
| Default decompressed body size | 256 KiB (`DEFAULT_DECOMPRESSED_LIMIT_BYTES`) | `MAX_REQUEST_SIZE` (lowers it) |
| `/internal/webhooks/*` | 2 MiB raw / 10 MiB decompressed | `ROUTE_LIMITS` |
| `/api/uploads/*` | 10 MiB raw / 50 MiB decompressed | `ROUTE_LIMITS` |
| JSON nesting depth | 20 (`DEFAULT_JSON_MAX_DEPTH`) | `MAX_JSON_DEPTH` |

- `MAX_REQUEST_SIZE` accepts byte sizes (`512kb`, `1mb`) and acts as an
  operator-tunable **cap** on the built-in default. Raising the default above
  256 KiB is a deliberate, reviewable edit in `ROUTE_LIMITS` or the constants in
  `requestProtection.ts`, not an environment change.
- `MAX_JSON_DEPTH` is the nesting limit used by both the streaming scan and the
  post-parse check, so the two can never disagree.
- Per-route limits in `ROUTE_LIMITS` take precedence over the defaults. Change a
  limit and update the table above in the same PR.

## Metrics

| Metric | Meaning |
|---|---|
| `fluxora_request_body_too_large_total{path}` | Requests refused for exceeding a size limit (raw or decompressed). |
| `fluxora_request_body_too_deep_total{path}` | Requests refused because JSON nesting exceeded `MAX_JSON_DEPTH`. |

`path` is the normalised route template, never the raw URL, so path parameters
and query strings cannot leak into label values.

```promql
increase(fluxora_request_body_too_large_total[5m]) > 50
increase(fluxora_request_body_too_deep_total[5m]) > 20
```

## Tests

- `tests/requestProtection.streaming.test.ts` — the temporal property: a
  chunked body far above the limit is refused promptly, and the bytes observed
  downstream of the guard stay bounded by the limit (4 MiB and 32 MiB uploads
  against a 256 KiB limit), plus deep nesting refused after the first chunk.
  It also asserts the guards are actually wired into `createApp()`.
- `tests/requestProtection.test.ts` — limit resolution per route, the exact
  boundary cases, and the decompressed (zip bomb) limit.
- `tests/middleware/requestProtection.metric.test.ts` — counter behaviour and
  label normalisation for both counters.
