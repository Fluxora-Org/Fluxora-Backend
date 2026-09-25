# PII Encryption for Streams

This project protects `sender_address` and `recipient_address` in the `streams`
PostgreSQL table using row-level `pgcrypto` encryption.

## What changed

- Added a PostgreSQL migration to enable the `pgcrypto` extension.
- Added an application-managed environment key: `PGCRYPTO_KEY`.
- Added optional `PGCRYPTO_KEY_PREVIOUS` support for key rotation.
- Stream writes encrypt addresses before storing them.
- Stream reads decrypt addresses transparently in query results.
- Queries on `sender_address` / `recipient_address` use keyed hash columns
  (`sender_address_hash`, `recipient_address_hash`) for efficient filtering.
- **`getById` bug fix**: The single-stream fetch path was the only read method
  that used a plain `SELECT *` instead of the `streamSelectColumns` helper.
  This meant encrypted rows returned raw ciphertext from `getById` while every
  other read method returned decrypted Stellar addresses.  The fix brings
  `getById` in line with `getByEvent`, `findWithCursor`, and `find` — all four
  paths now use `streamSelectColumns` with the resolved keyset.

## Read path contract

Every repository read method resolves the pgcrypto keyset from config and
passes it to `streamSelectColumns`, which emits
`decrypt_stream_address(col, $keyIndex, $prevKeyIndex|NULL) AS col` for both
address columns.  Decryption happens inside PostgreSQL before the row reaches
application code.

| Method | Key param index | Notes |
|---|---|---|
| `getById` | `$2` (id is `$1`) | Fixed by this change |
| `getByEvent` | `$3` (tx_hash `$1`, event_index `$2`) | Unchanged |
| `findWithCursor` | dynamic | Appended after filter params |
| `find` | dynamic | Appended after filter params |

If `PGCRYPTO_KEY` is absent the repository **fails closed** — `resolvePgcryptoKeys`
throws before any SQL is executed.  Ciphertext is never silently returned as a
Stellar address.

## Database schema

The `streams` table includes:

- `sender_address`: encrypted PGP armor text or legacy plaintext
- `recipient_address`: encrypted PGP armor text or legacy plaintext
- `sender_address_hash`: HMAC-SHA256 of the sender address keyed by `PGCRYPTO_KEY`
- `recipient_address_hash`: HMAC-SHA256 of the recipient address keyed by `PGCRYPTO_KEY`

The DB function `decrypt_stream_address(value, current_key, previous_key DEFAULT NULL)`
handles both encrypted rows (PGP armor prefix detected) and legacy plaintext
rows transparently.

## Runtime requirements

- `PGCRYPTO_KEY` must be set when the service performs stream writes or reads.
- The key must be at least 32 characters long.
- `PGCRYPTO_KEY_PREVIOUS` may be set when rotating the active key.

## Security model

- Addresses are encrypted with `pgp_sym_encrypt(..., 'cipher-algo=aes256,compress-algo=0,armor')`.
- Search filters use keyed HMAC hash columns — the plaintext address is never
  stored unencrypted and never appears in a `WHERE` clause.
- Legacy plaintext values are decrypted transparently until the row is migrated.
- Key rotation is supported by retaining the previous key for decryption only.
- Decryption keys come from config (`getConfig()`) and are never logged,
  included in error messages, or returned in API responses.

## Key rotation procedure

1. Generate a new key (min 32 chars).
2. Set `PGCRYPTO_KEY_PREVIOUS` to the current value of `PGCRYPTO_KEY`.
3. Set `PGCRYPTO_KEY` to the new key.
4. Deploy.  New writes use the new key; existing rows are decrypted with
   the previous key via the `previous_key` fallback in `decrypt_stream_address`.
5. Once all rows are re-encrypted with the new key, clear `PGCRYPTO_KEY_PREVIOUS`.

## Migration

- `migrations/1787788800000_enable_pgcrypto_encrypt_addresses.ts`

Run migrations before starting the service.

## Worker threads pool for batch hashing

