import { PoolClient } from 'pg';

/**
 * Supports deterministic offset pagination by matching the repository's
 * fixed ORDER BY created_at DESC, id DESC clause.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    DROP INDEX IF EXISTS idx_streams_created_at;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_streams_created_at_id
      ON streams (created_at DESC, id DESC);
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    DROP INDEX IF EXISTS idx_streams_created_at_id;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_streams_created_at
      ON streams (created_at);
  `);
}