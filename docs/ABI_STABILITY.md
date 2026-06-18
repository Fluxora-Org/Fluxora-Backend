# ABI Stability Guarantees

> **Audience:** Indexer operators, wallet developers, and any integrator building against the Fluxora HTTP API or consuming chain-derived events.
>
> **Scope:** HTTP entrypoints, error codes, event schemas, storage discriminants, and the decimal-string serialization contract.
>
> **Current version:** `0.1.0`

---

## Table of Contents

1. [What "ABI Stability" Means Here](#1-what-abi-stability-means-here)
2. [Versioning Policy](#2-versioning-policy)
3. [Stable Surfaces](#3-stable-surfaces)
   - [3.1 HTTP Entrypoints](#31-http-entrypoints)
   - [3.2 Request and Response Schemas](#32-request-and-response-schemas)
   - [3.3 Error Codes](#33-error-codes)
   - [3.4 Event Schemas](#34-event-schemas)
   - [3.5 Storage Discriminants](#35-storage-discriminants)
   - [3.6 Decimal-String Serialization Contract](#36-decimal-string-serialization-contract)
   - [3.7 Idempotency Contract](#37-idempotency-contract)
   - [3.8 Webhook Signature Contract](#38-webhook-signature-contract)
4. [Breaking vs. Non-Breaking Changes](#4-breaking-vs-non-breaking-changes)
   - [4.1 Breaking Changes (require major version bump)](#41-breaking-changes-require-major-version-bump)
   - [4.2 Non-Breaking Changes (allowed in minor/patch)](#42-non-breaking-changes-allowed-in-minorpatch)
5. [Deprecation Process](#5-deprecation-process)
6. [Internal and Admin Surfaces](#6-internal-and-admin-surfaces)
7. [Stability by Surface Summary](#7-stability-by-surface-summary)

---

## 1. What "ABI Stability" Means Here

Fluxora's "ABI" is the set of observable contracts that external integrators depend on:

- **HTTP entrypoints** — URL paths, HTTP methods, required headers, and status codes.
- **Request/response schemas** — field names, types, and required vs. optional semantics.
- **Error codes** — the `code` string inside every `{ error: { code, message } }` envelope.
- **Event schemas** — the shape of `ContractEventRecord` batches submitted to the indexer and the `StreamEvent` types emitted to WebSocket consumers.
- **Storage discriminants** — enum values used as type tags in the database (`status`, `store`, `dependency`).
- **Serialization invariants** — the decimal-string rule for all monetary amounts.

A change is **breaking** if it forces an integrator to update their code to avoid a runtime error or data-integrity failure. A change is **non-breaking** if existing integrators can ignore it without consequence.

---

## 2. Versioning Policy

Fluxora follows [Semantic Versioning 2.0.0](https://semver.org/):

| Version component | When it changes |
|---|---|
| **MAJOR** (`1.x.x`) | Any breaking change to a stable surface listed in §3 |
| **MINOR** (`x.1.x`) | New stable surfaces, new optional fields, new non-breaking error codes |
| **PATCH** (`x.x.1`) | Bug fixes, documentation corrections, internal refactors with no observable change |

The current version is `0.1.0`. While the major version is `0`, breaking changes may occur in minor releases but will always be documented in [`docs/upgrade.md`](./upgrade.md) with a migration path.

Once the API reaches `1.0.0`, all breaking changes require a major version bump and a minimum **90-day deprecation window**.

---

## 3. Stable Surfaces

### 3.1 HTTP Entrypoints

The following routes are **stable** and will not be removed or have their HTTP method changed without a major version bump.

#### Public Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | None | API metadata |
| `GET` | `/health` | None | Liveness + indexer health |
| `GET` | `/health/ready` | None | Readiness probe |
| `GET` | `/health/live` | None | Detailed health report |
| `GET` | `/api/streams` | None | List streams (cursor pagination) |
| `GET` | `/api/streams/:id` | None | Get stream by ID |
| `POST` | `/api/streams` | JWT Bearer | Create stream |
| `DELETE` | `/api/streams/:id` | JWT Bearer | Cancel stream |
| `PATCH` | `/api/streams/:id/status` | JWT Bearer | Transition stream status |
| `POST` | `/api/auth/session` | None | Issue JWT from Stellar address |

#### Internal Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/internal/indexer/contract-events` | `x-indexer-worker-token` | Ingest contract event batch |

> **Note:** Routes under `/api/admin/`, `/admin/dlq/`, and `/api/audit/` are operator-facing and carry a **best-effort** stability guarantee. They may change in minor versions with notice in the changelog.

#### Path Parameter Formats

| Parameter | Format | Example | Stable |
|---|---|---|---|
| `:id` (stream) | `stream-{txHash}-{eventIndex}` | `stream-abc123-0` | ✅ Yes |
| `:streamId` | Same as `:id` | `stream-abc123-0` | ✅ Yes |

The `stream-{txHash}-{eventIndex}` ID format is a **stable discriminant**. Integrators may parse and store it. The separator character (`-`) and prefix (`stream-`) will not change without a major version bump.

---

### 3.2 Request and Response Schemas

#### `POST /api/streams` — Create Stream

**Request body** (`application/json`):

```typescript
{
  sender: string;        // Stellar public key — G followed by 55 base32 chars
  recipient: string;     // Stellar public key — G followed by 55 base32 chars
  depositAmount?: string; // Decimal string, e.g. "1000" or "0.0000116"
  ratePerSecond?: string; // Decimal string, must be > 0
  startTime?: number;    // Unix timestamp (integer, non-negative)
  endTime?: number;      // Unix timestamp (integer, non-negative; 0 = indefinite)
}
```

**Required headers:**

| Header | Format | Example |
|---|---|---|
| `Authorization` | `Bearer <jwt>` | `Bearer eyJ...` |
| `Idempotency-Key` | 1–128 chars, `[A-Za-z0-9:_-]` | `550e8400-e29b-41d4-a716-446655440000` |

**Response** (`201 Created`):

```typescript
{
  success: true,
  data: {
    id: string;           // stream-{txHash}-{eventIndex}
    sender: string;       // Stellar public key
    recipient: string;    // Stellar public key
    depositAmount: string; // Decimal string
    ratePerSecond: string; // Decimal string
    startTime: number;    // Unix timestamp
    endTime: number;      // Unix timestamp (0 = indefinite)
    status: "active" | "paused" | "completed" | "cancelled";
  }
}
```

**Response headers:**

| Header | Value |
|---|---|
| `Idempotency-Key` | Echoes the client-supplied key |
| `Idempotency-Replayed` | `"true"` on cache replay, `"false"` on first creation |

#### `GET /api/streams` — List Streams

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | integer 1–100 | `50` | Page size |
| `cursor` | string | — | Opaque base64 pagination token |
| `status` | `active\|paused\|completed\|cancelled` | — | Filter by status |
| `sender` | Stellar public key | — | Filter by sender address |
| `recipient` | Stellar public key | — | Filter by recipient address |
| `includeTotal` | boolean | `false` | Include total count |

**Response** (`200 OK`):

```typescript
{
  success: true,
  data: {
    streams: Stream[];    // Array of stream objects (same shape as POST response)
    has_more: boolean;    // Whether more pages exist
    next_cursor?: string; // Opaque base64 token; absent when has_more is false
    total?: number;       // Present only when includeTotal=true
  }
}
```

> **Cursor stability:** The cursor format is `base64(JSON({ v: 1, lastId: string }))`. The `v: 1` version tag is a stable discriminant. If the cursor format changes, the version tag will increment and old cursors will return a `400 VALIDATION_ERROR` rather than silently returning wrong results.

#### `GET /api/streams/:id` — Get Stream

**Response** (`200 OK`): Same `Stream` shape as above.

#### `DELETE /api/streams/:id` — Cancel Stream

**Response** (`200 OK`):

```typescript
{
  success: true,
  data: {
    message: "Stream cancelled";
    id: string;
  }
}
```

#### `GET /health` — Health Check

**Response** (`200 OK` or `503 Service Unavailable`):

```typescript
{
  success: true,
  data: {
    status: "ok" | "degraded" | "shutting_down";
    service: "fluxora-backend";
    network: string;
    contractAddresses: Record<string, string>;
    timestamp: string;  // ISO-8601
    indexer: IndexerHealthSnapshot;
  }
}
```

---

### 3.3 Error Codes

Every error response uses this envelope:

```typescript
{
  success: false,
  error: {
    code: ApiErrorCode;   // Machine-readable string — stable
    message: string;      // Human-readable — NOT stable, do not parse
    details?: unknown;    // Optional structured context — shape may change
    requestId?: string;   // Correlation ID for log lookup
  }
}
```

> **Rule:** Integrators MUST key on `error.code`, never on `error.message`. Messages are for humans and may be reworded in any release.

#### Stable Error Codes (`ApiErrorCode`)

| Code | HTTP Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Malformed input — missing field, wrong type, invalid format |
| `DECIMAL_ERROR` | 400 | Amount field failed decimal-string validation |
| `NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | Idempotency-Key collision, duplicate cancel, or invalid state transition |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication token |
| `FORBIDDEN` | 403 | Authenticated but insufficient permissions |
| `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds 256 KiB |
| `TOO_MANY_REQUESTS` | 429 | Rate limit exceeded |
| `METHOD_NOT_ALLOWED` | 405 | HTTP method not supported on this path |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `SERVICE_UNAVAILABLE` | 503 | Dependency (DB, Redis, Stellar RPC) is down |

#### Stable Decimal Error Codes (`DecimalErrorCode`)

These appear in `error.details.decimalErrorCode` when `error.code === "DECIMAL_ERROR"`:

| Code | Meaning |
|---|---|
| `DECIMAL_INVALID_TYPE` | Amount was not a string |
| `DECIMAL_INVALID_FORMAT` | String did not match `/^[+-]?\d+(\.\d+)?$/` |
| `DECIMAL_OUT_OF_RANGE` | Value exceeds `Number.MAX_SAFE_INTEGER` |
| `DECIMAL_EMPTY_VALUE` | Amount was `null`, `undefined`, or empty string |
| `DECIMAL_PRECISION_EXCEEDED` | More than 7 decimal places (Stellar precision limit) |
| `DECIMAL_PRECISION_LOSS` | Floating-point precision loss detected |

---

### 3.4 Event Schemas

#### Contract Event Record (Indexer Ingest)

Submitted to `POST /internal/indexer/contract-events` as `{ events: ContractEventRecord[] }`.

```typescript
interface ContractEventRecord {
  eventId: string;          // Unique event ID, max 128 chars — stable discriminant
  ledger: number;           // Non-negative integer ledger sequence
  contractId: string;       // Soroban contract ID, max 128 chars
  topic: string;            // Event topic string, max 128 chars
  txHash: string;           // Transaction hash, max 128 chars
  txIndex: number;          // Non-negative integer
  operationIndex: number;   // Non-negative integer
  eventIndex: number;       // Non-negative integer
  payload: Record<string, unknown>; // Arbitrary JSON object
  happenedAt: string;       // ISO-8601 timestamp
  ledgerHash: string;       // Ledger hash for reorg detection, max 128 chars
}
```

**Batch constraints (stable):**

| Constraint | Value |
|---|---|
| Minimum events per batch | 1 |
| Maximum events per batch | 100 |
| Duplicate `eventId` within a batch | Rejected with `409 CONFLICT` |

#### Stream Events (WebSocket / Internal)

These are the typed events emitted by `streamEventService` and broadcast over `ws://<host>/ws/streams`.

```typescript
// A new stream was created on-chain
interface StreamCreatedEvent {
  type: "StreamCreated";
  contractId: string;
  transactionHash: string;
  eventIndex: number;
  sender: string;
  recipient: string;
  amount: string;          // Decimal string
  ratePerSecond: string;   // Decimal string
  startTime: number;
  endTime: number;
}

// An existing stream was updated on-chain
interface StreamUpdatedEvent {
  type: "StreamUpdated";
  contractId: string;
  transactionHash: string;
  eventIndex: number;
  streamId: string;
  streamedAmount?: string;  // Decimal string
  remainingAmount?: string; // Decimal string
  status?: StreamStatus;
  endTime?: number;
}

// A stream was cancelled on-chain
interface StreamCancelledEvent {
  type: "StreamCancelled";
  contractId: string;
  transactionHash: string;
  eventIndex: number;
  streamId: string;
}
```

**WebSocket message envelope** (broadcast to all connected clients):

```typescript
{
  event: "stream.created" | "stream.updated" | "stream.cancelled" | "service.degraded";
  streamId: string;
  payload: Record<string, unknown>;
  timestamp: string; // ISO-8601
}
```

The `event` string values (`stream.created`, `stream.updated`, `stream.cancelled`, `service.degraded`) are **stable discriminants**. Consumers MUST switch on `event` to determine how to handle a message.

#### Indexer Health Snapshot

Returned inside `GET /health` under the `indexer` key:

```typescript
interface IndexerHealthSnapshot {
  dependency: "healthy" | "degraded" | "unavailable"; // stable discriminant
  store: "memory" | "postgres";                        // stable discriminant
  lastSuccessfulIngestAt: string | null;  // ISO-8601 or null
  lastFailureAt: string | null;           // ISO-8601 or null
  lastFailureReason: string | null;       // Human-readable — NOT stable
  acceptedBatchCount: number;
  acceptedEventCount: number;
  duplicateEventCount: number;
  lastSafeLedger: number;
  reorgDetected: boolean;
  reorgHeight?: number;
}
```

---

### 3.5 Storage Discriminants

These enum values are persisted to the database and used as type tags. Changing them is a **breaking change** because existing rows would become unreadable without a migration.

#### `StreamStatus` — `streams.status` column

```
"active" | "paused" | "completed" | "cancelled"
```

**State machine (stable):**

```
active ──► paused ──► active
  │           │
  ▼           ▼
completed  cancelled   ← terminal states
```

| Transition | Allowed |
|---|---|
| `active` → `paused` | ✅ |
| `active` → `completed` | ✅ |
| `active` → `cancelled` | ✅ |
| `paused` → `active` | ✅ |
| `paused` → `cancelled` | ✅ |
| `completed` → any | ❌ terminal |
| `cancelled` → any | ❌ terminal |

Any invalid transition returns `409 CONFLICT` with `error.code === "CONFLICT"`.

#### `IndexerDependencyState` — health snapshot `dependency` field

```
"healthy" | "degraded" | "unavailable"
```

#### `IndexerStoreKind` — health snapshot `store` field

```
"memory" | "postgres"
```

#### Stream ID Format

```
stream-{transactionHash}-{eventIndex}
```

This format is derived deterministically from chain data. The prefix `stream-` and the `-` separator are stable. Integrators may store and parse stream IDs.

---

### 3.6 Decimal-String Serialization Contract

All monetary amounts cross the chain/API boundary as **decimal strings**. This is a hard invariant.

**Stable rules:**

1. All amount fields in JSON responses are `string`, never `number`.
2. The accepted format is `/^[+-]?\d+(\.\d+)?$/`.
3. Stellar precision is 7 decimal places (`0.0000001` = 1 stroop = `10^-7` XLM).
4. Zero serializes as `"0"`, never omitted or `null`.
5. Sending a JSON `number` for any amount field returns `400 DECIMAL_ERROR`.
6. The `STROOPS_PER_UNIT` constant is `10_000_000` (stable).

**Affected fields:**

| Field | Location |
|---|---|
| `depositAmount` | `POST /api/streams` request and all stream responses |
| `ratePerSecond` | `POST /api/streams` request and all stream responses |
| `amount` | `StreamCreatedEvent`, `StreamRecord.amount` |
| `streamed_amount` | `StreamRecord`, `StreamUpdatedEvent.streamedAmount` |
| `remaining_amount` | `StreamRecord`, `StreamUpdatedEvent.remainingAmount` |
| `rate_per_second` | `StreamRecord` |

---

### 3.7 Idempotency Contract

`POST /api/streams` requires an `Idempotency-Key` header. The following behaviors are stable:

| Scenario | Behavior |
|---|---|
| Same key + same body | `201` with `Idempotency-Replayed: true` |
| Same key + different body | `409 CONFLICT` |
| Missing key | `400 VALIDATION_ERROR` |
| Malformed key (bad charset or length) | `400 VALIDATION_ERROR` |

**Key format (stable):**

- Length: 1–128 characters
- Charset: `[A-Za-z0-9:_-]`
- UUID v4 is recommended but not required

The key value is never echoed in error response bodies or server logs.

---

### 3.8 Webhook Signature Contract

Fluxora webhook deliveries carry these headers. The signing algorithm is stable:

| Header | Description |
|---|---|
| `x-fluxora-delivery-id` | Stable delivery ID for deduplication |
| `x-fluxora-timestamp` | Unix timestamp in seconds (string) |
| `x-fluxora-signature` | `HMAC-SHA256(secret, timestamp + "." + rawBody)` — 64-char hex |
| `x-fluxora-event` | Event name, e.g. `stream.created` |

**Signing payload:**

```
${timestamp}.${rawRequestBody}
```

**Stable verification rules:**

- Use raw request bytes exactly as received.
- Reject payloads larger than 256 KiB.
- Reject timestamps outside a 300-second tolerance window.
- Compare signatures with a constant-time equality check.
- Deduplicate on `x-fluxora-delivery-id`.

---

## 4. Breaking vs. Non-Breaking Changes

### 4.1 Breaking Changes (require major version bump)

The following changes are **always breaking** and require a major version bump plus a deprecation window:

#### Entrypoints

- Removing a stable route (path + method combination).
- Changing the HTTP method of a stable route (e.g., `POST` → `PUT`).
- Changing a path parameter format (e.g., renaming `:id` or changing the `stream-` prefix).
- Adding a new **required** header to an existing route.
- Changing the base path of a stable route.

#### Request Schemas

- Removing a previously accepted request field.
- Making an optional field required.
- Narrowing the accepted type of a field (e.g., accepting `string | number` → `string` only).
- Changing the validation regex for a stable field (e.g., `STELLAR_PUBLIC_KEY_REGEX`, `DECIMAL_STRING_REGEX`, `IDEMPOTENCY_KEY_REGEX`).

#### Response Schemas

- Removing a field from a response object.
- Renaming a field in a response object.
- Changing the type of a field (e.g., `string` → `number`).
- Changing the decimal-string invariant (e.g., returning numbers for amount fields).
- Changing the stream ID format.
- Changing the cursor format without incrementing the `v` version tag.

#### Error Codes

- Removing a stable `ApiErrorCode` value.
- Renaming a stable `ApiErrorCode` value.
- Changing the HTTP status code associated with a stable error code.
- Removing a `DecimalErrorCode` value.

#### Event Schemas

- Removing a field from `ContractEventRecord`.
- Renaming a field in `ContractEventRecord`.
- Changing the type of a field in `ContractEventRecord`.
- Removing a `StreamEvent` type (`StreamCreated`, `StreamUpdated`, `StreamCancelled`).
- Renaming the `type` discriminant of a `StreamEvent`.
- Removing a WebSocket event name (`stream.created`, `stream.updated`, `stream.cancelled`).
- Changing the WebSocket message envelope shape.
- Reducing the maximum batch size below 100.

#### Storage Discriminants

- Removing a `StreamStatus` value.
- Renaming a `StreamStatus` value.
- Changing the stream status state machine (removing a valid transition).
- Removing an `IndexerDependencyState` value.
- Removing an `IndexerStoreKind` value.

#### Serialization

- Changing the decimal-string format regex.
- Changing `STELLAR_DECIMALS` (7) or `STROOPS_PER_UNIT` (10,000,000).
- Returning numeric JSON for any amount field.

#### Idempotency

- Changing the `Idempotency-Key` charset or length limits.
- Changing the behavior of same-key + same-body (must remain `201` replay).
- Changing the behavior of same-key + different-body (must remain `409`).

#### Webhook Signatures

- Changing the HMAC algorithm (currently SHA-256).
- Changing the signing payload format (`timestamp.rawBody`).
- Renaming any of the four `x-fluxora-*` headers.
- Changing the timestamp tolerance window (currently 300 seconds).

---

### 4.2 Non-Breaking Changes (allowed in minor/patch)

The following changes are **safe** and do not require a major version bump:

#### Entrypoints

- Adding a new route.
- Adding a new optional query parameter to an existing `GET` route.
- Adding a new optional response header.

#### Request Schemas

- Adding a new optional request field.
- Widening the accepted type of a field (e.g., accepting additional formats).
- Relaxing a validation constraint (e.g., increasing a max-length limit).

#### Response Schemas

- Adding a new optional field to a response object.
- Adding a new value to an open-ended `string` field that is not a discriminant.

#### Error Codes

- Adding a new `ApiErrorCode` value.
- Adding a new `DecimalErrorCode` value.
- Adding new fields to `error.details`.
- Rewording `error.message` (messages are not stable).

#### Event Schemas

- Adding a new optional field to `ContractEventRecord`.
- Adding a new `StreamEvent` type with a new `type` discriminant.
- Adding a new WebSocket event name.
- Increasing the maximum batch size above 100.

#### Storage Discriminants

- Adding a new `StreamStatus` value (with a documented migration path).
- Adding a new `IndexerDependencyState` value.
- Adding a new `IndexerStoreKind` value.

#### Internal Behavior

- Changing log message text.
- Changing internal metric names.
- Changing the in-memory idempotency store to Redis (same observable behavior).
- Changing database indexes (no observable API change).
- Changing rate-limit defaults (documented in changelog).

---

## 5. Deprecation Process

1. **Announce** — The deprecated surface is marked in the changelog and in this document with a `⚠️ DEPRECATED` notice and a target removal version.
2. **Grace period** — A minimum of **90 days** (or one major release cycle, whichever is longer) before removal.
3. **Response header** — Deprecated endpoints return a `Deprecation: true` header and a `Sunset: <date>` header (RFC 8594).
4. **Remove** — The surface is removed in the next major version. The upgrade guide in [`docs/upgrade.md`](./upgrade.md) documents the migration path.

---

## 6. Internal and Admin Surfaces

The following surfaces are **not covered** by the stability guarantees in this document:

| Surface | Stability |
|---|---|
| `/api/admin/*` | Best-effort; may change in minor versions |
| `/admin/dlq/*` | Best-effort; may change in minor versions |
| `/api/audit/*` | Best-effort; may change in minor versions |
| `/api/rate-limits/*` | Best-effort; may change in minor versions |
| `/__test/*` | No stability guarantee; test-only |
| Environment variable names | Documented in README; may change in minor versions with notice |
| Database schema internals | Internal; only the discriminant values listed in §3.5 are stable |
| Log message text | No stability guarantee |
| Internal TypeScript types not exported in a public module | No stability guarantee |

---

## 7. Stability by Surface Summary

| Surface | Stable Since | Guarantee Level |
|---|---|---|
| Public HTTP routes (§3.1) | `0.1.0` | Breaking change → major bump |
| Stream request/response schema (§3.2) | `0.1.0` | Breaking change → major bump |
| Error codes `ApiErrorCode` (§3.3) | `0.1.0` | Breaking change → major bump |
| Decimal error codes `DecimalErrorCode` (§3.3) | `0.1.0` | Breaking change → major bump |
| `ContractEventRecord` schema (§3.4) | `0.1.0` | Breaking change → major bump |
| `StreamEvent` types and discriminants (§3.4) | `0.1.0` | Breaking change → major bump |
| WebSocket event names (§3.4) | `0.1.0` | Breaking change → major bump |
| `StreamStatus` values and state machine (§3.5) | `0.1.0` | Breaking change → major bump |
| `IndexerDependencyState` values (§3.5) | `0.1.0` | Breaking change → major bump |
| `IndexerStoreKind` values (§3.5) | `0.1.0` | Breaking change → major bump |
| Stream ID format (§3.5) | `0.1.0` | Breaking change → major bump |
| Decimal-string serialization rules (§3.6) | `0.1.0` | Breaking change → major bump |
| Idempotency contract (§3.7) | `0.1.0` | Breaking change → major bump |
| Webhook signature algorithm (§3.8) | `0.1.0` | Breaking change → major bump |
| Admin/internal routes (§6) | — | Best-effort |

---

*See [`docs/upgrade.md`](./upgrade.md) for migration guides between versions.*
