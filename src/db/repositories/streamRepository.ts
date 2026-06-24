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

import { getPool, query } from '../pool.js';
import { getReadPool } from '../replicaPool.js';
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
import { info, debug } from '../../utils/logger.js';
import { dbQueryDurationSeconds } from '../../metrics/dbMetrics.js';
import { enrichActiveSpanWithStream } from '../../tracing/hooks.js';
import { getConfig } from '../../config/env.js';
import { computeAddressHashes } from '../../pii/pgcryptoEncryption.js';
import {
  encryptAddressValue,
  streamSelectColumns,
  senderAddressFilterCondition,
  recipientAddressFilterCondition,
} from '../queries/streams.js';


const REPO = 'streamRepository';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UpsertResult {
  created: boolean;
  stream: StreamRecord;
}

export interface StreamExistenceRecord {
  updated_at: string;
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

function resolvePgcryptoKeys(): { current: string; previous?: string } {
  const config = getConfig();
  if (!config.pgcryptoKey) {
    throw new Error('PGCRYPTO_KEY is required to encrypt and decrypt stream PII');
  }
  return { current: config.pgcryptoKey, previous: config.pgcryptoKeyPrevious };
}

function isValidStatusTransition(from: StreamStatus, to: StreamStatus): boolean {
  const allowed: readonly string[] = STREAM_INVARIANTS.validTransitions[from] ?? [];
  return allowed.includes(to);
}

// ── Repository ────────────────────────────────────────────────────────────────

/** Wrap an async operation with a histogram timer. */
async function timed<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const end = dbQueryDurationSeconds.startTimer({ repository: REPO, operation });
  try {
    return await fn();
  } finally {
    end();
  }
}

