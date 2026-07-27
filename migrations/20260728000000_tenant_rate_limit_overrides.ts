import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('tenant_rate_limit_overrides', {
    id:           { type: 'text', primaryKey: true },
    key_id:       { type: 'text', notNull: true, unique: true },
    max_requests: { type: 'integer', notNull: true },
    window_ms:    { type: 'integer', notNull: true },
    expires_at:   { type: 'timestamp with time zone', notNull: false },
    created_by:   { type: 'text', notNull: true },
    created_at:   { type: 'timestamp with time zone', notNull: true, default: pgm.func('current_timestamp') },
    updated_at:   { type: 'timestamp with time zone', notNull: true, default: pgm.func('current_timestamp') },
  });

  pgm.createIndex('tenant_rate_limit_overrides', 'key_id', {
    name: 'idx_overrides_key_id',
    unique: true,
  });

  pgm.createIndex('tenant_rate_limit_overrides', 'expires_at', {
    name: 'idx_overrides_expires_at',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('tenant_rate_limit_overrides');
}
