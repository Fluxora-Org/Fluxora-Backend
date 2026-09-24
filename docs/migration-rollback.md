# Migration Rollback Procedure

The migration files under `src/db/migrations` expose an `up` and `down` path.
They are feature-level migration contracts and are tested directly; the
application startup runner remains the timestamped migration set under
`migrations/`.

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
if those original NULL values must be recovered. Migration `006` deliberately
fails when existing negative `event_index` values are present instead of
silently changing data, so its down path remains lossless.

## Verify the rollback path

The offline contract checks run in the normal test suite. To exercise every
`up`/`down` pair against a populated PostgreSQL schema:

```bash
MIGRATION_ROLLBACK_DATABASE_URL="$DATABASE_URL" \
  pnpm test -- tests/db/migrations.rollback.test.ts
```

The test restores each prerequisite table between cases and asserts rows,
columns, indexes, and constraints after reversal.
