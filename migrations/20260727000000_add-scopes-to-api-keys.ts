/**
 * Migration: Add the `scopes` column to the `api_keys` table.
 *
 * Provides row-level permission scoping for API keys. Existing rows receive
 * the default `["streams:read","streams:write"]` value for backward
 * compatibility.
 */

import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('api_keys', {
    scopes: {
      type: 'text',
      notNull: true,
      default: JSON.stringify(['streams:read', 'streams:write']),
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('api_keys', 'scopes');
}
