import { Pool } from 'pg'

// Utilize the DATABASE_URL environment variable as specified in the README
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

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
