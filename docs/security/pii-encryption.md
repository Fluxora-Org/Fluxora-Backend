# PII Encryption for Streams

This project now protects `sender_address` and `recipient_address` in the `streams`
PostgreSQL table using row-level `pgcrypto` encryption.

## What changed

- Added a PostgreSQL migration to enable the `pgcrypto` extension.
- Added an application-managed environment key: `PGCRYPTO_KEY`.
- Added optional `PGCRYPTO_KEY_PREVIOUS` support for key rotation.
- Stream writes now encrypt addresses before storing them.
- Stream reads now decrypt addresses transparently in query results.
- Queries on `sender_address` / `recipient_address` use keyed hash columns
  (`sender_address_hash`, `recipient_address_hash`) for efficient filtering.

## Database schema

The `streams` table now includes:

- `sender_address`: encrypted PGP armor text or legacy plaintext
- `recipient_address`: encrypted PGP armor text or legacy plaintext
- `sender_address_hash`: HMAC-SHA256 of the sender address keyed by `PGCRYPTO_KEY`
- `recipient_address_hash`: HMAC-SHA256 of the recipient address keyed by `PGCRYPTO_KEY`

A helper function `decrypt_stream_address` is installed in the database to
support decryption of both currently encrypted rows and legacy plaintext rows.

## Runtime requirements

- `PGCRYPTO_KEY` must be provided when the service performs stream writes/reads.
- The key must be at least 32 characters long.
- `PGCRYPTO_KEY_PREVIOUS` may be provided when rotating the active key.

## Security model

- Addresses are encrypted with `pgp_sym_encrypt(..., 'cipher-algo=aes256,compress-algo=0,armor')`.
- Search filters continue to work via keyed HMAC hash columns.
- Legacy plaintext values are decrypted transparently until the row is migrated.
- Key rotation is supported by retaining a previous key for decryption only.

## Migration

A new migration file was added:

- `migrations/20260601_enable_pgcrypto_encrypt_addresses.ts`

Run migrations before starting the service to ensure the database schema is compatible.
