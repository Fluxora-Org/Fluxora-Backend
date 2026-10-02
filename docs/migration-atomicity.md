# Migration Atomicity and Re-run Safety

This document defines what happens when a migration `src/db/migrate.ts` applies
fails partway, and what operators and authors can rely on. The guarantees are
enforced by an offline CI gate and a live-database test, not just by convention.

## The transaction contract

`src/db/migrate.ts` calls node-pg-migrate's `runner` without setting
`singleTransaction`. node-pg-migrate therefore wraps **each migration** in its
own `BEGIN … COMMIT` (`Migration._apply`), and it queues the applied-version
record as the *last* SQL step inside that transaction:

```sql
BEGIN;
  -- the migration's DDL/DML steps
  INSERT INTO "public"."pgmigrations" (name, run_on) VALUES ('…', NOW());
COMMIT;
```

Two consequences follow, and they are the whole recovery story:

1. **A failure rolls back the schema and the version record together.** A
   migration that fails after emitting half its statements leaves the database
   at the last successfully-committed migration. `pgmigrations` and the schema
   cannot disagree for a transactional migration.
2. **Re-running is safe.** The failed migration has no ledger row and no schema
   change, so the next `pnpm run migrate` retries it from a clean slate.

This is verified offline in
`tests/db/migrations.atomicity.test.ts` by capturing the queued SQL with a
recording client: a transactional migration produces
`BEGIN → steps → INSERT pgmigrations → COMMIT`, and a rejected step prevents
both the `COMMIT` and the ledger insert.

## Explicitly non-transactional migrations

PostgreSQL forbids `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`
inside a transaction block. Those migrations call `pgm.noTransaction()`, which
removes the wrapper. They deliberately give up the rollback guarantee: a failure
can leave a partially-applied schema with **no** `pgmigrations` row.

To keep that trade-off honest, every non-transactional migration must be listed
in [`migrations/atomicity-manifest.json`](../migrations/atomicity-manifest.json)
with a plain-language reason, and its statements must be re-runnable:

- `CREATE INDEX` / `CREATE TABLE` / `CREATE EXTENSION` / `ADD COLUMN` use
  `IF NOT EXISTS`;
- `DROP INDEX` / `DROP TABLE` / `DROP COLUMN` / `DROP CONSTRAINT` use
  `IF EXISTS`;
- no unguarded `INSERT` / `UPDATE` / `DELETE` / `TRUNCATE` runs outside a
  transaction.

Re-running an `IF NOT EXISTS` / `IF EXISTS` migration after a partial failure
converges the schema, and a subsequent `INSERT INTO pgmigrations` re-establishes
agreement between the schema and the version record.

> **Caveat: invalid indexes.** A failed `CREATE INDEX CONCURRENTLY` can leave an
> *invalid* index with the intended name. `IF NOT EXISTS` makes the migration
> re-runnable, but it will skip the existing invalid index rather than rebuild
> it. Check `SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT
> indisvalid;` and drop any invalid index before re-running. The manifest reason
> for each concurrent migration is the place to note this if it applies.

## Enforcing the policy

The static gate runs offline and fails CI on a violation:

```bash
pnpm run check:migration-atomicity
```

It classifies every file under `migrations/` and fails when:

- a migration calls `pgm.noTransaction()` without a manifest entry
  (`UNLISTED_NON_TRANSACTIONAL`);
- a manifested migration contains a statement that is not safely re-runnable
  (`NOT_RE_RUNNABLE`);
- the manifest names a migration that no longer exists (`STALE_MANIFEST`).

Unit coverage for the checker lives in
`scripts/check-migration-atomicity.test.mjs`.

## Verifying a real failure

Fail a migration midway and assert the schema and version record agree, then
re-run — against a real PostgreSQL server:

```bash
MIGRATION_ATOMICITY_DATABASE_URL="$DATABASE_URL" \
  pnpm test -- tests/db/migrations.atomicity.test.ts
```

The suite runs node-pg-migrate over a temporary migrations directory and asserts:

- a transactional migration that throws halfway leaves **no** ledger row and
  **no** probe table, then re-runs successfully;
- a `noTransaction()` migration that throws after its guarded DDL leaves an
  unrecorded but re-runnable partial state, then records the version on replay.

The live checks are skipped when `MIGRATION_ATOMICITY_DATABASE_URL` is unset;
CI provides a PostgreSQL service and runs them explicitly.

## Relationship to rollback

Atomicity is about *forward* application. For deliberate `down` migrations, see
[`docs/migration-rollback.md`](./migration-rollback.md).
