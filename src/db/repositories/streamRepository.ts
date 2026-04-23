/**
 * Stream Repository - Database operations for streams table
 *
 * Implements idempotent event ingestion from blockchain events.
 * Handles out-of-order events and ensures data consistency.
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

import { getDatabase } from "../connection.js";
import {
  StreamRecord,
  CreateStreamInput,
  UpdateStreamInput,
  StreamFilter,
  PaginationOptions,
  PaginatedStreams,
  STREAM_INVARIANTS,
  StreamStatus,
} from "../types.js";
import { info, warn, error as logError, debug } from "../../utils/logger.js";
import {
  buildAuditEntry,
  writeAuditEntryToDb,
  type AuditAction,
  type AuditDbConnection,
} from "../../lib/auditLog.js";

/**
 * Result of an upsert operation
 */
export interface UpsertResult {
  created: boolean;
  updated: boolean;
  stream: StreamRecord;
}

// ── Transactional operation options ──────────────────────────────────────────

/**
 * Options shared by all transactional write operations.
 */
export interface TransactionOptions {
  /** Correlation ID for tracing across stream + audit + webhook rows. */
  correlationId?: string;
  /**
   * When provided, a row is inserted into `webhook_outbox` inside the same
   * transaction so webhook delivery is guaranteed-or-nothing with the stream
   * write.  Pass `null` to skip webhook outbox (e.g. internal indexer events).
   */
  webhookEvent?: WebhookOutboxPayload | null;
}

/**
 * Minimal payload written to the `webhook_outbox` table.
 * The dispatcher picks this up asynchronously.
 */
export interface WebhookOutboxPayload {
  eventType: string;
  /** JSON-serialisable event data — amounts must be decimal strings. */
  data: Record<string, unknown>;
}

/**
 * Result of a transactional upsert — extends UpsertResult with the audit seq.
 */
export interface TransactionalUpsertResult extends UpsertResult {
  auditSeq: number;
}

/**
 * Result of a transactional update.
 */
export interface TransactionalUpdateResult {
  stream: StreamRecord;
  auditSeq: number;
}

/**
 * Stream repository with idempotent event handling
 */
