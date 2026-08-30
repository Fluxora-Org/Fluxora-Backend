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

## Rollout checklist

1. Inspect the target database's `pgmigrations` rows for the old stem.
2. If it is present, pause and reconcile the ledger with the deployment owner.
3. Confirm the new stem is the only pgcrypto target on disk.
4. Run the order, contract, and ledger-audit checks in the release workspace.
5. Apply migrations to a scratch database and then repeat the command.
6. Confirm the second run reports no pending migration work.

The rename is intentionally visible in code review. It is not hidden behind a
manual ordering hook, a filename alias, or a conditional that skips the DDL.
This keeps clean-database behavior and deployed-database safety separate: the
former is verified automatically, while the latter requires an operator who
can inspect the real migration ledger.

The contract check also verifies that the extension creation remains
idempotent, both address-hash columns remain present, indexes are retained,
and rollback uses `IF EXISTS` for the decrypt function. Its digest is evidence
that the rename did not silently alter the SQL body.

A clean migration run must create `streams` before adding hash columns. A
failed run must be safe to diagnose and retry after the schema owner resolves
the ledger state; deleting rows or dropping application tables is not part of
this change.
Keep the original migration SQL reviewable and avoid unrelated cleanup.
Record the verification output alongside the deployment change ticket.
Escalate any unexpected pending migration instead of bypassing the check.

For deployed environments, the dry-run ledger helper exposes whether the old
stem was recorded. It never changes the database: an environment that applied
the old stem is reported as `RECONCILE_OLD_STEM_BEFORE_RUN`, while a fresh
environment is reported as `RUN_NEW_STEM`. This makes the rollout decision
visible before a migration command is invoked.
The release owner should retain both pre- and post-migration evidence.
Unexpected pending work must be escalated rather than bypassing the guard.
No production credentials belong in the audit output.
The check is read-only by design.
Its result can be attached to the deployment record.
