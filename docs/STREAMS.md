# Fluxora Backend - Streams Feature Documentation

## Overview

This document describes the streams database table that maps on-chain streaming events from the Stellar Soroban blockchain to the backend database.

---

## 1. Schema Design

### Database Table: `streams`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Unique identifier derived from `transaction_hash` + `event_index` |
| `sender_address` | TEXT | NOT NULL | Stellar address of the sender |
| `recipient_address` | TEXT | NOT NULL | Stellar address of the recipient |
| `amount` | TEXT | NOT NULL | Total streaming amount (decimal string) |
| `streamed_amount` | TEXT | NOT NULL DEFAULT '0' | Amount streamed so far |
| `remaining_amount` | TEXT | NOT NULL | Remaining amount to stream |
| `rate_per_second` | TEXT | NOT NULL | Streaming rate per second |
| `start_time` | INTEGER | NOT NULL | Unix timestamp when stream starts |
| `end_time` | INTEGER | NOT NULL DEFAULT 0 | Unix timestamp when stream ends (0 = indefinite) |
| `status` | TEXT | NOT NULL DEFAULT 'active' | Stream status (active/paused/completed/cancelled) |
| `contract_id` | TEXT | NOT NULL | Soroban contract ID |
| `transaction_hash` | TEXT | NOT NULL | Transaction hash that created the stream |
| `event_index` | INTEGER | NOT NULL | Event index within the transaction |
| `created_at` | TEXT | NOT NULL | When the record was created |
| `updated_at` | TEXT | NOT NULL | When the record was last updated |

### Indexes

- `idx_streams_status` - For filtering by status
- `idx_streams_sender` - For sender lookups
- `idx_streams_recipient` - For recipient lookups
- `idx_streams_contract` - For contract-scoped queries
- `idx_streams_created_at` - For time-based queries

---

## 2. Service-Level Guarantees

### Invariants (What "Correct" Data Means)

1. **ID Uniqueness**: Each stream has a unique ID derived deterministically from `stream-{txHash}-{eventIndex}`
2. **Amount Precision**: All monetary amounts are stored as decimal strings (never floating point)
3. **Status Transitions**: Valid state machine enforced at the API layer — invalid transitions return `409 CONFLICT`
4. **Audit Trail**: `created_at` and `updated_at` are always populated

### API-Layer Status State Machine

```
scheduled ──► active ──► paused ──► active
    │            │           │
    ▼            ▼           ▼
cancelled    completed   cancelled
             (terminal)  (terminal)
```

| From \ To   | scheduled | active | paused | completed | cancelled |
|-------------|-----------|--------|--------|-----------|-----------|
| scheduled   | ✗         | ✓      | ✗      | ✗         | ✓         |
| active      | ✗         | ✗      | ✓      | ✓         | ✓         |
| paused      | ✗         | ✓      | ✗      | ✗         | ✓         |
| completed   | ✗         | ✗      | ✗      | ✗         | ✗         |
| cancelled   | ✗         | ✗      | ✗      | ✗         | ✗         |

`completed` and `cancelled` are **terminal** — no further transitions are permitted.

Any attempt to transition to an invalid target status returns:

```json
HTTP 409 Conflict
{
  "error": {
    "code": "CONFLICT",
    "message": "Stream is already completed and cannot be transitioned",
    "details": { "streamId": "...", "currentStatus": "completed", "requestedStatus": "active" }
  }
}
```

### Data Finality

- **Final**: Data is considered final once the transaction is confirmed on Stellar (typically 3-5 seconds)
- **Pending**: Events that haven't been confirmed are not stored
- **Stale Data**: No automatic staleness handling - events are reprocessed on chain reorgs

---

## 3. Trust Boundaries

| Client Type | Access | Authorization |
|-------------|--------|---------------|
| Public users | Read-only (`GET /api/streams`, `GET /api/streams/:id`) | None required |
| Authenticated users | Limited scoped access | Token-based |
| Admins | Full access | Role-based |
| Internal workers | Ingestion + status updates | Service account |

---

## 4. Failure Modes & Behavior

| Scenario | Expected Behavior |
|----------|-------------------|
| Invalid input | 400 with clear error message |
| Duplicate event | Ignored (idempotent upsert) |
| DB outage | 503 + retry-safe response |
| RPC failure | Partial ingestion + retry queue |
| Oversized payload | 413 with limit error |
| High request rate | 429 with rate limit |

