/**
 * Migration: dlq_suspension_nonnegative
 * Enforces consecutive_failures >= 0 at the database level.
 * Repairs any existing negative consecutive_failures values first.
 */

import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // 1. Repair any existing negative values in consecutive_failures
  pgm.sql(`
    UPDATE dlq_consumer_suspension
    SET consecutive_failures = 0
    WHERE consecutive_failures < 0;
  `);

  // 2. Add CHECK constraint to enforce consecutive_failures >= 0 (dropping first to be idempotent)
  pgm.sql(`
    ALTER TABLE dlq_consumer_suspension
    DROP CONSTRAINT IF EXISTS consecutive_failures_nonnegative;

    ALTER TABLE dlq_consumer_suspension
    ADD CONSTRAINT consecutive_failures_nonnegative
    CHECK (consecutive_failures >= 0);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop check constraint
  pgm.sql(`
    ALTER TABLE dlq_consumer_suspension
    DROP CONSTRAINT IF EXISTS consecutive_failures_nonnegative;
  `);
}
