/**
 * DLQ repository — dead-letter queue data access plus per-topic suspension tracking.
 *
 * Two tables are managed:
 *  - `dead_letter_queue`       — individual failed-delivery entries.
 *  - `dlq_consumer_suspension` — per-topic suspension state (consecutive
 *    failures, suspended flag, audit timestamps).
 *
 * Failure history:
 *  - `error` holds the FIRST recorded cause and is never rewritten, so the
 *    failure worth diagnosing cannot be replaced by a later attempt.
 *  - `failure_history` is an append-only JSONB array of attempt records
 *    ({ error, attempt, failedAt, source }). `recordFailure()` appends one and
 *    increments `attempts` / `last_failed_at` in a single statement.
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
import type { DlqEntry, DlqFailureAttempt } from '../../routes/dlq.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Source label used for the cause recorded when an item is enqueued. */
export const FAILURE_SOURCE_ENQUEUE = 'enqueue';

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

/**
 * Parse a `jsonb` value that may arrive as a parsed array/object (node-postgres)
 * or as a raw string (some drivers and test doubles).
 *
 * @returns The parsed value, or null when it cannot be read.
 */
function parseJsonColumn(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

/** Coerce a value read from jsonb into an ISO-8601 string. */
function toIsoString(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string') return raw;
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === 'number') return new Date(raw).toISOString();
  return undefined;
}

/**
 * Normalise one stored attempt record.
 *
 * Entries missing a usable cause are dropped rather than surfaced: a history
 * row without a reason is exactly the diagnostic gap this column exists to
 * close.
 *
 * @param raw              — The jsonb element.
 * @param fallbackFailedAt — Timestamp to use when the record carries none.
 */
function toFailureAttempt(raw: unknown, fallbackFailedAt: string): DlqFailureAttempt | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record['error'] !== 'string' || record['error'] === '') return null;

  const attempt = Number(record['attempt']);

  return {
    error: record['error'],
    attempt: Number.isFinite(attempt) ? attempt : 0,
    failedAt: toIsoString(record['failedAt']) ?? toIsoString(record['last_failed_at']) ?? fallbackFailedAt,
    ...(typeof record['source'] === 'string' ? { source: record['source'] } : {}),
  };
}

/**
 * Map the stored `failure_history` column onto the domain shape.
 *
 * Falls back to a single record derived from the entry's own `error` and
 * `first_failed_at` so an entry written before the history column existed (or
 * by an older version during a blue/green cutover) still reports the original
 * cause instead of appearing to have no history.
 */
