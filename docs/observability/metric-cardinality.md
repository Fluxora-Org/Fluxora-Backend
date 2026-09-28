# Metric label cardinality policy

Prometheus (and compatible backends) create one time series per unique
combination of metric name + label values. Label values that grow without
bound — stream IDs, path parameters, tenants, wallet addresses — will
eventually overwhelm the metrics backend and break dashboards.

This document is the **cardinality policy** for `src/metrics` and any code
that emits Prometheus labels. Enforcement lives in
`src/metrics/cardinality.ts`.

## Allowed label values

| Kind | Examples | Rule |
|------|----------|------|
| Closed enums | `outcome=success\|failure`, `status=active\|paused`, `reason=per_ip_limit` | Finite, code-defined set only |
| HTTP method | `GET`, `POST`, … | Standard method tokens |
| Status code | `200`, `404`, `500` | Three-digit HTTP status |
| Route template | `/api/streams/:id`, `/health` | Express route path **or** output of `normalizeRouteLabel()` |
| Hashed bucket | `consumer_hash` (SHA-256 prefix) | One-way hash; never the raw URL |
| Static service | `service=fluxora-backend` | Default registry label |

## Forbidden label values

Never use these as label **values** (or as label **names** that imply them):

- Stream / event / tenant / user identifiers
- Stellar account or contract addresses (`G…` / `C…` strkeys)
- Raw request paths with path parameters or query strings
- Idempotency keys, API keys, JWTs, `jti`, correlation / request IDs
- Arbitrary free-text (error messages, hostnames, emails)

Forbidden label **names** are listed in `FORBIDDEN_LABEL_NAMES` and rejected
by `assertCollectorLabels()`.

## High-cardinality → bucket mapping

When a path must be labelled (HTTP metrics, body-size rejects), run it through
`normalizeRouteLabel()`:

| Input segment | Bucket |
|---------------|--------|
| UUID | `:id` |
| Numeric id (`\d{3,}`) | `:id` |
| ULID / cuid / long hex | `:id` |
| Stellar `G…` / `C…` strkey | `:address` |
| Static vocabulary (`streams`, `health`) | unchanged |

Example:

```
/api/streams/550e8400-e29b-41d4-a716-446655440000
  → /api/streams/:id
```

## Checklist for new collectors

1. Prefer **no labels**, or a closed enum.
2. Call `assertCollectorLabels(['…'])` next to the collector definition (or in its unit test).
3. If labelling a path, pass it through `normalizeRouteLabel()` — never `req.originalUrl`.
4. Add a test that drives **many distinct** high-cardinality inputs and asserts
   `countMetricSeries()` stays at a small fixed bound.

## Validation

Drive HTTP requests with many distinct path parameters and assert the
`http_requests_total` series count remains bounded (see
`tests/metrics/cardinality.test.ts`).
