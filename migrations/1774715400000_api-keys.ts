import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('api_keys', {
    id:          { type: 'text', primaryKey: true },
    name:        { type: 'text', notNull: true },
    key_hash:    { type: 'char(64)', notNull: true },
    key_salt:    { type: 'char(32)', notNull: true },
    lookup_hash: { type: 'char(64)', notNull: true },
    prefix:      { type: 'text', notNull: true },
    created_at:  { type: 'timestamp with time zone', notNull: true, default: pgm.func('current_timestamp') },
    rotated_at:  { type: 'timestamp with time zone' },
    revoked_at:  { type: 'timestamp with time zone' },
  });

  pgm.addConstraint('api_keys', 'api_keys_name_not_empty', "CHECK (length(btrim(name)) > 0)");
  pgm.addConstraint('api_keys', 'api_keys_prefix_length', "CHECK (length(prefix) = 8)");
  pgm.addConstraint('api_keys', 'api_keys_key_hash_hex', "CHECK (key_hash ~ '^[0-9a-f]{64}$')");
  pgm.addConstraint('api_keys', 'api_keys_key_salt_hex', "CHECK (key_salt ~ '^[0-9a-f]{32}$')");
  pgm.addConstraint('api_keys', 'api_keys_lookup_hash_hex', "CHECK (lookup_hash ~ '^[0-9a-f]{64}$')");

  pgm.createIndex('api_keys', 'lookup_hash', {
    name: 'api_keys_active_lookup_hash_idx',
    where: 'revoked_at IS NULL',
  });
  pgm.createIndex('api_keys', 'created_at');
  pgm.createIndex('api_keys', 'prefix');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('api_keys');
}