Single-row HMAC operations (`computeAddressHash`, `computeAddressHashes`) run
synchronously on the main event loop.  This is fine for the request path where
each call processes one row, but bulk operations such as the export endpoint
or the data-retention purge job iterate thousands of rows and can stall
request handling.

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Main thread                                            │
│                                                         │
│  batchComputeAddressHashes(addrs, keys)                 │
│       │                                                 │
│       ├── < 50 addresses → synchronous (no workers)     │
│       │                                                 │
│       └── ≥ 50 addresses → WorkerPool                   │
│              │                                          │
│              ├── Worker 1 ── pgcryptoWorker.js          │
│              ├── Worker 2 ── pgcryptoWorker.js          │
│              ├── ...                                    │
│              └── Worker N ── pgcryptoWorker.js          │
└──────────────────────────────────────────────────────────┘
```

### Files

| File | Purpose |
|------|---------|
| `src/pii/workerPool.ts` | Generic bounded worker_threads pool with graceful degradation |
| `src/pii/pgcryptoWorker.ts` | Worker thread script — receives hash tasks, returns results |
| `src/pii/pgcryptoEncryption.ts` | `batchComputeAddressHashes()` — public API for batch hashing |

### Batch threshold

The `BATCH_HASH_THRESHOLD` constant (default: **50**) determines the minimum
number of addresses before work is dispatched to workers.  Below this
threshold the overhead of worker IPC (structured clone, message passing)
exceeds the benefit of parallel execution, so computation runs synchronously
on the main thread.

### Pool sizing

Worker count is derived from `os.availableParallelism()` with a hard cap of
`DEFAULT_MAX_WORKERS` (8).  Even on high-core-count machines, the per-worker
overhead (V8 isolate, event loop) does not justify more than 8 concurrent
HMAC computations.

### Graceful degradation

If ALL workers fail to start (e.g. restricted sandbox, resource exhaustion),
the pool degrades transparently to synchronous in-thread execution via a
registered fallback function.  Callers never see errors from the pool —
`batchComputeAddressHashes` always returns correct results.

### Shutdown

Call `shutdownPgcryptoPool()` during graceful process shutdown to terminate
all worker threads and free resources.  The pool is lazily initialized and
recreated if needed after shutdown.

## Security model for worker threads

### Key delivery

Cryptographic keys are passed to workers via `workerData` (structured clone)
at worker creation time.  This is the recommended mechanism from the
`worker_threads` documentation — structured cloning creates an independent
copy in the worker's V8 isolate.

**The worker NEVER:**

- Reads `PGCRYPTO_KEY` from `process.env`
- Reads key material from files or environment
- Logs, serializes, or transmits key material back to the parent thread
- Stores keys beyond the lifetime of the worker

### Key lifecycle

1. Caller passes `PgcryptoKeySet` to `batchComputeAddressHashes()`.
2. Each hash task carries the keys in its `HashTaskMessage`.
3. The worker receives the message, computes HMAC digests, returns results.
4. Keys exist in worker-local heap memory only during task execution.
5. When the worker terminates (pool shutdown), all key material is
   garbage-collected.

### Why per-task keys instead of workerData initialization

Passing keys with each task (rather than once at worker creation) ensures:

- **No stale key state**: each task explicitly provides the current key set,
  so key rotation takes effect immediately without restarting workers.
- **No cross-task leakage**: even if a worker is reused across tasks, each
  task's keys are provided fresh and independently.
- **Simplicity**: no need for a separate "init" handshake or synchronization.

## Data retention purge job

The scheduled retention-purge job (`src/jobs/retentionPurge.ts`) enforces the
data-retention policy defined in `src/pii/policy.ts` by deleting or redacting
rows that have exceeded their configured retention window.

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Scheduler (cron / pg_cron / admin trigger)              │
│       │                                                  │
│       └── runRetentionPurge(options?)                    │
│              │                                           │
│              ├── Rule 1: audit_logs (365 days, delete)   │
│              │     └── processBatch() → BEGIN/COMMIT     │
│              │                                           │
│              ├── Rule 2: webhook_outbox (90 days, delete)│
│              │     └── processBatch() → BEGIN/COMMIT     │
│              │                                           │
│              └── ... (additional rules as added)         │
└──────────────────────────────────────────────────────────┘
```

