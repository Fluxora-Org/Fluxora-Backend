/**
 * Migration: Add the `api_keys` table.
 *
 * Replaces the legacy process-local, unsalted in-memory API-key store with a
 * durable, horizontally-shareable table.
 *
 * Security-relevant columns
 * -------------------------
 * - `key_hash` stores `HMAC-SHA256(pepper, salt || rawKey)` (hex). The raw key
 *   is never persisted; the server-side pepper is supplied out-of-band via the
 *   `API_KEY_PEPPER` env var, so the table alone is not brute-forceable.
 * - `salt` is a per-key random value, defeating precomputed rainbow tables even
 *   if two keys happen to share a value.
 * - `prefix` (first 8 chars of the raw key) is an indexed, non-secret lookup
 *   column so validation fetches candidate rows in O(log n) instead of scanning
 *   every active key.
 */

import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('api_keys', {
    id:         { type: 'text', primaryKey: true },
    name:       { type: 'text', notNull: true },
    key_hash:   { type: 'text', notNull: true },
    salt:       { type: 'text', notNull: true },
    prefix:     { type: 'text', notNull: true },
    created_at: { type: 'timestamp with time zone', notNull: true, default: pgm.func('current_timestamp') },
    rotated_at: { type: 'timestamp with time zone', notNull: false },
    active:     { type: 'boolean', notNull: true, default: true },
  });

  // Indexed lookup column: validation resolves candidates by prefix instead of
  // scanning the table. The partial index keeps the hot path (active keys) tight.
  pgm.createIndex('api_keys', 'prefix');
  pgm.createIndex('api_keys', 'prefix', {
    name: 'api_keys_prefix_active_idx',
    where: 'active',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('api_keys');
}
