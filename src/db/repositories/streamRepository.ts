/**
 * Stream Repository — PostgreSQL-backed CRUD for the streams table.
 *
 * All public methods are async and use the shared pg Pool from src/db/pool.ts.
 *
 * Idempotency guarantee:
 *   upsertStream uses INSERT … ON CONFLICT DO NOTHING so the same
 *   (transaction_hash, event_index) pair is safe to submit multiple times.
 *
 * Decimal-string invariant:
 *   Amount columns are stored and returned as TEXT.  No numeric coercion
 *   is performed here — callers own that responsibility.
 *
 * Transactional operations
 * ------------------------
 * `transactionalUpsertStream` and `transactionalUpdateStream` wrap the stream
 * write, an audit_logs row, and an optional webhook_outbox row inside a single
 * SQLite transaction.  If any step fails the entire transaction is rolled back,
 * guaranteeing that the three tables are always in sync.
 *
 * Decimal-string amounts
 * ----------------------
 * All monetary fields (amount, streamed_amount, remaining_amount,
 * rate_per_second) are stored and returned as TEXT.  The repository never
 * converts them to numbers, preserving full precision across the
 * chain → DB → API boundary.
 *
 * @module db/repositories/streamRepository
 */

import { getPool, query, DuplicateEntryError } from '../pool.js';
import {
  StreamRecord,
  CreateStreamInput,
  UpdateStreamInput,
  StreamFilter,
  PaginationOptions,
  PaginatedStreams,
  STREAM_INVARIANTS,
  StreamStatus,
} from '../types.js';
import { info, warn, debug } from '../../utils/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UpsertResult {
  created: boolean;
  stream: StreamRecord;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Map a raw pg row to a typed StreamRecord.
 * pg returns BIGINT columns as strings — coerce start_time / end_time to number.
 */
function rowToRecord(row: Record<string, unknown>): StreamRecord {
  return {
    id:                row['id']                as string,
    sender_address:    row['sender_address']    as string,
    recipient_address: row['recipient_address'] as string,
    amount:            row['amount']            as string,
    streamed_amount:   row['streamed_amount']   as string,
    remaining_amount:  row['remaining_amount']  as string,
    rate_per_second:   row['rate_per_second']   as string,
    start_time:        Number(row['start_time']),
    end_time:          Number(row['end_time']),
    status:            row['status']            as StreamStatus,
    contract_id:       row['contract_id']       as string,
    transaction_hash:  row['transaction_hash']  as string,
    event_index:       row['event_index']       as number,
    created_at:        (row['created_at'] as Date).toISOString(),
    updated_at:        (row['updated_at'] as Date).toISOString(),
  };
}

function isValidStatusTransition(from: StreamStatus, to: StreamStatus): boolean {
  const allowed: readonly string[] = STREAM_INVARIANTS.validTransitions[from] ?? [];
  return allowed.includes(to);
}

// ── Repository ────────────────────────────────────────────────────────────────