function rowToFailureHistory(row: Record<string, unknown>): DlqFailureAttempt[] {
  const parsed = parseJsonColumn(row['failure_history']);
  // A record with no timestamp of its own is dated with the row's own
  // first-failure time, which is the earliest point the row can describe.
  const fallbackFailedAt = toIsoString(row['first_failed_at']) ?? new Date(0).toISOString();
  const history = Array.isArray(parsed)
    ? parsed.map((raw) => toFailureAttempt(raw, fallbackFailedAt)).filter((a): a is DlqFailureAttempt => a !== null)
    : [];

  if (history.length > 0) return history;

  const error = row['error'];
  if (typeof error !== 'string' || error === '') return [];

  const attempt = Number(row['attempts']);
  return [
    {
      error,
      attempt: Number.isFinite(attempt) ? attempt : 0,
      failedAt: fallbackFailedAt,
      source: 'legacy-row',
    },
  ];
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
    tenantId:      row['tenant_id']      as string | undefined,
    topic:         row['topic']          as string,
    payload:       row['payload']        as unknown,
    // The FIRST recorded cause. Later attempt failures live in failureHistory
    // and never overwrite this value.
    error:         row['error']          as string,
    attempts:      row['attempts']       as number,
    correlationId: row['correlation_id'] as string | undefined,
    firstFailedAt: (row['first_failed_at'] as Date).toISOString(),
    lastFailedAt:  (row['last_failed_at']  as Date).toISOString(),
    status:        row['status']         as 'dead' | 'replayed',
    failureHistory: rowToFailureHistory(row),
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

  /**
   * Insert a dead-letter entry, seeding its failure history.
   *
   * The enqueue is itself a failure, so the cause lands in `failure_history`
   * immediately. Callers that build an entry by hand may pass their own
   * history; otherwise the first cause is derived from `error`/`firstFailedAt`.
   */
  async insert(entry: DlqEntry): Promise<void> {
    const pool = getPool();
    const history: DlqFailureAttempt[] = entry.failureHistory?.length
      ? entry.failureHistory
      : [
          {
            error: entry.error,
            attempt: entry.attempts,
            failedAt: entry.firstFailedAt,
            source: FAILURE_SOURCE_ENQUEUE,
          },
        ];
    await query(
      pool,
      `INSERT INTO dead_letter_queue
         (id, tenant_id, topic, payload, error, attempts, correlation_id, first_failed_at, last_failed_at, status, failure_history)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        entry.id,
        entry.tenantId ?? null,
        entry.topic,
        safeSerializePayload(entry.payload),
        entry.error,
        entry.attempts,
        entry.correlationId ?? null,
        entry.firstFailedAt,
        entry.lastFailedAt,
        entry.status ?? 'dead',
        JSON.stringify(history),
      ],
    );
  },

  async findAll(opts: {
    limit: number;
    offset: number;
    topic?: string;
    tenantId?: string;
  }): Promise<{ entries: DlqEntry[]; total: number }> {
    const pool = getPool();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (opts.topic) {
      conditions.push(`topic = $${idx++}`);
      params.push(opts.topic);
    }
    if (opts.tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      params.push(opts.tenantId);
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

  /**
   * Append one attempt failure to a dead-lettered item's history.
   *
   * Append-only by construction:
   *  - `failure_history` is concatenated with the new record, so no previously
   *    recorded cause — least of all the first one — can be replaced.
   *  - `error` is deliberately NOT in the SET list: it keeps the first cause.
   *  - `attempts` is incremented and `last_failed_at` refreshed in the same
   *    statement, so the count and timestamp of each failure are recorded
   *    atomically with its cause.
   *
   * `attempt` and `failedAt` are built in SQL from the pre-update row so the
   * stored ordinal and timestamp always match the row they describe, even when
   * two failures are recorded concurrently. `last_failed_at` takes the same
   * value cast to timestamptz, so an unparseable timestamp fails the write
   * instead of being recorded verbatim.
   *
   * @param id      — The dead-letter entry id.
   * @param failure — Cause, source label, and timestamp for this attempt.
   * @returns The updated entry, or undefined when the id no longer exists.
   */
  async recordFailure(
    id: string,
    failure: { error: string; source: string; failedAt: string },
  ): Promise<DlqEntry | undefined> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      `UPDATE dead_letter_queue
          SET attempts         = GREATEST(0, attempts) + 1,
              last_failed_at   = $2::timestamptz,
              failure_history  = COALESCE(failure_history, '[]'::jsonb) || jsonb_build_array(
                                     jsonb_build_object(
                                       'error',    $3::text,
                                       'attempt',  GREATEST(0, attempts) + 1,
                                       'failedAt', to_jsonb($2::text),
                                       'source',   $4::text
                                     )
                                   )
        WHERE id = $1
      RETURNING *`,
      [id, failure.failedAt, failure.error, failure.source],
    );
    return result.rows[0] ? rowToEntry(result.rows[0]) : undefined;
  },

  async deleteById(id: string): Promise<boolean> {
    const pool = getPool();
    const result = await query(pool, 'DELETE FROM dead_letter_queue WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  },

  async deleteAll(topic?: string, tenantId?: string): Promise<number> {
    const pool = getPool();
    if (topic || tenantId) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (topic) { conditions.push(`topic = $${params.length + 1}`); params.push(topic); }
      if (tenantId) { conditions.push(`tenant_id = $${params.length + 1}`); params.push(tenantId); }
      const result = await query(pool, `DELETE FROM dead_letter_queue WHERE ${conditions.join(' AND ')}`, params);
      return result.rowCount ?? 0;
    }
    const result = await query(pool, 'DELETE FROM dead_letter_queue');
    return result.rowCount ?? 0;
  },

  /**
   * Purge terminal-state DLQ entries older than the given cutoff date.
   *
   * Terminal states:
   *   - `status = 'replayed'` — explicitly resolved by an operator replay.
   *   - `status = 'dead'` with `last_failed_at < cutoff` — entries that have
   *     been sitting dead beyond the retention window.  Because the
   *     dead_letter_queue table has no `max_attempts` column, the age-based
   *     heuristic serves as the "permanently failed" signal: if an entry has
   *     been dead for longer than the retention window, no operator or worker
   *     is actively retrying it.
   *
   * This method is called by the scheduled `dlq-purge` job in bounded
   * batches to avoid long-held locks on `dead_letter_queue`.
   *
   * **Security**: Only targets rows in terminal states; pending entries
   * (`status = 'dead'` with recent `last_failed_at`) are never touched.
   *
   * @param batchSize  — Maximum rows to delete in a single call.
   * @param cutoffDate — ISO-8601 timestamp; entries older than this are eligible.
   * @returns The number of rows deleted.
   */
  async purgeTerminalEntries(
    batchSize: number,
    cutoffDate: string,
    options: { tenantId?: string; dryRun?: boolean } = {},
  ): Promise<number> {
    const pool = getPool();
    const params: unknown[] = [batchSize, cutoffDate];
    const tenantClause = options.tenantId
      ? ` AND tenant_id = $${params.push(options.tenantId)}`
      : ' AND tenant_id IS NULL';
    const candidateQuery = `SELECT id FROM dead_letter_queue
      WHERE last_failed_at < $2 AND (status = 'replayed' OR status = 'dead')${tenantClause}
      ORDER BY last_failed_at ASC LIMIT $1`;
    if (options.dryRun) {
      const result = await query(pool, `SELECT COUNT(*)::int AS count FROM (${candidateQuery}) eligible`, params);
      return Number(result.rows[0]?.count ?? 0);
    }
    const result = await query(pool, `DELETE FROM dead_letter_queue WHERE id IN (${candidateQuery})`, params);
    return result.rowCount ?? 0;
  },

  async replayEntry(id: string, patch: Partial<Pick<DlqEntry, 'attempts' | 'lastFailedAt'>>): Promise<boolean> {
    const pool = getPool();
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (patch.attempts !== undefined) { sets.push(`attempts = $${idx++}`); params.push(patch.attempts); }
    if (patch.lastFailedAt !== undefined) { sets.push(`last_failed_at = $${idx++}`); params.push(patch.lastFailedAt); }
    sets.push(`status = $${idx++}`); params.push('replayed');

    params.push(id);
    const result = await query(
      pool,
      `UPDATE dead_letter_queue SET ${sets.join(', ')} WHERE id = $${idx} AND status = 'dead'`,
      params
    );
    return (result.rowCount ?? 0) > 0;
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
   * Defensive: Clamps consecutive_failures to a minimum of 0 (using GREATEST) before
   * incrementing, guarding against negative counts.
   * If the new count meets or exceeds the threshold, sets suspended = TRUE and
   * records suspended_at.
   *
   * @param topic - The DLQ topic/consumer identifier.
   * @returns The updated suspension state.
   */
  async recordReplayFailure(topic: string): Promise<ConsumerSuspension> {
    const pool = getPool();
    const threshold = getSuspensionThreshold();

    const result = await query<Record<string, unknown>>(
      pool,
      `INSERT INTO dlq_consumer_suspension (topic, consecutive_failures, suspended, suspended_at, updated_at)
         VALUES ($1, 1, (1 >= $2), CASE WHEN 1 >= $2 THEN now() ELSE NULL END, now())
       ON CONFLICT (topic) DO UPDATE
         SET consecutive_failures = GREATEST(0, dlq_consumer_suspension.consecutive_failures) + 1,
             suspended = (GREATEST(0, dlq_consumer_suspension.consecutive_failures) + 1 >= $2),
             suspended_at = CASE
               WHEN dlq_consumer_suspension.suspended = FALSE
                AND (GREATEST(0, dlq_consumer_suspension.consecutive_failures) + 1 >= $2)
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
   * Defensive: Explicitly sets consecutive_failures to 0 (non-negative).
   * A no-op if no suspension row exists.
   *
   * @param topic - The DLQ topic/consumer identifier.
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
   * Re-enable a suspended consumer, clearing the suspension flag and resetting
   * consecutive_failures to 0 (non-negative).
   *
   * @param topic - The DLQ topic/consumer identifier.
   * @returns The updated row, or null if the topic has no suspension record.
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
