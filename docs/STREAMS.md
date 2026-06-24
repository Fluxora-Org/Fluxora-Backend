# Streams — Feature Documentation

## Overview

Streams are durable, PostgreSQL-backed records that represent on-chain payment streams from the
Stellar Soroban contract.  All list / get / create / cancel operations go through
`src/db/repositories/streamRepository.ts` — there is no in-memory fallback.

---

## 1. Database Schema

### Table: `streams`

| Column             | Type        | Constraints                                      | Description                                      |
|--------------------|-------------|--------------------------------------------------|--------------------------------------------------|
| `id`               | TEXT        | PRIMARY KEY                                      | Derived from `stream-{txHash}-{eventIndex}`      |
| `sender_address`   | TEXT        | NOT NULL                                         | Stellar address of the sender                    |
| `recipient_address`| TEXT        | NOT NULL                                         | Stellar address of the recipient                 |
| `amount`           | TEXT        | NOT NULL, CHECK decimal-string                   | Total deposit amount (decimal string)            |
| `streamed_amount`  | TEXT        | NOT NULL DEFAULT '0', CHECK decimal-string       | Amount streamed so far                           |
| `remaining_amount` | TEXT        | NOT NULL, CHECK decimal-string                   | Remaining amount                                 |
| `rate_per_second`  | TEXT        | NOT NULL, CHECK decimal-string                   | Streaming rate per second                        |
| `start_time`       | BIGINT      | NOT NULL, CHECK >= 0                             | Unix epoch seconds                               |
| `end_time`         | BIGINT      | NOT NULL DEFAULT 0, CHECK >= 0                   | Unix epoch seconds (0 = indefinite)              |
| `status`           | TEXT        | NOT NULL DEFAULT 'active', CHECK enum            | active / paused / completed / cancelled          |
| `contract_id`      | TEXT        | NOT NULL                                         | Soroban contract ID                              |
| `transaction_hash` | TEXT        | NOT NULL                                         | Transaction hash that created the stream         |
| `event_index`      | INTEGER     | NOT NULL                                         | Event index within the transaction               |
| `created_at`       | TIMESTAMPTZ | NOT NULL DEFAULT NOW()                           | Record creation timestamp                        |
| `updated_at`       | TIMESTAMPTZ | NOT NULL DEFAULT NOW()                           | Last update timestamp                            |

**Unique constraint:** `(transaction_hash, event_index)` — guarantees idempotent event ingestion.

### Indexes

Composite indexes match the filter+order patterns issued by `streamRepository`:

| Index                              | Column(s)                    | Repository method | Query pattern                                |
|------------------------------------|------------------------------|-------------------|----------------------------------------------|
| `idx_streams_status_id`            | `(status, id)`               | `findWithCursor`  | `WHERE status = $1 … ORDER BY id ASC`        |
| `idx_streams_sender_id`            | `(sender_address, id)`       | `findWithCursor`  | `WHERE sender_address = $1 … ORDER BY id ASC`|
| `idx_streams_contract_id`          | `(contract_id, id)`          | `findWithCursor`  | `WHERE contract_id = $1 … ORDER BY id ASC`    |
| `idx_streams_status_created_at_desc`| `(status, created_at DESC)` | `find`            | `WHERE status = $1 ORDER BY created_at DESC` |
| `idx_streams_recipient`            | `recipient_address`          | `findWithCursor`  | Recipient filter (single-column)             |
| `idx_streams_created_at`           | `created_at`                 | `find`            | Unfiltered `ORDER BY created_at DESC`        |
| `idx_streams_start_time`           | `start_time`                 | `find`            | `start_time` range filters                   |
| `idx_streams_end_time`             | `end_time`                   | `find`            | `end_time` range filters                     |

Existing deployments receive these indexes via `migrations/20260622000000_streams_composite_pagination_indexes.ts`
using `CREATE INDEX CONCURRENTLY` (non-transactional migration — no write locks during build).
Redundant single-column indexes (`idx_streams_status`, `idx_streams_sender`, `idx_streams_contract`) are dropped
once the composites exist because their leading column is a left-prefix of the new indexes.

