# pgcrypto migration ordering

`20260601_enable_pgcrypto_encrypt_addresses.ts` used an eight-digit prefix.
node-pg-migrate could not parse it, and the resulting sort placed it before
`1000000000000_initial_schema`, even though it alters `streams`.

The replacement is `1787788800000_enable_pgcrypto_encrypt_addresses.ts`.
This 13-digit millisecond timestamp sorts after
`1774715131962_streams-table`; the SQL body is unchanged.

The runner records migration stems in `pgmigrations`, so renaming an already
applied file can make it look pending and repeat DDL. Fresh deployments use
the corrected name; deployed databases that recorded the old stem require an
explicit ledger reconciliation during rollout. No sort override or E2E skip
was added.

The 14-digit cohort and duplicate prefixes remain outside this focused fix;
the naming-policy issue freezes that history without mass-renaming applied
migrations. `migrations/legacy/` is outside the runner scan path and remains
untouched.

Run `pnpm check:pgcrypto-order` and `pnpm check:pgcrypto-contract` for
database-free verification of placement, source markers, rollback cleanup,
and the dependency evidence.

For deployed environments, the dry-run ledger helper exposes whether the old
stem was recorded. It never changes the database: an environment that applied
the old stem is reported as `RECONCILE_OLD_STEM_BEFORE_RUN`, while a fresh
environment is reported as `RUN_NEW_STEM`. This makes the rollout decision
visible before a migration command is invoked.
