# Audit Log API

Two read endpoints sit over the audit trail. They share one filter vocabulary
but read from different places, and the difference matters when you are
answering a compliance request.

| | `GET /api/audit` | `GET /api/audit/export` |
| :--- | :--- | :--- |
| Source | Process-local in-memory ring (`src/lib/auditLog.ts`) | Durable `audit_logs` table in Postgres |
| Scope | Recent activity **on this instance** | Every row every instance ever committed |
| Shape | Paginated JSON envelope | Streamed CSV or NDJSON |
| Ceiling | `limit` ≤ 100 per page | Unbounded; memory-safe by construction |
| Use it for | Live operational spot-checks | Offline review, evidence packs, retention exports |

Both require a JWT carrying `Permission.AUDIT_READ` (`audit:read`), held by the
`admin` and `operator` roles.

---

## `GET /api/audit`

Returns a page of in-memory audit entries.

### Query parameters

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `limit` | integer | Page size, 1–100. Default 20. |
| `offset` | integer | Zero-based offset. Default 0. |
| `actor` | string | Matches `meta.actor` (or a top-level `actor`). |
| `actionType` | string | Exact action, e.g. `STREAM_CREATED`. |
| `resourceType` | string | Exact resource type, e.g. `stream`. |
| `resourceId` | string | Exact resource id. |
| `dateFrom` | string | ISO-8601 lower bound (inclusive). |
| `dateTo` | string | ISO-8601 upper bound (inclusive). |

### Response

```json
{
  "success": true,
  "data": { "entries": [ /* AuditEntry */ ], "total": 137 },
  "meta": { "timestamp": "2026-07-29T12:00:00.000Z", "requestId": "…" }
}
```

An empty log is a `200` with an empty array, never a `404`.

---

## `GET /api/audit/export`

Streams every matching `audit_logs` row straight to the response body. Nothing
is buffered: rows are pulled from Postgres in keyset-paginated batches and
written to the socket as they arrive, so a multi-million-row date range costs a
bounded amount of memory regardless of how large the answer is.

### Query parameters

The same filters as the listing above, plus:

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `format` | `csv` \| `ndjson` | Output serialisation. Default `csv`. |

`dateFrom` and `dateTo` are validated **strictly** here — they must be ISO-8601
UTC instants such as `2026-01-31T12:00:00.000Z`. The listing endpoint accepts
looser strings because it filters in memory; the export pushes its bounds into
SQL against a `text` column whose ordering is only chronological for well-formed
UTC strings, so a sloppy value would silently return the wrong range instead of
an obviously empty page. `2026-02-31T00:00:00.000Z` is rejected rather than
rolled over to March, and `dateFrom` must not be later than `dateTo`.

Omitting both bounds exports the entire retained table.

### Examples

```bash
# Everything an actor did in January, as CSV
curl -sS -H "Authorization: Bearer $JWT" \
  'https://api.example.com/api/audit/export?actor=GADMIN&dateFrom=2026-01-01T00:00:00.000Z&dateTo=2026-02-01T00:00:00.000Z' \
  -o audit-january.csv

# Every stream cancellation, as NDJSON, piped straight into jq
curl -sS -H "Authorization: Bearer $JWT" \
  'https://api.example.com/api/audit/export?format=ndjson&actionType=STREAM_CANCELLED' \
  | jq -c 'select(.meta.reason != null)'
```

### Response headers

| Header | Value |
| :--- | :--- |
| `Content-Type` | `text/csv; charset=utf-8` or `application/x-ndjson; charset=utf-8` |
| `Content-Disposition` | `attachment; filename="audit-export-<timestamp>.<ext>"` |
| `X-Content-Type-Options` | `nosniff` |
| `Cache-Control` | `no-store` |

There is no `Content-Length`: the body is streamed, and its size is not known
when the headers go out.

### CSV format

A header row followed by one record per audit row, in ascending `id` order:

```csv
id,seq,timestamp,action,resource_type,resource_id,correlation_id,meta
"1","1","2026-01-04T09:12:44.001Z","STREAM_CREATED","stream","stream-42","c-8f3e","{""actor"":""GADMIN""}"
```

Every field is quoted and embedded quotes are doubled (RFC 4180). `meta` is a
JSON document rendered into a single cell.

### NDJSON format

One JSON object per line, no wrapper, no header:

```
{"id":"1","seq":"1","timestamp":"2026-01-04T09:12:44.001Z","action":"STREAM_CREATED","resourceType":"stream","resourceId":"stream-42","correlationId":"c-8f3e","meta":{"actor":"GADMIN"}}
```