**Security:** Index additions do not change which rows are visible. Address columns are equality-filtered only;
no index sorts by encrypted/hashed address values, so no timing side-channel is introduced.

---

## 2. Decimal-String Invariant

All monetary amounts cross the chain/API boundary as **decimal strings** (e.g. `"1000"`,
`"0.0000116"`).  This prevents JSON floating-point precision loss.

- DB CHECK constraints enforce the format at the storage layer.
- Zod schemas (`src/validation/schemas.ts`) enforce it at the HTTP boundary.
- `src/serialization/decimal.ts` provides helpers for validation and display.
- Numeric types in request bodies are **rejected with 400**.

---

## 3. API ↔ DB Field Mapping

The HTTP API uses camelCase; the database uses snake_case.  The `toApiStream()` function in
`src/routes/streams.ts` performs the mapping:

| API field       | DB column          |
|-----------------|--------------------|
| `id`            | `id`               |
| `sender`        | `sender_address`   |
| `recipient`     | `recipient_address`|
| `depositAmount` | `amount`           |
| `ratePerSecond` | `rate_per_second`  |
| `startTime`     | `start_time`       |
| `endTime`       | `end_time`         |
| `status`        | `status`           |

---

## 4. Status State Machine

```
active ──► paused ──► active
  │           │
  ▼           ▼
completed  cancelled  (terminal)
```

| From \ To   | active | paused | completed | cancelled |
|-------------|--------|--------|-----------|-----------|
| active      | ✗      | ✓      | ✓         | ✓         |
| paused      | ✓      | ✗      | ✗         | ✓         |
| completed   | ✗      | ✗      | ✗         | ✗         |
| cancelled   | ✗      | ✗      | ✗         | ✗         |

`completed` and `cancelled` are **terminal** — no further transitions are permitted.

