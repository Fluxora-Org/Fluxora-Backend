/**
 * @deprecated
 *
 * This file previously ran a hand-rolled PoolClient-based migration loop.
 * It has been superseded by `src/db/migrate.ts` which uses node-pg-migrate
 * as the single migration runner for all files in this directory.
 *
 * The package.json `migrate` script now points directly at
 * `src/db/migrate.ts`; this file is kept only as a tombstone so that any
 * CI/CD or developer scripts that still reference it receive a clear error
 * instead of silently applying nothing.
 *
 * Run migrations with:
 *   pnpm run migrate
 * which executes:
 *   tsx src/db/migrate.ts
 */

console.error(
  '[migrations/run.ts] This runner is no longer active.\n' +
  'Use `pnpm run migrate` (→ src/db/migrate.ts) to apply migrations.\n',
);
process.exit(1);
