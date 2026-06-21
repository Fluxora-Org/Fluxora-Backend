import { getPool, query } from '../pool.js';
import type { DlqConsumerReplayState, DlqEntry } from '../../routes/dlq.js';
import { hashDlqConsumerUrl } from '../../lib/dlqConsumer.js';

// ?? Internal helpers ??????????????????????????????????????????????????????????

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

function nullableDateToIso(value: unknown): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function rowToConsumerReplayState(row: Record<string, unknown>): DlqConsumerReplayState {
  return {
    consumerUrl: row['consumer_url'] as string,
    consumerUrlHash: row['consumer_url_hash'] as string,
    consecutiveFailures: Number(row['consecutive_failures'] ?? 0),
    suspended: Boolean(row['suspended']),
    suspendedAt: nullableDateToIso(row['suspended_at']),
    updatedAt: nullableDateToIso(row['updated_at']) ?? new Date(0).toISOString(),
  };
}

// ?? Repository ????????????????????????????????????????????????????????????????

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

  async deleteAllConsumerReplayStates(): Promise<number> {
    const pool = getPool();
    const result = await query(pool, 'DELETE FROM dlq_consumer_replay_state');
    return result.rowCount ?? 0;
  },

  async findConsumerReplayState(consumerUrl: string): Promise<DlqConsumerReplayState | undefined> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      'SELECT * FROM dlq_consumer_replay_state WHERE consumer_url_hash = $1',
      [hashDlqConsumerUrl(consumerUrl)],
    );
    return result.rows[0] ? rowToConsumerReplayState(result.rows[0]) : undefined;
  },

  async findConsumerReplayStates(consumerUrls: string[]): Promise<Map<string, DlqConsumerReplayState>> {
    const uniqueUrls = Array.from(new Set(consumerUrls));
    if (uniqueUrls.length === 0) return new Map();

    const pool = getPool();
    const hashes = uniqueUrls.map(hashDlqConsumerUrl);
    const result = await query<Record<string, unknown>>(
      pool,
      'SELECT * FROM dlq_consumer_replay_state WHERE consumer_url_hash = ANY($1::text[])',
      [hashes],
    );

    const byUrl = new Map<string, DlqConsumerReplayState>();
    for (const row of result.rows) {
      const state = rowToConsumerReplayState(row);
      byUrl.set(state.consumerUrl, state);
    }
    return byUrl;
  },

  async recordConsumerReplayFailure(consumerUrl: string, threshold: number): Promise<DlqConsumerReplayState> {
    const pool = getPool();
    const hash = hashDlqConsumerUrl(consumerUrl);
    const result = await query<Record<string, unknown>>(
      pool,
      `
        INSERT INTO dlq_consumer_replay_state
          (consumer_url_hash, consumer_url, consecutive_failures, suspended, suspended_at, updated_at)
        VALUES ($1, $2, 1, $3, CASE WHEN $3 THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (consumer_url_hash) DO UPDATE SET
          consumer_url = EXCLUDED.consumer_url,
          consecutive_failures = dlq_consumer_replay_state.consecutive_failures + 1,
          suspended = dlq_consumer_replay_state.suspended
            OR (dlq_consumer_replay_state.consecutive_failures + 1 >= $4),
          suspended_at = CASE
            WHEN dlq_consumer_replay_state.suspended THEN dlq_consumer_replay_state.suspended_at
            WHEN dlq_consumer_replay_state.consecutive_failures + 1 >= $4 THEN NOW()
            ELSE NULL
          END,
          updated_at = NOW()
        RETURNING *
      `,
      [hash, consumerUrl, 1 >= threshold, threshold],
    );
    return rowToConsumerReplayState(result.rows[0]!);
  },

  async reenableConsumer(consumerUrl: string): Promise<DlqConsumerReplayState | undefined> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      `
        UPDATE dlq_consumer_replay_state
        SET consecutive_failures = 0,
            suspended = false,
            suspended_at = NULL,
            updated_at = NOW()
        WHERE consumer_url_hash = $1
        RETURNING *
      `,
      [hashDlqConsumerUrl(consumerUrl)],
    );
    return result.rows[0] ? rowToConsumerReplayState(result.rows[0]) : undefined;
  },
};
