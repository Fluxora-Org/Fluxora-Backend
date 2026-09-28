# Migration naming and collision policy

The runner is `node-pg-migrate`. It records each migration stem in the
`pgmigrations` table and orders files by their timestamp prefix. A rename is
therefore a schema-history operation: an already-applied file with a new name
looks unapplied and can run its DDL again. This change only renames the two
non-baseline August migration files so they follow the policy; names already
recorded in the baseline remain a database compatibility boundary.

## Dependency review

The three `20260624000000` files are independent at the SQL-object level:
the ledger-hash column, replay-progress table, and streams tie-breaker index
do not require one another. Their current order is nevertheless incidental.
The two `20260727000000` files are also independent: API-key scopes and job
dead-letter storage have no direct object dependency. Equal prefixes remain a
real operational hazard because ordering is not an intentional contract.

The pgcrypto migration was a separate broken historical name. Its canonical
13-digit replacement is now the frozen baseline entry, while operators whose
database ledger still records the old stem must use the ledger-audit helper
before applying pending migrations.

## Freeze and guard

`migrations/migration-baseline.json` freezes the names already present in the
repository. Historical names in that baseline remain unchanged so an
already-migrated database is not asked to repeat DDL. The lint excludes
`migrations/legacy/` because that directory is outside the runner scan path.

Every new file must use `<13-digit-milliseconds>_<lowercase-slug>.ts` (or one
of the runner's JavaScript extensions), must have a unique prefix, and must
not reuse a frozen prefix. The check reports the baseline separately so an
operator can distinguish an accepted compatibility exception from a new
violation.

Run locally with:

```sh
pnpm check:migrations
```

The CI job runs the same command. The unit suite proves duplicate and
non-canonical fixtures fail, while a real-directory fixture proves legacy
helpers and the excluded directory do not create false positives.

Reviewers should treat a policy failure as a release-blocking schema concern.
The fix is to choose a new unused timestamp, not to reorder files manually.
The baseline itself is reviewed like a migration: additions require a clear
reason, and removals require an explicit database-history plan.
The command is deterministic, making local and CI reports directly comparable.
This policy also keeps migration review focused on ordering and data safety.
It intentionally does not change migration SQL or the runner library.
Operational rollout remains the responsibility of the migration owner.
The check does not claim that historical migrations are safe to rename.