---

## 5. API Endpoints

### GET /api/streams

List streams with cursor-based pagination and indexed filters.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer (1–100) | 50 | Max results per page |
| `cursor` | string | — | Opaque token from `next_cursor` in a previous response |
| `include_total` | boolean | false | Include a `total` count in the response |
| `status` | string | — | Filter by status: `scheduled`, `active`, `paused`, `completed`, `cancelled` |
| `sender` | string | — | Filter by sender Stellar address |
| `recipient` | string | — | Filter by recipient Stellar address |

**Pagination model:**

Streams are ordered by `id ASC` (stable lexicographic order). The cursor encodes the last seen `id` as a base64url token. Passing it on the next request returns only records with `id > cursor`, so pages are consistent even when new streams are inserted between requests.

```
GET /api/streams?limit=2
→ { streams: [...], has_more: true, next_cursor: "eyJ2IjoxLCJsYXN0SWQiOiJzdHJlYW0tMTIzIn0" }

GET /api/streams?limit=2&cursor=eyJ2IjoxLCJsYXN0SWQiOiJzdHJlYW0tMTIzIn0
→ { streams: [...], has_more: false }
```

**Response:**
```json
{
  "streams": [...],
  "has_more": true,
  "next_cursor": "<opaque token>",
  "total": 42
}
```

- `total` is only present when `include_total=true`. It reflects the current count at response time and is not a snapshot guarantee.
- `next_cursor` is only present when `has_more` is `true`.

**Indexed filters:**

The `status`, `sender`, and `recipient` filters map directly to database indexes (`idx_streams_status`, `idx_streams_sender`, `idx_streams_recipient`). Combining filters with cursor pagination is safe — the cursor position is relative to the filtered result set.

### GET /api/streams/:id

Get a single stream by ID.

### PATCH /api/streams/:id/status

Transition a stream to a new status. Returns `409 CONFLICT` when the transition
is not permitted by the state machine (see table above).

**Request body:**
```json
{ "status": "paused" }
```

**Responses:**
- `200` — stream updated, full stream object returned
- `400` — unknown status value
- `404` — stream not found
- `409` — invalid transition (terminal status or disallowed edge)

---

## 6. Event Mapping (Blockchain → DB)

### Event Types

1. **StreamCreated** - New stream created on chain
2. **StreamUpdated** - Stream state updated (amounts, status)
3. **StreamCancelled** - Stream cancelled

### Idempotency

- Each event is identified by `transaction_hash` + `event_index`
- Same event processed twice results in no change (safe retry)
- Out-of-order events are handled via upsert logic

---

## 7. Observability

### Metrics

- `eventsIngested` - Total events successfully ingested
- `eventsFailed` - Total events that failed
- `eventsIgnored` - Duplicate events ignored
- `ingestionRate` - Events per second
- `failureRate` - Failures per second
- `avgDbLatency` - Average database operation latency
- `chainLagMs` - Lag between blockchain and database

### Health Endpoints

- `GET /health` - Basic liveness
- `GET /health/ready` - Readiness with DB and metrics checks
- `GET /health/metrics` - Current metrics snapshot

---

## 8. Runbook

### How to Detect Ingestion Lag

1. Check `/health/metrics` for `chainLagMs`
2. If lag > 5 minutes, investigate RPC connectivity
3. Check logs for ingestion failures

### How to Replay Events

1. Events are stored with `transaction_hash` + `event_index`
2. To replay, call the event processor with the same event data
3. Idempotency ensures no duplicates

### Known Limitations

- SQLite database (not production-grade for high concurrency)
- No real-time event subscription (polling-based)
- Single-node deployment only

---

## 9. Testing

Run tests with:
```bash
npm test
```

Run with coverage:
```bash
npm run test:coverage
```

Target: ≥95% coverage on new modules.

---

## 10. Files

- `src/db/types.ts` - Database types and invariants
- `src/db/connection.ts` - Database connection management
- `src/db/migrate.ts` - Migration runner
- `src/db/migrations/001_create_streams_table.ts` - Schema migration
- `src/db/repositories/streamRepository.ts` - Stream CRUD operations
- `src/services/streamEventService.ts` - Event processing service
- `src/metrics/index.ts` - Metrics tracking
- `src/routes/streams.ts` - API endpoints