import { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS job_dead_letter (
      id BIGSERIAL PRIMARY KEY,
      job_name TEXT NOT NULL,
      job_id TEXT NOT NULL,
      payload JSONB,
      error_message TEXT,
      failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      retry_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_job_dead_letter_name ON job_dead_letter(job_name);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TABLE IF EXISTS job_dead_letter');
}