export const streamRepository = {
  /**
   * Create or update a stream from a blockchain event.
   *
   * IDEMPOTENCY: Uses transaction_hash + event_index as unique constraint.
   * If an event with the same transaction hash and event index already exists,
   * the operation is idempotent - returns the existing record without modification.
   *
   * HANDLES OUT-OF-ORDER: If a later event arrives before an earlier one,
   * both are handled correctly - earlier event creates the record,
   * later event updates it.
   *
   * @param input - Stream data from blockchain event
   * @param correlationId - Request ID for tracing
   * @returns UpsertResult with created/updated flag and stream record
   */
  upsertStream(input: CreateStreamInput, correlationId?: string): UpsertResult {
    const db = getDatabase();
    const now = new Date().toISOString();

    // Validate input
    const validation = validateStreamInput(input);
    if (!validation.valid) {
      throw new Error(`Invalid stream input: ${validation.errors.join(", ")}`);
    }

    // Check if stream already exists (idempotency check)
    const existing = db
      .prepare(
        `
      SELECT * FROM streams 
      WHERE transaction_hash = ? AND event_index = ?
    `,
      )
      .get(input.transaction_hash, input.event_index) as
      | StreamRecord
      | undefined;

    if (existing) {
      debug("Stream already exists (idempotent)", {
        id: existing.id,
        txHash: input.transaction_hash,
        correlationId,
      });
      return { created: false, updated: false, stream: existing };
    }

    // Check if stream ID already exists (possible from different event in same tx)
    const existingById = db
      .prepare("SELECT * FROM streams WHERE id = ?")
      .get(input.id) as StreamRecord | undefined;

    if (existingById) {
      // Update existing record - handle out-of-order events
      info("Updating existing stream with new event data", {
        id: input.id,
        correlationId,
      });

      const stmt = db.prepare(`
        UPDATE streams SET
          sender_address = ?,
          recipient_address = ?,
          amount = ?,
          streamed_amount = ?,
          remaining_amount = ?,
          rate_per_second = ?,
          start_time = ?,
          end_time = ?,
          status = ?,
          contract_id = ?,
          transaction_hash = ?,
          event_index = ?,
          updated_at = ?
        WHERE id = ?
      `);

      stmt.run(
        input.sender_address,
        input.recipient_address,
        input.amount,
        input.streamed_amount,
        input.remaining_amount,
        input.rate_per_second,
        input.start_time,
        input.end_time,
        "active",
        input.contract_id,
        input.transaction_hash,
        input.event_index,
        now,
        input.id,
      );

      const updated = db
        .prepare("SELECT * FROM streams WHERE id = ?")
        .get(input.id) as StreamRecord;
      return { created: false, updated: true, stream: updated };
    }

    // Create new stream record
    info("Creating new stream from event", {
      id: input.id,
      correlationId,
    });

    const stmt = db.prepare(`
      INSERT INTO streams (
        id, sender_address, recipient_address, amount, streamed_amount,
        remaining_amount, rate_per_second, start_time, end_time, status,
        contract_id, transaction_hash, event_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      input.id,
      input.sender_address,
      input.recipient_address,
      input.amount,
      input.streamed_amount,
      input.remaining_amount,
      input.rate_per_second,
      input.start_time,
      input.end_time,
      "active",
      input.contract_id,
      input.transaction_hash,
      input.event_index,
      now,
      now,
    );

    const stream = db
      .prepare("SELECT * FROM streams WHERE id = ?")
      .get(input.id) as StreamRecord;
    return { created: true, updated: false, stream };
  },

  /**
   * Update stream status and/or amounts
   *
   * Validates status transitions according to state machine
   */
  updateStream(
    id: string,
    input: UpdateStreamInput,
    correlationId?: string,
  ): StreamRecord {
    const db = getDatabase();
    const now = new Date().toISOString();

    // Get current stream
    const current = db.prepare("SELECT * FROM streams WHERE id = ?").get(id) as
      | StreamRecord
      | undefined;

    if (!current) {
      throw new Error(`Stream not found: ${id}`);
    }

    // Validate status transition
    if (
      input.status &&
      !isValidStatusTransition(current.status, input.status)
    ) {
      throw new Error(
        `Invalid status transition: ${current.status} -> ${input.status}. ` +
          `Valid transitions: ${STREAM_INVARIANTS.validTransitions[current.status].join(", ")}`,
      );
    }

    // Build update query
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

    const stmt = db.prepare(
      `UPDATE streams SET ${updates.join(", ")} WHERE id = ?`,
    );
    stmt.run(...values);

    info("Stream updated", { id, input, correlationId });

    return db
      .prepare("SELECT * FROM streams WHERE id = ?")
      .get(id) as StreamRecord;
  },

  /**
   * Get stream by ID
   */
  getById(id: string): StreamRecord | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM streams WHERE id = ?").get(id) as
      | StreamRecord
      | undefined;
  },

  /**
   * Get stream by transaction hash and event index (for idempotency check)
   */
  getByEvent(
    transactionHash: string,
    eventIndex: number,
  ): StreamRecord | undefined {
    const db = getDatabase();
    return db
      .prepare(
        `
      SELECT * FROM streams 
      WHERE transaction_hash = ? AND event_index = ?
    `,
      )
      .get(transactionHash, eventIndex) as StreamRecord | undefined;
  },

  /**
   * Query streams with filtering and pagination
   */
  find(filter: StreamFilter, pagination: PaginationOptions): PaginatedStreams {
    const db = getDatabase();

    // Build WHERE clause
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }

    if (filter.sender_address) {
      conditions.push("sender_address = ?");
      params.push(filter.sender_address);
    }

    if (filter.recipient_address) {
      conditions.push("recipient_address = ?");
      params.push(filter.recipient_address);
    }

    if (filter.contract_id) {
      conditions.push("contract_id = ?");
      params.push(filter.contract_id);
    }

    if (filter.start_time_from !== undefined) {
      conditions.push("start_time >= ?");
      params.push(filter.start_time_from);
    }

    if (filter.start_time_to !== undefined) {
      conditions.push("start_time <= ?");
      params.push(filter.start_time_to);
    }

    if (filter.end_time_from !== undefined) {
      conditions.push("end_time >= ?");
      params.push(filter.end_time_from);
    }

    if (filter.end_time_to !== undefined) {
      conditions.push("end_time <= ?");
      params.push(filter.end_time_to);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countResult = db
      .prepare(`SELECT COUNT(*) as total FROM streams ${whereClause}`)
      .get(...params) as { total: number };
    const total = countResult.total;

    // Get paginated results
    const query = `
      SELECT * FROM streams 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    params.push(pagination.limit, pagination.offset);
    const streams = db.prepare(query).all(...params) as StreamRecord[];

    return {
      streams,
      total,
      limit: pagination.limit,
      offset: pagination.offset,
      hasMore: pagination.offset + streams.length < total,
    };
  },

  /**
   * Get all streams (for backwards compatibility)
   */
  getAll(): StreamRecord[] {
    const db = getDatabase();
    return db
      .prepare("SELECT * FROM streams ORDER BY created_at DESC")
      .all() as StreamRecord[];
  },

  /**
   * Count streams by status
   */
  countByStatus(): Record<StreamStatus, number> {
    const db = getDatabase();
    const results = db
      .prepare(
        `
      SELECT status, COUNT(*) as count FROM streams GROUP BY status
    `,
      )
      .all() as { status: StreamStatus; count: number }[];

    const counts: Record<StreamStatus, number> = {
      active: 0,
      paused: 0,
      completed: 0,
      cancelled: 0,
    };

    for (const row of results) {
      counts[row.status] = row.count;
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

/**
 * Validate stream input data
 */
function validateStreamInput(input: CreateStreamInput): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Validate ID format
  if (!STREAM_INVARIANTS.idPattern.test(input.id)) {
    errors.push(`Invalid ID format: ${input.id}`);
  }

  // Validate addresses (basic Stellar address format check)
  if (!input.sender_address || !input.sender_address.startsWith("G")) {
    errors.push(`Invalid sender address: ${input.sender_address}`);
  }

  if (!input.recipient_address || !input.recipient_address.startsWith("G")) {
    errors.push(`Invalid recipient address: ${input.recipient_address}`);
  }

  // Validate amounts
  if (!/^\d+(\.\d+)?$/.test(input.amount)) {
    errors.push(`Invalid amount format: ${input.amount}`);
  }

  if (!/^\d+(\.\d+)?$/.test(input.rate_per_second)) {
    errors.push(`Invalid rate_per_second format: ${input.rate_per_second}`);
  }

  // Validate timestamps
  if (
    input.start_time < STREAM_INVARIANTS.timestampConstraints.minTime ||
    input.start_time > STREAM_INVARIANTS.timestampConstraints.maxTime
  ) {
    errors.push(`Invalid start_time: ${input.start_time}`);
  }

  if (
    input.end_time < STREAM_INVARIANTS.timestampConstraints.minTime ||
    input.end_time > STREAM_INVARIANTS.timestampConstraints.maxTime
  ) {
    errors.push(`Invalid end_time: ${input.end_time}`);
  }

  // Validate transaction hash
  if (!/^[a-f0-9]{64}$/.test(input.transaction_hash)) {
    errors.push(`Invalid transaction hash: ${input.transaction_hash}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if status transition is valid
 */
function isValidStatusTransition(
  from: StreamStatus,
  to: StreamStatus,
): boolean {
  const transitions: readonly string[] =
    STREAM_INVARIANTS.validTransitions[from];
  if (!transitions) return false;
  return transitions.includes(to);
}

// ── Transaction helpers ───────────────────────────────────────────────────────

/**
 * Build metadata for audit entries from a CreateStreamInput.
 * Amounts are kept as decimal strings — never converted to numbers.
 */
function buildStreamMeta(input: CreateStreamInput): Record<string, unknown> {
  return {
    sender: input.sender_address,
    recipient: input.recipient_address,
    amount: input.amount,
    ratePerSecond: input.rate_per_second,
    contractId: input.contract_id,
    transactionHash: input.transaction_hash,
    eventIndex: input.event_index,
  };
}

/**
 * Insert a row into `webhook_outbox` if a payload was provided.
 * Must be called inside an open transaction.
 * Silently skips when `payload` is null/undefined.
 */
function maybeWriteWebhookOutbox(
  db: AuditDbConnection,
  streamId: string,
  payload: WebhookOutboxPayload | null | undefined,
): void {
  if (!payload) return;

  db.prepare(
    `INSERT INTO webhook_outbox (stream_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    streamId,
    payload.eventType,
    JSON.stringify(payload.data),
    new Date().toISOString(),
  );
}
