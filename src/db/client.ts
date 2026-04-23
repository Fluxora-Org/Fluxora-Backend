import { Pool } from 'pg'

// Lazy-initialized so importing this module never opens a connection at load time.
let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

/** Swap the pool instance (test use only). */
export function setPool(p: Pool | null): void {
  _pool = p;
}

// Keep a named export for callers that used the old `pool` directly.
export const pool = { query: (...args: any[]) => getPool().query(...args as [any]) };

export async function getStreamById(id: string) {
  const query = `
    SELECT id, sender, recipient, deposit_amount AS "depositAmount", 
           rate_per_second AS "ratePerSecond", start_time AS "startTime"
    FROM streams 
    WHERE id = $1
  `
  const { rows } = await pool.query(query, [id])
  return rows[0] || null
}
