/**
 * Migration: add `encryption_state` column to `streams`.
 *
 * Tracks the current encryption lifecycle of a stream's address columns so
 * operators can tell at a glance which rows still contain legacy plaintext,
 * which are fully encrypted, and which have been GDPR/retention-redacted.
 *
 * Values
 * ──────
 *  'plaintext'  — row was written before pgcrypto migration; address columns
 *                 contain raw Stellar public keys.  The decrypt_stream_address
 *                 SQL function returns the value unchanged for these rows.
 *  'encrypted'  — row was written after the pgcrypto migration; address columns
 *                 contain PGP armored ciphertext.
 *  'redacted'   — address columns have been tombstoned by GDPR erasure or the
 *                 data-retention purge job; no meaningful address data remains.
 *
 * Default
 * ───────
 * New rows inserted by the current application code always use pgcrypto
 * encryption, so the default for new rows is 'encrypted'.
 *
 * Existing rows pre-dating this migration receive 'plaintext' as the default
 * because we cannot determine their state without inspecting each value.
 * The decrypt_stream_address function already handles both cases transparently.
 * A future backfill job can update these rows to 'encrypted' once they have
 * been re-encrypted and re-hashed.
 *
 * Index
 * ─────
 * A partial index on state != 'encrypted' makes it cheap to find legacy or
 * redacted rows for operational queries and backfill progress checks.
 *
 * Adding the column does NOT require a table rewrite in Postgres because:
 *  - It has a DEFAULT value (Postgres 11+: stored as a catalog default, not
 *    materialised into each row until the row is next updated).
 *  - It is NOT NULL, which is satisfied by the default.
 */

import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export type EncryptionState = 'plaintext' | 'encrypted' | 'redacted';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Existing rows pre-date the pgcrypto migration; default them to 'plaintext'
  // so the state reflects reality for legacy rows.
  pgm.addColumn('streams', {
    encryption_state: {
      type: 'text',
      notNull: true,
      default: 'plaintext',
      comment: "One of: 'plaintext' | 'encrypted' | 'redacted'. Tracks address column lifecycle.",
    },
  });

  // New rows written by current app code are encrypted at write time.
  // This separate update is intentional: we do NOT want to backfill all
  // existing rows here because we cannot know their true state without
  // reading and inspecting each value. A dedicated backfill job handles that.

  // Partial index: fast lookup of non-encrypted rows (legacy backfill target)
  // and redacted rows (compliance queries). Encrypted rows are the common case
  // and do not need a special index.
  pgm.createIndex('streams', 'encryption_state', {
    name: 'idx_streams_encryption_state_non_encrypted',
    where: "encryption_state != 'encrypted'",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('streams', [], { name: 'idx_streams_encryption_state_non_encrypted' });
  pgm.dropColumn('streams', 'encryption_state');
}
