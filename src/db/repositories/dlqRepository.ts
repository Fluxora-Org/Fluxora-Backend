/**
 * DLQ repository — dead-letter queue data access plus per-topic suspension tracking.
 *
 * Two tables are managed:
 *  - `dead_letter_queue`       — individual failed-delivery entries.
 *  - `dlq_consumer_suspension` — per-topic suspension state (consecutive
 *    failures, suspended flag, audit timestamps).
 *
 * Suspension logic (see #349):
 *  - Each failed replay calls `recordReplayFailure(topic)`:
 *      • increments consecutive_failures (upserts row)
 *      • if consecutive_failures reaches the threshold, sets suspended = TRUE
 *  - A successful replay calls `recordReplaySuccess(topic)`:
 *      • resets consecutive_failures to 0
 *  - `getConsumerSuspension(topic)` is used by the replay endpoint to gate
 *    replays before attempting re-delivery.
 *  - `resumeConsumer(topic)` clears the suspended flag — operator-only action.
 */

import { getPool, query } from '../pool.js';
import type { DlqEntry } from '../../routes/dlq.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Safely serialize a payload to JSON, handling non-serializable values
 * like circular references and BigInt.
 *
 * If serialization fails, returns a safe fallback representation that
 * records the error and a type hint without exposing sensitive data.
 *
 * @param payload — The payload object to serialize
 * @returns A JSON string, or a safe fallback on serialization error
 *
 * @security
 * Fallback representation avoids including the original payload to prevent
 * accidentally leaking secrets in error states.
 */
function safeSerializePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    // Serialization failed (e.g., circular reference, BigInt, or Symbol)
    // Record a safe fallback that documents the failure without leaking data.
    const errorMsg = error instanceof Error ? error.message : String(error);
    const fallback = {
      _serialization_error: true,
      reason: errorMsg,
      type: typeof payload,
      timestamp: new Date().toISOString(),
    };
    return JSON.stringify(fallback);
  }
}

// ── Configurable threshold ────────────────────────────────────────────────────

/**
 * Number of consecutive failed replays after which a topic is suspended.
 * Overridable via DLQ_SUSPENSION_THRESHOLD env var (default 5).
 */
export function getSuspensionThreshold(): number {
  const raw = process.env.DLQ_SUSPENSION_THRESHOLD;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConsumerSuspension {
  topic: string;
  consecutiveFailures: number;
  suspended: boolean;
  suspendedAt: string | null;
  resumedAt: string | null;
  updatedAt: string;
}

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

function rowToSuspension(row: Record<string, unknown>): ConsumerSuspension {
  return {
    topic:               row['topic']                as string,
    consecutiveFailures: row['consecutive_failures'] as number,
    suspended:           row['suspended']             as boolean,
    suspendedAt:         row['suspended_at'] ? (row['suspended_at'] as Date).toISOString() : null,
    resumedAt:           row['resumed_at']  ? (row['resumed_at']  as Date).toISOString() : null,
    updatedAt:           (row['updated_at'] as Date).toISOString(),
  };
}

// ── Repository ────────────────────────────────────────────────────────────────

export const dlqRepository = {

  // ── DLQ entry CRUD ──────────────────────────────────────────────────────────

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
        safeSerializePayload(entry.payload),
        entry.error,
        entry.attempts,
        entry.correlationId ?? null,
        entry.firstFailedAt,
        entry.lastFailedAt,
      ],
    );
  },

  async findAll(opts: {
    limit: number;
    offset: number;
    topic?: string;
  }): Promise<{ entries: DlqEntry[]; total: number }> {
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

  // ── Consumer suspension ─────────────────────────────────────────────────────

  /**
   * Fetch the suspension state for a given topic.
   * Returns null if no suspension row exists (consumer is healthy, zero failures).
   */
  async getConsumerSuspension(topic: string): Promise<ConsumerSuspension | null> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      'SELECT * FROM dlq_consumer_suspension WHERE topic = $1',
      [topic],
    );
    return result.rows[0] ? rowToSuspension(result.rows[0]) : null;
  },

  /**
   * Fetch all suspended consumers. Used by the admin list endpoint to surface
   * suspension state alongside DLQ entries.
   */
  async listSuspendedConsumers(): Promise<ConsumerSuspension[]> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      'SELECT * FROM dlq_consumer_suspension ORDER BY topic',
    );
    return result.rows.map(rowToSuspension);
  },

  /**
   * Record a failed replay attempt for a topic.
   *
   * Upserts the dlq_consumer_suspension row, incrementing consecutive_failures.
   * If the new count meets or exceeds the threshold, sets suspended = TRUE and
   * records suspended_at.
   *
   * Returns the updated suspension state.
   */
  async recordReplayFailure(topic: string): Promise<ConsumerSuspension> {
    const pool = getPool();
    const threshold = getSuspensionThreshold();

    const result = await query<Record<string, unknown>>(
      pool,
      `INSERT INTO dlq_consumer_suspension (topic, consecutive_failures, suspended, suspended_at, updated_at)
         VALUES ($1, 1, (1 >= $2), CASE WHEN 1 >= $2 THEN now() ELSE NULL END, now())
       ON CONFLICT (topic) DO UPDATE
         SET consecutive_failures = dlq_consumer_suspension.consecutive_failures + 1,
             suspended = (dlq_consumer_suspension.consecutive_failures + 1 >= $2),
             suspended_at = CASE
               WHEN dlq_consumer_suspension.suspended = FALSE
                AND (dlq_consumer_suspension.consecutive_failures + 1 >= $2)
               THEN now()
               ELSE dlq_consumer_suspension.suspended_at
             END,
             updated_at = now()
       RETURNING *`,
      [topic, threshold],
    );

    return rowToSuspension(result.rows[0]!);
  },

  /**
   * Record a successful replay for a topic — resets consecutive_failures to 0.
   * A no-op if no suspension row exists.
   */
  async recordReplaySuccess(topic: string): Promise<void> {
    const pool = getPool();
    await query(
      pool,
      `INSERT INTO dlq_consumer_suspension (topic, consecutive_failures, suspended, updated_at)
         VALUES ($1, 0, FALSE, now())
       ON CONFLICT (topic) DO UPDATE
         SET consecutive_failures = 0,
             updated_at = now()`,
      [topic],
    );
  },

  /**
   * Re-enable a suspended consumer, clearing the suspension flag.
   * Returns the updated row, or null if the topic has no suspension record.
   */
  async resumeConsumer(topic: string): Promise<ConsumerSuspension | null> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      `UPDATE dlq_consumer_suspension
         SET suspended = FALSE,
             consecutive_failures = 0,
             resumed_at = now(),
             updated_at = now()
       WHERE topic = $1
       RETURNING *`,
      [topic],
    );
    return result.rows[0] ? rowToSuspension(result.rows[0]) : null;
  },
};
