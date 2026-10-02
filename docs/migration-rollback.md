# Migration Rollback Procedure

> Forward-application atomicity, the non-transactional manifest, and re-run
> safety after a partial failure are defined in
> [`docs/migration-atomicity.md`](./migration-atomicity.md).

The migration files under `src/db/migrations` expose an `up` and `down` path.
They are feature-level migration contracts and are tested directly; the
application startup runner remains the timestamped migration set under
`migrations/`.

## Applied order

The three-digit ordinal in the filename **is** the applied order:

| Ordinal | Migration | Change |
|---------|-----------|--------|
| 001 | `001_create_streams_table` | `streams` table and its indexes |
| 002 | `002_webhook_outbox_durable_retry` | `attempt_count`, `next_attempt_at` |
| 003 | `003_create_indexer_replay_progress` | `indexer_replay_progress` table |
| 004 | `004_contract_events_ingested_at_default` | `contract_events.ingested_at` default/NOT NULL |
| 005 | `005_streams_contract_id_event_index` | `idx_streams_contract_event` |
| 006 | `006_add_webhook_outbox_dispatch_index` | `webhook_outbox_dispatch_idx` |
| 007 | `007_add_webhook_outbox_lock_columns` | outbox `status`/`locked_at`/`locked_by` |
| 008 | `008_streams_event_index_check` | `chk_streams_event_index_non_negative` |

`pnpm run check:migrations` (CI gate `Check migration naming policy`) fails the
build when two contracts share an ordinal, when a filename is not
`NNN_snake_case.ts`, or when `contract-ledger.json` disagrees with what is on
disk. Adding a migration therefore means taking the next free ordinal — never
reusing one.

### Renumbering an already-applied migration

Renumbering must not re-apply DDL to a database that already ran the
migration. Two things enforce that:

1. `src/db/migrations/contract-ledger.json` records every `from` → `to`
   renumbering. The check fails if the old stem is still on disk or the new one
   never landed, so the rename cannot silently diverge from the file set. An
   operator sees the ledger entry and knows the change already took effect.
2. The renamed migration's `up` is idempotent, so replaying it against a
   database that already carries the change is a no-op instead of an error.

`008_streams_event_index_check` was previously `006_streams_event_index_check`,
sharing ordinal `006` with `006_add_webhook_outbox_dispatch_index` (#1485). The
two touch different tables, so the relative order is immaterial; the ordinals
are now unique and the applied order is unambiguous.

## Before rolling back

1. Stop application workers that write the affected tables, or put the
   affected feature into maintenance mode.
2. Take and verify a PostgreSQL backup or snapshot.
3. Confirm the migration name and inspect its `down` SQL. Roll back one
   migration at a time, starting with the newest applied migration.
4. Check application compatibility. A rollback that removes columns or
   indexes must run before code that depends on them is deployed.

## Execute a rollback

Run the selected `down` SQL in `psql` using the same database as the deploy.
For example:

```bash
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -f rollback.sql
```

Run the application smoke checks, inspect the affected table and index
catalogs, and only then resume writers. Record the migration name, backup
identifier, operator, and validation result in the deployment incident.

Migration `004_contract_events_ingested_at_default` is explicitly marked with
`irreversibleReason`: its schema change can be reversed, but NULL values
backfilled by `up` cannot be reconstructed. Restore from the pre-deploy backup
if those original NULL values must be recovered. Migration
`008_streams_event_index_check` deliberately fails when existing negative
`event_index` values are present instead of silently changing data, so its down
path remains lossless.

## Verify the rollback path

The offline contract checks run in the normal test suite. To exercise every
`up`/`down` pair against a populated PostgreSQL schema:

```bash
MIGRATION_ROLLBACK_DATABASE_URL="$DATABASE_URL" \
  pnpm test -- tests/db/migrations.rollback.test.ts
```

The test restores each prerequisite table between cases and asserts rows,
columns, indexes, and constraints after reversal.