Invalid transitions return `409 CONFLICT`:

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Stream is already completed and cannot be transitioned",
    "details": { "streamId": "...", "currentStatus": "completed" }
  }
}
```

---

## 5. API Endpoints

### GET /api/streams

List streams with cursor-based pagination.

**Query parameters:**

| Parameter       | Type    | Default | Description                                  |
|-----------------|---------|---------|----------------------------------------------|
| `limit`         | integer | 50      | Results per page (1–100)                     |
| `cursor`        | string  | —       | Opaque pagination token from previous response|
| `include_total` | boolean | false   | Include total count (may be expensive)       |

**Response:**
```json
{
  "success": true,
  "data": {
    "streams": [...],
    "has_more": true,
    "next_cursor": "<opaque>",
    "total": 100
  },
  "meta": { "timestamp": "..." }
}
```

- `total` is only present when `include_total=true`. It reflects the current count at response time and is not a snapshot guarantee.
- `next_cursor` is only present when `has_more` is `true`.

**Indexed filters:**

The `status`, `sender`, and `contract_id` cursor filters use composite indexes
(`idx_streams_status_id`, `idx_streams_sender_id`, `idx_streams_contract_id`) so filtered pages
avoid full-table sorts. The `recipient` filter uses `idx_streams_recipient`. Offset pagination with
a `status` filter uses `idx_streams_status_created_at_desc`. Combining filters with cursor pagination
is safe — the cursor position is relative to the filtered result set.

### GET /api/streams/:id

Get a single stream by ID.

**Responses:** `200 OK` | `404 NOT_FOUND` | `503 SERVICE_UNAVAILABLE`

### HEAD /api/streams/:id

Check whether a stream exists without fetching the full record.

**Success response:** `200 OK`

**Headers:**

- `ETag` - Weak validator derived from the stream ID and last update timestamp
- `Last-Modified` - Timestamp of the last DB update for the stream

**Responses:** `200 OK` | `404 NOT_FOUND` | `503 SERVICE_UNAVAILABLE`

### POST /api/streams

Create a new stream.  Requires `Authorization: Bearer <token>` and `Idempotency-Key` header.

**Request body:**
```json
{
  "sender":        "G...",
  "recipient":     "G...",
  "depositAmount": "1000",
  "ratePerSecond": "10",
  "startTime":     1700000000,
  "endTime":       0
}
```

**Responses:** `201 Created` | `400 VALIDATION_ERROR` | `401 UNAUTHORIZED` | `409 CONFLICT` | `503 SERVICE_UNAVAILABLE`

### DELETE /api/streams/:id

Cancel a stream.  Requires authentication.

**Responses:** `200 OK` | `404 NOT_FOUND` | `409 CONFLICT` | `503 SERVICE_UNAVAILABLE`

### PATCH /api/streams/:id/status

Transition a stream to a new status.

**Request body:** `{ "status": "paused" | "active" | "completed" | "cancelled" }`

**Responses:** `200 OK` | `400 VALIDATION_ERROR` | `404 NOT_FOUND` | `409 CONFLICT` | `503 SERVICE_UNAVAILABLE`

---

## 6. Idempotency

`POST /api/streams` requires an `Idempotency-Key` header (1–128 chars, `[A-Za-z0-9:_-]`).

- First request: creates the stream, returns `201`, sets `Idempotency-Replayed: false`.
- Repeat with same key + same body: returns cached `201`, sets `Idempotency-Replayed: true`.
- Same key + different body: returns `409 CONFLICT`.

The idempotency store is currently in-memory (Redis-backed in production).

At the DB layer, `upsertStream` uses `INSERT … ON CONFLICT DO NOTHING` on
`(transaction_hash, event_index)` for safe blockchain event replay.

---

## 7. Trust Boundaries

| Client Type        | Access                                    | Auth required |
|--------------------|-------------------------------------------|---------------|
| Public users       | `GET /api/streams`, `GET /api/streams/:id`, `HEAD /api/streams/:id`| No            |
| Authenticated users| `POST`, `DELETE`, `PATCH /status`         | JWT Bearer    |
| Internal workers   | Indexer ingestion via `upsertStream`      | Service account|

---

## 8. Failure Modes

| Scenario              | HTTP Status | Error Code           |
|-----------------------|-------------|----------------------|
| Invalid input         | 400         | `VALIDATION_ERROR`   |
| Missing auth          | 401         | `UNAUTHORIZED`       |
| Stream not found      | 404         | `NOT_FOUND`          |
| Invalid transition    | 409         | `CONFLICT`           |
| Idempotency conflict  | 409         | `CONFLICT`           |
| DB pool exhausted     | 503         | `SERVICE_UNAVAILABLE`|
| Dependency down       | 503         | `SERVICE_UNAVAILABLE`|

---

## 9. Running Tests

```bash
# All tests
pnpm test

# With coverage (target ≥ 95%)
pnpm test:coverage

# Specific suites
pnpm test tests/routes/streams.test.ts
pnpm test tests/streamsRepository.test.ts
```

---

## 10. Files

| File                                              | Purpose                                      |
|---------------------------------------------------|----------------------------------------------|
| `src/db/types.ts`                                 | TypeScript types for DB records              |
| `src/db/pool.ts`                                  | PostgreSQL connection pool + query helper    |
| `src/db/migrations/001_create_streams_table.ts`   | PostgreSQL DDL migration                     |
| `src/db/repositories/streamRepository.ts`         | All DB operations for streams                |
| `src/routes/streams.ts`                           | HTTP route handlers                          |
| `src/validation/schemas.ts`                       | Zod input validation schemas                 |
| `src/serialization/decimal.ts`                    | Decimal-string helpers                       |
| `tests/routes/streams.test.ts`                    | Route integration tests (mocked DB)          |
| `tests/streamsRepository.test.ts`                 | Repository unit tests (mocked pool)          |