export const streamRepository = {
  /**
   * Insert a stream from a blockchain event.
   * Uses INSERT … ON CONFLICT DO NOTHING for idempotency.
   */
  async upsertStream(input: CreateStreamInput, correlationId?: string): Promise<UpsertResult> {
    enrichActiveSpanWithStream(input.id, input.sender_address, input.recipient_address);
    return timed('upsertStream', async () => {
      const pool = getPool();
      const keySet = resolvePgcryptoKeys();
      const senderHashes = computeAddressHashes(input.sender_address, keySet);
      const recipientHashes = computeAddressHashes(input.recipient_address, keySet);

      const params: unknown[] = [
        input.id,
        input.sender_address,
        keySet.current,
        senderHashes.current,
        input.recipient_address,
        recipientHashes.current,
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

      const decryptionPreviousKeyIndex = keySet.previous ? params.length + 1 : undefined;
      if (keySet.previous) {
        params.push(keySet.previous);
      }

      const insertSql = `
        INSERT INTO streams (
          id, sender_address, sender_address_hash,
          recipient_address, recipient_address_hash,
          amount, streamed_amount, remaining_amount, rate_per_second,
          start_time, end_time, status,
          contract_id, transaction_hash, event_index,
          created_at, updated_at
        ) VALUES (
          $1, ${encryptAddressValue(2, 3)}, $4,
          ${encryptAddressValue(5, 3)}, $6,
          $7, $8, $9, $10,
          $11, $12, 'active',
          $13, $14, $15,
          NOW(), NOW()
        )
        ON CONFLICT (transaction_hash, event_index) DO NOTHING
        RETURNING ${streamSelectColumns(3, decryptionPreviousKeyIndex)}
      `;

      const result = await query<Record<string, unknown>>(pool, insertSql, params);
      if (result.rows.length > 0) {
        const stream = rowToRecord(result.rows[0]!);
        info('Stream created from event', { id: stream.id, correlationId });
        return { created: true, stream };
      }
      const existing = await this.getById(input.id);
      if (!existing) {
        const byEvent = await this.getByEvent(input.transaction_hash, input.event_index);
        if (!byEvent) throw new Error('Idempotency conflict: stream not found after insert conflict');
        debug('Stream already exists (idempotent)', { id: byEvent.id, correlationId });
        return { created: false, stream: byEvent };
      }
      debug('Stream already exists (idempotent)', { id: existing.id, correlationId });
      return { created: false, stream: existing };
    });
  },

  /** Update stream status and/or amounts. Validates status transitions. */
  async updateStream(id: string, input: UpdateStreamInput, correlationId?: string): Promise<StreamRecord> {
    enrichActiveSpanWithStream(id);
    return timed('updateStream', async () => {
      const pool = getPool();
      const current = await this.getById(id);
      if (!current) throw new Error(`Stream not found: ${id}`);
      enrichActiveSpanWithStream(current.id, current.sender_address, current.recipient_address);
      if (input.status && !isValidStatusTransition(current.status, input.status)) {
        const allowed = STREAM_INVARIANTS.validTransitions[current.status].join(', ');
        throw new Error(`Invalid status transition: ${current.status} → ${input.status}. Allowed: ${allowed || 'none'}`);
      }
      const setClauses: string[] = ['updated_at = NOW()'];
      const values: unknown[] = [];
      let idx = 1;
      if (input.status !== undefined) { setClauses.push(`status = $${idx++}`); values.push(input.status); }
      if (input.streamed_amount !== undefined) { setClauses.push(`streamed_amount = $${idx++}`); values.push(input.streamed_amount); }
      if (input.remaining_amount !== undefined) { setClauses.push(`remaining_amount = $${idx++}`); values.push(input.remaining_amount); }
      if (input.end_time !== undefined) { setClauses.push(`end_time = $${idx++}`); values.push(input.end_time); }
      values.push(id);

      const keySet = resolvePgcryptoKeys();
      const keyIndex = values.length + 1;
      const previousKeyIndex = keySet.previous ? keyIndex + 1 : undefined;
      values.push(keySet.current);
      if (keySet.previous) {
        values.push(keySet.previous);
      }

      const sql = `UPDATE streams SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING ${streamSelectColumns(keyIndex, previousKeyIndex)}`;
      const result = await query<Record<string, unknown>>(pool, sql, values);
      if (result.rows.length === 0) throw new Error(`Stream not found after update: ${id}`);
      info('Stream updated', { id, input, correlationId });
      return rowToRecord(result.rows[0]!);
    });
  },

  /** Fetch a single stream by its primary key. */
  async getById(id: string): Promise<StreamRecord | undefined> {
    enrichActiveSpanWithStream(id);
    return timed('getById', async () => {
      const pool = await getReadPool();
      const result = await query<Record<string, unknown>>(pool, 'SELECT * FROM streams WHERE id = $1', [id]);
      if (result.rows[0]) {
        const record = rowToRecord(result.rows[0]);
        enrichActiveSpanWithStream(record.id, record.sender_address, record.recipient_address);
        return record;
      }
      return undefined;
    });
  },

  /**
   * Fetch only the minimal metadata needed to answer existence checks.
   *
   * This avoids hydrating and serialising the full stream row when callers
   * only need to know whether the stream exists and to derive cache headers.
   *
   * **Read routing:** This method routes through the read replica via `getReadPool()`
   * to reduce load on the primary database. If no replica is configured or the
   * replica is unhealthy, it falls back to the primary pool automatically.
   */
  async existsById(id: string): Promise<StreamExistenceRecord | undefined> {
    return timed('existsById', async () => {
      const pool = await getReadPool();
      const result = await query<Record<string, unknown>>(
        pool,
        'SELECT updated_at FROM streams WHERE id = $1',
        [id],
      );
      if (!result.rows[0]) return undefined;
      return {
        updated_at: (result.rows[0]['updated_at'] as Date).toISOString(),
      };
    });
  },

  /** Fetch a stream by its blockchain event coordinates (for idempotency). */
  async getByEvent(transactionHash: string, eventIndex: number): Promise<StreamRecord | undefined> {
    return timed('getByEvent', async () => {
      const pool = await getReadPool();
      const keySet = resolvePgcryptoKeys();
      const params: unknown[] = [transactionHash, eventIndex, keySet.current];
      const previousKeyIndex = keySet.previous ? params.length + 1 : undefined;
      if (keySet.previous) params.push(keySet.previous);
      const result = await query<Record<string, unknown>>(
        pool,
        `SELECT ${streamSelectColumns(3, previousKeyIndex)} FROM streams WHERE transaction_hash = $1 AND event_index = $2`,
        params,
      );
      if (result.rows[0]) {
        const record = rowToRecord(result.rows[0]);
        enrichActiveSpanWithStream(record.id, record.sender_address, record.recipient_address);
        return record;
      }
      return undefined;
    });
  },

  /** Cursor-based paginated list with optional filters. */
  async findWithCursor(
    filter: StreamFilter,
    limit: number,
    afterId?: string,
    includeTotal?: boolean,
  ): Promise<{ streams: StreamRecord[]; hasMore: boolean; total?: number }> {
    return timed('findWithCursor', async () => {
      const pool = await getReadPool();
      const keySet = resolvePgcryptoKeys();
      const conditions: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (filter.status) { conditions.push(`status = $${idx++}`); params.push(filter.status); }
      if (filter.sender_address) {
        const hashes = computeAddressHashes(filter.sender_address, keySet);
        const filterIndex = idx++;
        const currentHashIndex = idx++;
        const previousHashIndex = keySet.previous ? idx++ : undefined;
        conditions.push(senderAddressFilterCondition(filterIndex, currentHashIndex, previousHashIndex));
        params.push(filter.sender_address, hashes.current);
        if (hashes.previous) params.push(hashes.previous);
      }
      if (filter.recipient_address) {
        const hashes = computeAddressHashes(filter.recipient_address, keySet);
        const filterIndex = idx++;
        const currentHashIndex = idx++;
        const previousHashIndex = keySet.previous ? idx++ : undefined;
        conditions.push(recipientAddressFilterCondition(filterIndex, currentHashIndex, previousHashIndex));
        params.push(filter.recipient_address, hashes.current);
        if (hashes.previous) params.push(hashes.previous);
      }
      if (filter.contract_id) { conditions.push(`contract_id = $${idx++}`); params.push(filter.contract_id); }

      const whereBase = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const cursorConditions = [...conditions];
      const cursorParams = [...params];
      if (afterId) { cursorConditions.push(`id > $${idx++}`); cursorParams.push(afterId); }
      const whereCursor = cursorConditions.length > 0 ? `WHERE ${cursorConditions.join(' AND ')}` : '';

      const limitParamIndex = cursorParams.length + 1;
      cursorParams.push(limit + 1);
      const keyIndex = cursorParams.length + 1;
      cursorParams.push(keySet.current);
      const previousKeyIndex = keySet.previous ? cursorParams.length + 1 : undefined;
      if (keySet.previous) cursorParams.push(keySet.previous);

      const dataSql = `SELECT ${streamSelectColumns(keyIndex, previousKeyIndex)} FROM streams ${whereCursor} ORDER BY id ASC LIMIT $${limitParamIndex}`;
      const [dataResult, countResult] = await Promise.all([
        query<Record<string, unknown>>(pool, dataSql, cursorParams),
        includeTotal
          ? query<{ count: string }>(pool, `SELECT COUNT(*) AS count FROM streams ${whereBase}`, params)
          : Promise.resolve(null),
      ]);
      const hasMore = dataResult.rows.length > limit;
      const rows = hasMore ? dataResult.rows.slice(0, limit) : dataResult.rows;
      const streams = rows.map(rowToRecord);
      const result: { streams: StreamRecord[]; hasMore: boolean; total?: number } = { streams, hasMore };
      if (countResult) result.total = Number(countResult.rows[0]!.count);
      return result;
    });
  },

  /** Offset-based paginated list. */
  async find(filter: StreamFilter, pagination: PaginationOptions): Promise<PaginatedStreams> {
    return timed('find', async () => {
      const pool = await getReadPool();
      const keySet = resolvePgcryptoKeys();
      const conditions: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (filter.status) { conditions.push(`status = $${idx++}`); params.push(filter.status); }
      if (filter.sender_address) {
        const hashes = computeAddressHashes(filter.sender_address, keySet);
        const filterIndex = idx++;
        const currentHashIndex = idx++;
        const previousHashIndex = keySet.previous ? idx++ : undefined;
        conditions.push(senderAddressFilterCondition(filterIndex, currentHashIndex, previousHashIndex));
        params.push(filter.sender_address, hashes.current);
        if (hashes.previous) params.push(hashes.previous);
      }
      if (filter.recipient_address) {
        const hashes = computeAddressHashes(filter.recipient_address, keySet);
        const filterIndex = idx++;
        const currentHashIndex = idx++;
        const previousHashIndex = keySet.previous ? idx++ : undefined;
        conditions.push(recipientAddressFilterCondition(filterIndex, currentHashIndex, previousHashIndex));
        params.push(filter.recipient_address, hashes.current);
        if (hashes.previous) params.push(hashes.previous);
      }
      if (filter.contract_id) { conditions.push(`contract_id = $${idx++}`); params.push(filter.contract_id); }
      if (filter.start_time_from !== undefined) { conditions.push(`start_time >= $${idx++}`); params.push(filter.start_time_from); }
      if (filter.start_time_to !== undefined) { conditions.push(`start_time <= $${idx++}`); params.push(filter.start_time_to); }
      if (filter.end_time_from !== undefined) { conditions.push(`end_time >= $${idx++}`); params.push(filter.end_time_from); }
      if (filter.end_time_to !== undefined) { conditions.push(`end_time <= $${idx++}`); params.push(filter.end_time_to); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countParams = [...params];
      const keyIndex = params.length + 1;
      const previousKeyIndex = keySet.previous ? keyIndex + 1 : undefined;
      params.push(keySet.current);
      if (keySet.previous) params.push(keySet.previous);

      const [countResult, dataResult] = await Promise.all([
        query<{ count: string }>(pool, `SELECT COUNT(*) AS count FROM streams ${where}`, countParams),
        query<Record<string, unknown>>(
          pool,
          `SELECT ${streamSelectColumns(keyIndex, previousKeyIndex)} FROM streams ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pagination.limit, pagination.offset],
        ),
      ]);
      const total = Number(countResult.rows[0]!.count);
      const streams = dataResult.rows.map(rowToRecord);
      return { streams, total, limit: pagination.limit, offset: pagination.offset, hasMore: pagination.offset + streams.length < total };
    });
  },

  /** Count streams grouped by status. */
  async countByStatus(): Promise<Record<StreamStatus, number>> {
    return timed('countByStatus', async () => {
      const pool = await getReadPool();
      const result = await query<{ status: StreamStatus; count: string }>(
        pool,
        'SELECT status, COUNT(*) AS count FROM streams GROUP BY status',
      );
      const counts: Record<StreamStatus, number> = { active: 0, paused: 0, completed: 0, cancelled: 0 };
      for (const row of result.rows) counts[row.status] = Number(row.count);
      return counts;
    });
  },
};