### Files

| File | Purpose |
|------|---------|
| `src/jobs/retentionPurge.ts` | Purge job — batched, transactional, idempotent |
| `src/pii/policy.ts` | `PURGEABLE_RETENTION_SCHEDULE` — retention rules with table/age/purge-action |
| `migrations/20260724000000_streams_legal_hold.ts` | Adds `legal_hold` column + indexes to `streams` |

### Legal-hold exemption

Every row in a target table with `legal_hold = TRUE` is unconditionally skipped
by the purge job.  A `PURGE_SKIPPED_LEGAL_HOLD` audit event is written for
each skipped row for compliance evidence — except in `dryRun` mode, where no
audit rows are written, so a dry run never mutates the database (see
Configuration below).

The legal-hold check happens **inside the same transaction** as the delete,
preventing a TOCTOU race where a hold is set between the check and the delete.

The `streams` table gains `legal_hold` via migration
`20260724000000_streams_legal_hold.ts`.  Tables without the column
(`audit_logs`, `webhook_outbox`) are handled via a `COALESCE` fallback that
defaults to `FALSE`.

### Execution model

1. **Batched processing**: Each batch acquires a connection, runs
   `SELECT … ORDER BY <ageColumn> ASC … FOR UPDATE SKIP LOCKED`, processes
   rows oldest-first, then commits. Default batch size is 500 rows
   (configurable via `batchSize` option).

2. **Idempotent / crash-safe, no checkpoint table**: Each batch is committed
   atomically.  A crash mid-run simply restarts from wherever the last
   successful commit left off — eligibility is recomputed from live data on
   every run, so already-purged rows are not selected again and a fully
   converged run is a safe no-op.

3. **Concurrent-safe**: `FOR UPDATE SKIP LOCKED` prevents multiple purge
   workers from processing the same rows simultaneously.

### Audit trail

| Event | When | Scope |
|-------|------|-------|
| `PURGE_INITIATED` | Batch commits ≥ 1 delete/redact | Per batch (not per row) |
| `PURGE_SKIPPED_LEGAL_HOLD` | Row has `legal_hold = TRUE` | Per skipped row |

Both events are recorded in the `audit_logs` table with the correlation ID
from the originating job invocation.

### Configuration

```typescript
interface PurgeJobOptions {
  batchSize?: number;   // max rows per transaction (default 500)
  now?: Date;           // override for deterministic testing
  pool?: Pool;          // injectable pool for testing
  correlationId?: string; // propagated into audit entries
  dryRun?: boolean;     // count-only mode: no deletes/redacts AND no audit-log writes
}
```

### Adding a new purge rule

1. Add an entry to `PURGEABLE_RETENTION_SCHEDULE` in `src/pii/policy.ts`.
2. Ensure the target table has an `id` column (or `rowid`) and a
   `legal_hold` boolean column (or accept the `COALESCE` default of `FALSE`).
3. The table should have an index on `(ageColumn, legal_hold)` for efficient
   candidate queries.

### Security model

- Table and column names are developer-controlled constants — safely quoted
  via `quoteIdentifier()` (defence-in-depth against SQL injection).
- The job runs with the application's DB principal (requires `DELETE` on
  target tables, no super-user access needed).
- Audit events are written inside the transaction for purge actions and
  via fire-and-forget for legal-hold skips (to persist even if the batch
  rolls back).
- `dryRun` mode counts candidates without deleting — useful for compliance
  audits and pre-deployment validation.


---

## GDPR Right-to-Erasure Endpoint (Issue #910)

The service implements a GDPR Article 17 (Right to Erasure / Right to be Forgotten) endpoint that permanently scrubs encrypted PII columns for a data subject identified by their Stellar recipient address while fully preserving financial integrity and transaction history.

### Endpoint Overview

```http
DELETE /api/privacy/erasure/:recipientAddress
Authorization: Bearer <TOKEN>
```

### Authorization Requirements

Access to the GDPR erasure endpoint is strictly restricted. Reusing `src/middleware/adminAuth.ts`, the endpoint enforces role-based authorization:

