import { getPool, query } from '../pool.js';
import type { DlqEntry } from '../../routes/dlq.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

function rowToEntry(row: Record<string, unknown>): DlqEntry {
  return {
    id:            row['id']             as string,
    topic:         row['topic']          as string,
    payload:       row['payload']        as unknown,
    error:         row['error']          as string,
    attempts:      row['attempts']       as number,
    correlationId: row['correlation_id'] as string | undefined,
    firstFailedAt: (row['first_failed_at'] as Date).toISOString(),
    lastFailedAt:  (row['last_failed_at']  as Date).toISOString(),
  };
}

// ── Repository ────────────────────────────────────────────────────────────────

export const dlqRepository = {
  async insert(entry: DlqEntry): Promise<void> {
    const pool = getPool();
    await query(
      pool,
      `INSERT INTO dead_letter_queue
         (id, topic, payload, error, attempts, correlation_id, first_failed_at, last_failed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.id,
        entry.topic,
        JSON.stringify(entry.payload),
        entry.error,
        entry.attempts,
        entry.correlationId ?? null,
        entry.firstFailedAt,
        entry.lastFailedAt,
      ],
    );
  },

  async findAll(opts: { limit: number; offset: number; topic?: string }): Promise<{ entries: DlqEntry[]; total: number }> {
    const pool = getPool();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (opts.topic) {
      conditions.push(`topic = $${idx++}`);
      params.push(opts.topic);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [countResult, dataResult] = await Promise.all([
      query<{ count: string }>(pool, `SELECT COUNT(*) AS count FROM dead_letter_queue ${where}`, params),
      query<Record<string, unknown>>(
        pool,
        `SELECT * FROM dead_letter_queue ${where} ORDER BY first_failed_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, opts.limit, opts.offset],
      ),
    ]);

    return {
      entries: dataResult.rows.map(rowToEntry),
      total:   Number(countResult.rows[0]!.count),
    };
  },

  async findById(id: string): Promise<DlqEntry | undefined> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      'SELECT * FROM dead_letter_queue WHERE id = $1',
      [id],
    );
    return result.rows[0] ? rowToEntry(result.rows[0]) : undefined;
  },

  async update(id: string, patch: Partial<Pick<DlqEntry, 'attempts' | 'lastFailedAt'>>): Promise<void> {
    const pool = getPool();
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (patch.attempts !== undefined) { sets.push(`attempts = $${idx++}`); params.push(patch.attempts); }
    if (patch.lastFailedAt !== undefined) { sets.push(`last_failed_at = $${idx++}`); params.push(patch.lastFailedAt); }

    if (!sets.length) return;
    params.push(id);
    await query(pool, `UPDATE dead_letter_queue SET ${sets.join(', ')} WHERE id = $${idx}`, params);
  },

  async deleteById(id: string): Promise<boolean> {
    const pool = getPool();
    const result = await query(pool, 'DELETE FROM dead_letter_queue WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  },

  async deleteAll(topic?: string): Promise<number> {
    const pool = getPool();
    if (topic) {
      const result = await query(pool, 'DELETE FROM dead_letter_queue WHERE topic = $1', [topic]);
      return result.rowCount ?? 0;
    }
    const result = await query(pool, 'DELETE FROM dead_letter_queue');
    return result.rowCount ?? 0;
  },
};