`id` and `seq` are `bigint` columns and are emitted as **strings** — they can
exceed `Number.MAX_SAFE_INTEGER`, and a JSON number would lose precision.

### Failure modes

| Status | Cause |
| :--- | :--- |
| `400` | Unknown `format`, malformed/impossible date, or `dateFrom` after `dateTo`. |
| `401` | Missing or invalid JWT. |
| `403` | JWT without `audit:read`. |
| `500` | The self-audit write failed — **no data is exported** (see below). |
| aborted transfer | A database error after streaming began. The connection is destroyed rather than closed cleanly, so the truncation is visible. |

A client that disconnects mid-export aborts the run before the next database
round-trip, so an abandoned download stops costing query time immediately.

---

## Security model

### Access control

Both endpoints run `authenticate` → `requireAuth` →
`requirePermission(Permission.AUDIT_READ)`. `audit:read` belongs to the `admin`
and `operator` roles; `viewer` does not have it. An unauthorised caller is
rejected before any database work is done.

### The export is itself audited

Before a single row is read, the export writes an `AUDIT_EXPORTED` row to
`audit_logs`:

| Field | Value |
| :--- | :--- |
| `action` | `AUDIT_EXPORTED` |
| `resource_type` | `audit_logs` |
| `resource_id` | `<dateFrom>..<dateTo>`, or `beginning..latest` when unbounded |
| `correlation_id` | The request's correlation id |
| `meta` | `{ actor, role, format, filters: { … } }` |

This is deliberately ordered and deliberately fatal:

- **Before, not after** — an export that is cancelled halfway, or that dies on a
  database error, still leaves a record that someone asked for that range.
- **Fatal** — if the audit write fails, the request returns `500` and no data is
  streamed. Reading the audit trail without leaving a trace is not an available
  outcome.

The row count is not known when the record is written, so completion is reported
separately in the `audit_export_completed` structured log
(`{ actor, format, rows, aborted, dateFrom, dateTo }`), correlated by request id.

### Redaction

`meta` is passed through the same recursive redactor as the listing endpoint
before serialisation. Any key named `authToken`, `authorization`, or `x-api-key`
(case-insensitive, at any depth) is replaced with `"[REDACTED]"`, so credentials
captured in an audit record never reach an export file.

### CSV formula injection

Audit `meta` and resource ids can contain operator- or client-supplied text. A
cell beginning with `=`, `+`, `-`, `@`, a tab, or a carriage return is executed
as a formula when the file is opened in Excel, Google Sheets, or LibreOffice —
a classic path to data exfiltration from an "inert" export.

Every CSV cell is emitted through `toCsvField`, which prefixes such values with
an apostrophe. `=HYPERLINK("http://evil","click")` is written as
`"'=HYPERLINK(""http://evil"",""click"")"`: readable, inert.

### SQL injection

Filter values are bound as positional parameters (`$1`, `$2`, …) and never
interpolated into the statement. Only column names — compile-time constants —
are part of the SQL string.

### Header injection

The `Content-Disposition` filename is generated server-side from the current
timestamp. No request input reaches a response header.

---

## Implementation notes

### Why keyset batching and not `DECLARE CURSOR`

`auditRepository.streamFiltered` pages with `WHERE id > $lastId ORDER BY id ASC
LIMIT $batchSize` (default 500, hard cap 5000) rather than opening a server-side
cursor.

A compliance export can take minutes to reach a slow client. A cursor would pin
one pooled connection inside an open transaction for that whole window, which
holds back `VACUUM` on a table that is already partition-maintenance sensitive,
starves the pool under concurrent exports, and dies outright against any
`idle_in_transaction_session_timeout`. Keyset pages are independent short
queries: each borrows a connection and gives it straight back.

`id` is a `bigserial` primary key, so the keyset is unique and index-backed —
and unlike `OFFSET`, its cost does not grow as the export progresses.

### Backpressure

`res.write` returning `false` pauses the generator until `drain`. Without that,
a client reading slower than Postgres delivers would push the whole export into
the process heap — precisely the failure this endpoint exists to avoid.

### Consistency

Because each page is its own statement, rows committed *during* an export may
appear if their `id` sorts after the current position. For an append-only table
that is the safe direction: a superset of the requested range is not a
compliance problem, a missing row is. Rows are never skipped or duplicated —
`id` is monotonic and never reused.
