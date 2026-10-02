# Blue-Green Migration Compatibility Policy

## Problem

During a blue-green deployment cutover, both application versions run simultaneously. Migrations run separately from the application deploy, which means a migration that removes or narrows a schema element will break the version still running.

## Solution

All migrations must be **additive-only** across the cutover window. Destructive changes must be deferred to a later release after the cutover is complete and the old version is no longer serving traffic.

## Allowed Operations (Additive)

These operations are safe for blue-green deployments because they only add new schema elements without breaking existing code:

- **CREATE TABLE** - Adds a new table that the old version doesn't use
- **ADD COLUMN** - Adds a new column (must provide a default if NOT NULL)
- **CREATE INDEX** - Adds a new index (performance improvement only)
- **ADD CONSTRAINT** - Adds UNIQUE, CHECK, or FOREIGN KEY constraints
- **ALTER COLUMN** - Adding a default value or widening a type (e.g., varchar(50) → varchar(100))

## Forbidden Operations (Destructive)

These operations are **not allowed** during blue-green cutovers because they break the old version:

- **DROP TABLE** - Removes a table the old version may query
- **DROP COLUMN** - Removes a column the old version may read or write
- **DROP INDEX** - Removes an index that may be needed for query performance
- **DROP CONSTRAINT** (without IF EXISTS) - May break old version's data integrity assumptions
- **ALTER COLUMN** making NOT NULL - Old version writing NULLs will fail
- **ALTER COLUMN** narrowing type - Old version writing incompatible values will fail
- **ALTER COLUMN** removing default - May break old version's insert logic
- **RENAME TABLE/COLUMN** - Old version's queries will fail with schema errors

## Safe Exception: Idempotent Migrations

Operations with `IF EXISTS` are allowed when used for idempotency:

```typescript
// Safe - allows re-running the migration
pgm.dropConstraint('table', 'constraint_name', { ifExists: true });

// Safe - SQL equivalent
pgm.sql(`DROP CONSTRAINT IF EXISTS constraint_name`);
```

## Migration Strategy for Destructive Changes

When you need to make a destructive change, use a multi-release strategy:

### Release 1: Additive Migration
1. Add the new schema element (new column, new table, etc.)
2. Deploy the new application version that writes to both old and new elements
3. Complete the blue-green cutover

### Release 2: Data Migration (if needed)
1. Backfill data from old element to new element
2. Deploy application version that reads from new element only

### Release 3: Cleanup Migration
1. Remove the old schema element (DROP COLUMN, DROP TABLE, etc.)
2. Deploy application version that no longer references the old element
3. Complete the blue-green cutover

## Examples

### ✅ Safe: Additive migration

```typescript
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add a new column with default for backward compatibility
  pgm.addColumn('users', {
    email_verified: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
  });
}
```

### ✅ Safe: Idempotent constraint drop

```typescript
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Safe - allows re-running the migration
  pgm.dropConstraint('users', 'unique_email', { ifExists: true });
  
  pgm.addConstraint('users', 'unique_email_v2', {
    unique: ['email'],
  });
}
```

### ❌ Unsafe: Destructive migration

```typescript
export async function up(pgm: MigrationBuilder): Promise<void> {
  // NOT SAFE - old version still running may query this column
  pgm.dropColumn('users', 'legacy_field');
}
```

### ❌ Unsafe: Making column NOT NULL

```typescript
export async function up(pgm: MigrationBuilder): Promise<void> {
  // NOT SAFE - old version may write NULLs
  pgm.alterColumn('users', 'email', {
    notNull: true,
  });
}
```

## Validation

Run the blue-green migration compatibility check locally:

```sh
pnpm check:blue-green-migrations
```

The CI pipeline runs this check automatically. A migration violating the rule will fail review.

## Baseline for Historical Migrations

Historical migrations that already contain destructive operations are exempted from the check via `migrations/blue-green-baseline.json`. This baseline freezes the names of already-applied migrations that predate this policy.

When adding a new migration that uses destructive operations (which should be rare and carefully justified), you must:
1. Add the migration filename to the baseline
2. Document why the destructive change is necessary
3. Ensure the migration is safe for the current deployment strategy

The baseline is reviewed like a migration: additions require a clear reason, and removals require an explicit database-history plan.

## Enforcement

- **Pre-merge**: The check must pass before a migration can be merged
- **Pre-deploy**: The check runs as part of the deployment pipeline
- **Review**: Reviewers should treat a policy failure as a release-blocking schema concern

## Related Documentation

- [Migration Naming Policy](./MIGRATION_NAMING_POLICY.md)
- [Migration Rollback Guide](./migration-rollback.md)
- [PGCrypto Migration Order](./PGCRYPTO_MIGRATION_ORDER.md)
