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

- `migrations/20260601_enable_pgcrypto_encrypt_addresses.ts`

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
