# Experimental GraphQL Federation Gateway

## Overview

The GraphQL federation gateway exposes a minimal read-only GraphQL query surface
over the existing streams and audit-log data. It is **experimental** and gated
behind a feature flag — it is disabled by default and must be explicitly
activated via `FEATURE_FLAGS_JSON`.

## Feature Flag

The gateway is controlled by the `experimental_graphql_gateway` feature flag
using the existing [LaunchDarkly‑style percentage rollout](../src/config/featureFlags.ts).

**Enable for all requests:**

```json
FEATURE_FLAGS_JSON='[{"name":"experimental_graphql_gateway","percentage":100}]'
```

**Enable for 10% of requests:**

```json
FEATURE_FLAGS_JSON='[{"name":"experimental_graphql_gateway","percentage":10}]'
```

When the flag is disabled, the endpoint exists but returns a GraphQL error with
code `FEATURE_FLAG_DISABLED`. No schema introspection is exposed to callers
without the flag.

## Endpoint

### `POST /api/graphql`

Standard GraphQL POST endpoint. Accepts `application/json` with the usual
`{ query, variables, operationName }` body.

### `GET /api/graphql?sdl`

Returns the raw SDL (Schema Definition Language) string for tooling such as
GraphQL code generators. Useful for integrating with `graphql-codegen` or
similar tools.

## Authentication

The gateway uses the same `authenticate` + `requireAuth` middleware as all
other REST routes. Requests must include:

- A valid **Bearer token** matching `ADMIN_API_KEY`, or
- A valid **JWT** with an authorized role (`admin` or `data-protection-officer`)

Requests without valid credentials are rejected with HTTP 401 before any
GraphQL processing begins.

## Schema

### Query: `stream(id: ID!): Stream`

Fetch a single stream record by its unique ID.

```graphql
{
  stream(id: "stream-abc-123") {
    id
    senderAddress
    recipientAddress
    amount
    streamedAmount
    remainingAmount
    status
    createdAt
  }
}
```

### Query: `streams(limit: Int, status: StreamStatus, contractId: String, afterId: String, includeTotal: Boolean): StreamConnection!`

Paginated stream list with optional filters. Uses cursor-based (keyset)
pagination when `afterId` is provided.

```graphql
{
  streams(limit: 10, status: active, includeTotal: true) {
    streams {
      id
      amount
      status
    }
    hasMore
    total
  }
}
```

### Query: `auditEntries(limit: Int, offset: Int, actionType: String): AuditConnection!`

Query in-memory audit-log entries with optional action-type filter.

```graphql
{
  auditEntries(limit: 10, actionType: "STREAM_CREATED") {
    entries {
      seq
      timestamp
      action
      resourceId
      meta
    }
    total
  }
}
```

## Security

- **Feature-flagged**: the gateway is entirely unreachable (returns
  `FEATURE_FLAG_DISABLED`) when the flag is off.
- **Authenticated**: all requests require a valid Bearer token or JWT.
- **Read-only**: the schema exposes only queries — no mutations.
- **Sanitised errors**: internal error messages never leak stack traces,
  connection strings, or credentials.
- **No PII in audit responses**: sensitive fields in audit entry `meta` blobs
  are redacted via the same sanitisation logic as the REST audit endpoint.

## Limitations

- The schema is **read-only** — no mutations are supported.
- Audit log queries currently read from the **in-memory** log only; database-
  backed audit entries are not yet surfaced through GraphQL.
- **No subscriptions** — this is a query-only gateway.
- The feature flag is evaluated per-request based on the caller identity, not
  globally. A caller who meets the rollout percentage can access the gateway
  even when others cannot.