export const streamRepository = {
  /**
   * Insert a stream from a blockchain event.
   *
   * Uses INSERT … ON CONFLICT DO NOTHING for idempotency.
   * If the (transaction_hash, event_index) pair already exists the existing
   * record is returned with created=false.
   */
  async upsertStream(
    input: CreateStreamInput,
    correlationId?: string,
  ): Promise<UpsertResult> {
    const pool = getPool();

    const insertSql = `
      INSERT INTO streams (
        id, sender_address, recipient_address,
        amount, streamed_amount, remaining_amount, rate_per_second,
        start_time, end_time, status,
        contract_id, transaction_hash, event_index,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6, $7,
        $8, $9, 'active',
        $10, $11, $12,
        NOW(), NOW()
      )
      ON CONFLICT (transaction_hash, event_index) DO NOTHING
      RETURNING *
    `;

    const params = [
      input.id,
      input.sender_address,
      input.recipient_address,
      input.amount,
      input.streamed_amount,
      input.remaining_amount,
      input.rate_per_second,
      input.start_time,
      input.end_time,
      input.contract_id,
      input.transaction_hash,
      input.event_index,
    ];

    const result = await query<Record<string, unknown>>(pool, insertSql, params);

    if (result.rows.length > 0) {
      const stream = rowToRecord(result.rows[0]!);
      info('Stream created from event', { id: stream.id, correlationId });
      return { created: true, stream };
    }

    // Row already existed — fetch it
    const existing = await this.getById(input.id);
    if (!existing) {
      // Edge case: conflict on tx_hash+event_index but different id — fetch by event
      const byEvent = await this.getByEvent(input.transaction_hash, input.event_index);
      if (!byEvent) throw new Error('Idempotency conflict: stream not found after insert conflict');
      debug('Stream already exists (idempotent)', { id: byEvent.id, correlationId });
      return { created: false, stream: byEvent };
    }

    debug('Stream already exists (idempotent)', { id: existing.id, correlationId });
    return { created: false, stream: existing };
  },

  /**
   * Update stream status and/or amounts.
   * Validates status transitions against the state machine.
   */
  async updateStream(
    id: string,
    input: UpdateStreamInput,
    correlationId?: string,
  ): Promise<StreamRecord> {
    const pool = getPool();

    const current = await this.getById(id);
    if (!current) throw new Error(`Stream not found: ${id}`);

    if (input.status && !isValidStatusTransition(current.status, input.status)) {
      const allowed = STREAM_INVARIANTS.validTransitions[current.status].join(', ');
      throw new Error(
        `Invalid status transition: ${current.status} → ${input.status}. Allowed: ${allowed || 'none'}`,
      );
    }

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[]    = [];
    let   idx                  = 1;

    if (input.status !== undefined) {
      setClauses.push(`status = $${idx++}`);
      values.push(input.status);
    }
    if (input.streamed_amount !== undefined) {
      setClauses.push(`streamed_amount = $${idx++}`);
      values.push(input.streamed_amount);
    }
    if (input.remaining_amount !== undefined) {
      setClauses.push(`remaining_amount = $${idx++}`);
      values.push(input.remaining_amount);
    }
    if (input.end_time !== undefined) {
      setClauses.push(`end_time = $${idx++}`);
      values.push(input.end_time);
    }

    values.push(id);
    const sql = `UPDATE streams SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`;

    const result = await query<Record<string, unknown>>(pool, sql, values);
    if (result.rows.length === 0) throw new Error(`Stream not found after update: ${id}`);

    info('Stream updated', { id, input, correlationId });
    return rowToRecord(result.rows[0]!);
  },

  /** Fetch a single stream by its primary key. */
  async getById(id: string): Promise<StreamRecord | undefined> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      'SELECT * FROM streams WHERE id = $1',
      [id],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  },

  /** Fetch a stream by its blockchain event coordinates (for idempotency). */
  async getByEvent(
    transactionHash: string,
    eventIndex: number,
  ): Promise<StreamRecord | undefined> {
    const pool = getPool();
    const result = await query<Record<string, unknown>>(
      pool,
      'SELECT * FROM streams WHERE transaction_hash = $1 AND event_index = $2',
      [transactionHash, eventIndex],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  },

  /**
   * Cursor-based paginated list with optional filters.
   *
   * Cursor encodes the last seen `id` (lexicographic ordering).
   * Filters map directly to WHERE clauses — all are optional.
   */
  async findWithCursor(
    filter: StreamFilter,
    limit: number,
    afterId?: string,
    includeTotal?: boolean,
  ): Promise<{ streams: StreamRecord[]; hasMore: boolean; total?: number }> {
    const pool = getPool();

    const conditions: string[] = [];
    const params: unknown[]    = [];
    let   idx                  = 1;

    if (filter.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filter.status);
    }
    if (filter.sender_address) {
      conditions.push(`sender_address = $${idx++}`);
      params.push(filter.sender_address);
    }
    if (filter.recipient_address) {
      conditions.push(`recipient_address = $${idx++}`);
      params.push(filter.recipient_address);
    }
    if (filter.contract_id) {
      conditions.push(`contract_id = $${idx++}`);
      params.push(filter.contract_id);
    }

    const whereBase = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Cursor condition appended separately so total count excludes it
    const cursorConditions = [...conditions];
    const cursorParams     = [...params];

    if (afterId) {
      cursorConditions.push(`id > $${idx++}`);
      cursorParams.push(afterId);
    }

    const whereCursor =
      cursorConditions.length > 0 ? `WHERE ${cursorConditions.join(' AND ')}` : '';

    // Fetch limit+1 to detect hasMore
    const dataSql = `
      SELECT * FROM streams
      ${whereCursor}
      ORDER BY id ASC
      LIMIT $${idx}
    `;
    cursorParams.push(limit + 1);

    const [dataResult, countResult] = await Promise.all([
      query<Record<string, unknown>>(pool, dataSql, cursorParams),
      includeTotal
        ? query<{ count: string }>(pool, `SELECT COUNT(*) AS count FROM streams ${whereBase}`, params)
        : Promise.resolve(null),
    ]);

    const hasMore = dataResult.rows.length > limit;
    const rows    = hasMore ? dataResult.rows.slice(0, limit) : dataResult.rows;
    const streams = rows.map(rowToRecord);

    return {
      streams,
      hasMore,
      total: countResult ? Number(countResult.rows[0]!.count) : undefined,
    };
  },

  /**
   * Offset-based paginated list (used by internal/indexer consumers).
   */
  async find(filter: StreamFilter, pagination: PaginationOptions): Promise<PaginatedStreams> {
    const pool = getPool();

    const conditions: string[] = [];
    const params: unknown[]    = [];
    let   idx                  = 1;

    if (filter.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filter.status);
    }
    if (filter.sender_address) {
      conditions.push(`sender_address = $${idx++}`);
      params.push(filter.sender_address);
    }
    if (filter.recipient_address) {
      conditions.push(`recipient_address = $${idx++}`);
      params.push(filter.recipient_address);
    }
    if (filter.contract_id) {
      conditions.push(`contract_id = $${idx++}`);
      params.push(filter.contract_id);
    }
    if (filter.start_time_from !== undefined) {
      conditions.push(`start_time >= $${idx++}`);
      params.push(filter.start_time_from);
    }
    if (filter.start_time_to !== undefined) {
      conditions.push(`start_time <= $${idx++}`);
      params.push(filter.start_time_to);
    }
    if (filter.end_time_from !== undefined) {
      conditions.push(`end_time >= $${idx++}`);
      params.push(filter.end_time_from);
    }
    if (filter.end_time_to !== undefined) {
      conditions.push(`end_time <= $${idx++}`);
      params.push(filter.end_time_to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countParams = [...params];
    const dataParams  = [...params, pagination.limit, pagination.offset];

    const [countResult, dataResult] = await Promise.all([
      query<{ count: string }>(pool, `SELECT COUNT(*) AS count FROM streams ${where}`, countParams),
      query<Record<string, unknown>>(
        pool,
        `SELECT * FROM streams ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        dataParams,
      ),
    ]);

    const total   = Number(countResult.rows[0]!.count);
    const streams = dataResult.rows.map(rowToRecord);

    return {
      streams,
      total,
      limit:   pagination.limit,
      offset:  pagination.offset,
      hasMore: pagination.offset + streams.length < total,
    };
  },

  /** Count streams grouped by status. */
  async countByStatus(): Promise<Record<StreamStatus, number>> {
    const pool = getPool();
    const result = await query<{ status: StreamStatus; count: string }>(
      pool,
      'SELECT status, COUNT(*) AS count FROM streams GROUP BY status',
    );

    const counts: Record<StreamStatus, number> = {
      active: 0, paused: 0, completed: 0, cancelled: 0,
    };
    for (const row of result.rows) {
      counts[row.status] = Number(row.count);
    }
    return counts;
  },

  // ── Transactional operations ──────────────────────────────────────────────

  /**
   * Atomically create-or-update a stream, write an audit_logs row, and
   * optionally enqueue a webhook_outbox row — all in one SQLite transaction.
   *
   * On any failure the entire transaction is rolled back so the three tables
   * remain in sync.  Decimal-string amounts are preserved as-is.
   *
   * @param input         Stream data from blockchain event
   * @param auditAction   Audit action to record (e.g. 'STREAM_CREATED')
   * @param opts          Correlation ID and optional webhook payload
   */
  transactionalUpsertStream(
    input: CreateStreamInput,
    auditAction: AuditAction,
    opts: TransactionOptions = {},
  ): TransactionalUpsertResult {
    const db = getDatabase();

    // Validate before opening the transaction to fail fast.
    const validation = validateStreamInput(input);
    if (!validation.valid) {
      throw new Error(`Invalid stream input: ${validation.errors.join(", ")}`);
    }

    const txn = db.transaction((): TransactionalUpsertResult => {
      const now = new Date().toISOString();

      // ── 1. Stream upsert (idempotent) ──────────────────────────────────
      const existing = db
        .prepare(
          `SELECT * FROM streams WHERE transaction_hash = ? AND event_index = ?`,
        )
        .get(input.transaction_hash, input.event_index) as StreamRecord | undefined;

      if (existing) {
        debug("Stream already exists (idempotent)", {
          id: existing.id,
          txHash: input.transaction_hash,
          correlationId: opts.correlationId,
        });
        // Still write audit + webhook so callers get consistent results.
        const auditEntry = buildAuditEntry(
          auditAction,
          "stream",
          existing.id,
          opts.correlationId,
          buildStreamMeta(input),
        );
        writeAuditEntryToDb(db, auditEntry);
        maybeWriteWebhookOutbox(db, existing.id, opts.webhookEvent);
        return { created: false, updated: false, stream: existing, auditSeq: auditEntry.seq };
      }

      const existingById = db
        .prepare("SELECT * FROM streams WHERE id = ?")
        .get(input.id) as StreamRecord | undefined;

      let stream: StreamRecord;
      let created: boolean;
      let updated: boolean;

      if (existingById) {
        // Out-of-order event: update existing record.
        info("Updating existing stream with new event data (transactional)", {
          id: input.id,
          correlationId: opts.correlationId,
        });

        db.prepare(`
          UPDATE streams SET
            sender_address = ?, recipient_address = ?,
            amount = ?, streamed_amount = ?, remaining_amount = ?,
            rate_per_second = ?, start_time = ?, end_time = ?,
            status = ?, contract_id = ?,
            transaction_hash = ?, event_index = ?, updated_at = ?
          WHERE id = ?
        `).run(
          input.sender_address, input.recipient_address,
          input.amount, input.streamed_amount, input.remaining_amount,
          input.rate_per_second, input.start_time, input.end_time,
          "active", input.contract_id,
          input.transaction_hash, input.event_index, now,
          input.id,
        );

        stream = db.prepare("SELECT * FROM streams WHERE id = ?").get(input.id) as StreamRecord;
        created = false;
        updated = true;
      } else {
        // New stream.
        info("Creating new stream from event (transactional)", {
          id: input.id,
          correlationId: opts.correlationId,
        });

        db.prepare(`
          INSERT INTO streams (
            id, sender_address, recipient_address, amount, streamed_amount,
            remaining_amount, rate_per_second, start_time, end_time, status,
            contract_id, transaction_hash, event_index, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.id,
          input.sender_address, input.recipient_address,
          input.amount, input.streamed_amount, input.remaining_amount,
          input.rate_per_second, input.start_time, input.end_time,
          "active", input.contract_id,
          input.transaction_hash, input.event_index,
          now, now,
        );

        stream = db.prepare("SELECT * FROM streams WHERE id = ?").get(input.id) as StreamRecord;
        created = true;
        updated = false;
      }

      // ── 2. Audit log row ───────────────────────────────────────────────
      const auditEntry = buildAuditEntry(
        auditAction,
        "stream",
        stream.id,
        opts.correlationId,
        buildStreamMeta(input),
      );
      writeAuditEntryToDb(db, auditEntry);

      // ── 3. Webhook outbox row (optional) ──────────────────────────────
      maybeWriteWebhookOutbox(db, stream.id, opts.webhookEvent);

      return { created, updated, stream, auditSeq: auditEntry.seq };
    });

    try {
      return txn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("Transaction rolled back (upsertStream)", {
        id: input.id,
        error: message,
        correlationId: opts.correlationId,
      });
      throw err;
    }
  },

  /**
   * Atomically update a stream's status/amounts, write an audit_logs row, and
   * optionally enqueue a webhook_outbox row — all in one SQLite transaction.
   *
   * Validates the status-machine transition before opening the transaction.
   * On any failure the entire transaction is rolled back.
   *
   * @param id          Stream ID
   * @param input       Fields to update
   * @param auditAction Audit action to record (e.g. 'STREAM_CANCELLED')
   * @param opts        Correlation ID and optional webhook payload
   */
  transactionalUpdateStream(
    id: string,
    input: UpdateStreamInput,
    auditAction: AuditAction,
    opts: TransactionOptions = {},
  ): TransactionalUpdateResult {
    const db = getDatabase();

    const txn = db.transaction((): TransactionalUpdateResult => {
      const now = new Date().toISOString();

      // ── 1. Fetch current record (inside txn for consistent read) ───────
      const current = db
        .prepare("SELECT * FROM streams WHERE id = ?")
        .get(id) as StreamRecord | undefined;

      if (!current) {
        throw new Error(`Stream not found: ${id}`);
      }

      // ── 2. Validate status transition ──────────────────────────────────
      if (input.status && !isValidStatusTransition(current.status, input.status)) {
        throw new Error(
          `Invalid status transition: ${current.status} -> ${input.status}. ` +
            `Valid transitions: ${STREAM_INVARIANTS.validTransitions[current.status].join(", ")}`,
        );
      }

      // ── 3. Build and execute UPDATE ────────────────────────────────────
      const updates: string[] = ["updated_at = ?"];
      const values: (string | number)[] = [now];

      if (input.status !== undefined) {
        updates.push("status = ?");
        values.push(input.status);
      }
      if (input.streamed_amount !== undefined) {
        updates.push("streamed_amount = ?");
        values.push(input.streamed_amount);
      }
      if (input.remaining_amount !== undefined) {
        updates.push("remaining_amount = ?");
        values.push(input.remaining_amount);
      }
      if (input.end_time !== undefined) {
        updates.push("end_time = ?");
        values.push(input.end_time);
      }

      values.push(id);
      db.prepare(`UPDATE streams SET ${updates.join(", ")} WHERE id = ?`).run(...values);

      const stream = db
        .prepare("SELECT * FROM streams WHERE id = ?")
        .get(id) as StreamRecord;

      info("Stream updated (transactional)", { id, input, correlationId: opts.correlationId });

      // ── 4. Audit log row ───────────────────────────────────────────────
      const auditEntry = buildAuditEntry(
        auditAction,
        "stream",
        id,
        opts.correlationId,
        { previousStatus: current.status, ...input } as Record<string, unknown>,
      );
      writeAuditEntryToDb(db, auditEntry);

      // ── 5. Webhook outbox row (optional) ──────────────────────────────
      maybeWriteWebhookOutbox(db, id, opts.webhookEvent);

      return { stream, auditSeq: auditEntry.seq };
    });

    try {
      return txn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("Transaction rolled back (updateStream)", {
        id,
        error: message,
        correlationId: opts.correlationId,
      });
      throw err;
    }
  },
};