- **Allowed Roles**: `admin`, `data-protection-officer`
- **Forbidden Roles**: `operator`, `viewer`, `user`, or anonymous callers (rejected with `401 Unauthorized` or `403 Forbidden`).

### GDPR Erasure Process

1. **Input Validation**: The `recipientAddress` parameter is validated to ensure it is a non-empty string under 256 characters.
2. **Authentication & Authorization**: The caller's credentials and role claims are verified via `requireAdminAuth`.
3. **Database Transaction**: Operations run inside an explicit database transaction (`BEGIN` ... `COMMIT`).
4. **PII Redaction**: PII columns are permanently overwritten with tombstone values and hash lookup columns are set to `NULL`.
5. **Legal Hold Check**: Rows with `legal_hold = TRUE` are safely skipped.
6. **Audit Entry Written**: An immutable audit log entry is persisted within the transaction without storing the erased PII.
7. **Transaction Commit**: If all steps succeed, the transaction is committed; on any error, a `ROLLBACK` is performed automatically.

### Tombstone Strategy

Encrypted PII columns are overwritten with a static, machine-readable tombstone string:

`[REDACTED_GDPR_ERASURE]`

| Column | Redaction Action |
|---|---|
| `sender_address` | Replaced with `[REDACTED_GDPR_ERASURE]` tombstone |
| `recipient_address` | Replaced with `[REDACTED_GDPR_ERASURE]` tombstone |
| `sender_address_hash` | Set to `NULL` (keyed hash invalidated) |
| `recipient_address_hash` | Set to `NULL` (keyed hash invalidated) |

Schema compatibility is strictly maintained: address columns are never set to `NULL` if non-null values are expected.

### Preserved Financial Records

To comply with statutory financial retention laws and preserve accounting integrity, non-PII financial and transaction data is never modified or deleted:

| Field / Table | Status | Reason Preserved |
|---|---|---|
| `amount` | **Preserved** | Required for financial audit trail and accounting balance verification |
| `ledger` | **Preserved** | Stellar public ledger sequence number — not PII |
| `stream_id` | **Preserved** | Opaque internal record identifier — not PII |
| `status` | **Preserved** | Lifecycle state of stream — not PII |
| `contract_events` | **Preserved** | On-chain contract event records — public chain data |
| `audit_logs` | **Preserved** | Immutable append-only audit trail |

### Audit Logging

Every erasure request records audit events (`GDPR_ERASURE` and `PII_ERASURE_REQUESTED`) in the `audit_logs` table via `recordErasureAuditLog`.

**Recorded Metadata:**
- `requesterIdentity`: Token subject or truncated bearer token string
- `requesterRole`: Role of the authorized caller (`admin` or `data-protection-officer`)
- `timestamp`: ISO-8601 timestamp of erasure execution
- `action`: `GDPR_ERASURE`
- `outcome`: `success` or `failed`
- `rowsErased`: Number of matching stream rows redacted
- `rowsSkippedLegalHold`: Number of rows skipped due to active legal hold

> [!SECURITY]
> The full erased recipient address is **never** stored inside the audit log. The `resourceId` field only records a truncated 8-character prefix followed by an ellipsis (e.g. `GDTEST12…`).

### Operational Considerations

1. **Transaction Atomicity**: All updates and audit writes occur within a single database transaction. If an error occurs midway, `ROLLBACK` restores state.
2. **Idempotency**: Repeated requests for the same address return `200 OK` with `rowsErased: 0`. Already-tombstoned rows no longer match the query.
3. **Legal Hold Exemption**: Rows with `legal_hold = TRUE` are skipped to satisfy statutory compliance holds.
4. **Cache Invalidation**: Responses include `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` headers.

### Example Request

```bash
curl -X DELETE \
  "https://api.example.com/api/privacy/erasure/GDTEST123456789012345678901234567890123456789012345678" \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

### Example Response

```json
{
  "erased": true,
  "rowsErased": 3,
  "rowsSkippedLegalHold": 0,
  "message": "3 row(s) erased."
}
```
