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

## Batch hashing worker pool

`computeAddressHash` and `computeAddressHashes` remain synchronous for the
single-row request path. Use `batchComputeAddressHash` or
`batchComputeAddressHashes` for export, backfill, and retention workloads.
Batches smaller than 50 rows run in-thread because worker startup and IPC cost
more than their HMAC work.

Larger batches use a lazily initialized `worker_threads` pool. Its size is
`min(os.availableParallelism(), 8)`, so hosts with many CPUs cannot create an
unbounded number of V8 isolates. Call `shutdownPgcryptoHashWorkerPool()` during
graceful shutdown to terminate workers and release their key copies.

### Worker-key handling

- A pool is bound to one `PgcryptoKeySet`; workers receive that key set only in
  `workerData`, which is structured-cloned into each worker at startup.
- Task messages contain address arrays only. Keys are not placed in task
  payloads, environment variables, logs, errors, or worker responses.
- A key rotation replaces and terminates the old pool before starting workers
  for the new key set.
- If worker construction, startup, or execution fails, the batch helper returns
  correct synchronous HMAC results rather than propagating worker internals.

Worker threads isolate CPU scheduling, not secrets: normal process-memory and
host-access controls still apply. Do not include keys in application logging or
diagnostic dumps.
