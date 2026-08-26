# Legacy migrations

Left behind by the consolidation onto node-pg-migrate (`1fd86f5`), which removed
the hand-rolled runner but not its files.

node-pg-migrate scans `migrations/` and requires a timestamp prefix on every
entry, so these broke the runner outright with `Can't determine timestamp for
000`. They are kept here (a subdirectory is not scanned) rather than deleted.

- `run.ts` — the deprecated custom runner entry point, not a migration. Its own
  header marks it `@deprecated`.
- `000_initial_schema.ts`, `001_add_contract_events_replay_indexes.ts`,
  `002_create_replay_cursors.ts` — superseded by the timestamped
  `1000000000000_`, `1000000000001_` and `1000000000002_` files of the same
  names, which remain active.
