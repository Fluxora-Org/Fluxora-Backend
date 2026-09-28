/**
 * SQL query fragments and helper functions for encrypted stream PII.
 *
 * The `streams` table stores sender/recipient addresses encrypted with pgcrypto.
 * Query helpers in this module keep the encryption/decryption plumbing centralized.
 */

import {
  buildEncryptedAddressFilter,
  pgpDecryptAddressColumn,
  pgpEncryptAddressParam,
} from '../../pii/pgcryptoEncryption.js';

export function streamSelectColumns(
  keyParamIndex: number,
  previousKeyParamIndex?: number,
): string {
  return [
    'id',
    pgpDecryptAddressColumn('sender_address', keyParamIndex, previousKeyParamIndex),
    pgpDecryptAddressColumn('recipient_address', keyParamIndex, previousKeyParamIndex),
    'amount',
    'streamed_amount',
    'remaining_amount',
    'rate_per_second',
    'start_time',
    'end_time',
    'status',
    'contract_id',
    'transaction_hash',
    'event_index',
    'created_at',
    'updated_at',
  ].join(', ');
}

export function encryptAddressValue(addressParamIndex: number, keyParamIndex: number): string {
  return pgpEncryptAddressParam(addressParamIndex, keyParamIndex);
}

export function senderAddressFilterCondition(
  filterValueParamIndex: number,
  senderHashParamIndex: number,
  previousSenderHashParamIndex?: number,
): string {
  return buildEncryptedAddressFilter(
    'sender_address',
    filterValueParamIndex,
    senderHashParamIndex,
    previousSenderHashParamIndex,
  );
}

export function recipientAddressFilterCondition(
  filterValueParamIndex: number,
  recipientHashParamIndex: number,
  previousRecipientHashParamIndex?: number,
): string {
  return buildEncryptedAddressFilter(
    'recipient_address',
    filterValueParamIndex,
    recipientHashParamIndex,
    previousRecipientHashParamIndex,
  );
}

// ── Stream Query Builder & Boundedness Guarantees ─────────────────────────────

/**
 * Default limit for stream list queries when not specified by client.
 * Documented in docs/STREAMS.md (default 50).
 */
export const DEFAULT_STREAM_LIMIT = 50;

/**
 * Hard server-side maximum limit enforced by the query builder.
 * Any requested limit exceeding this cap is clamped to prevent memory exhaustion
 * and latency cliffs.
 */
export const MAX_STREAM_LIMIT = 100;

/**
 * Minimum allowable limit enforced by the query builder.
 */
export const MIN_STREAM_LIMIT = 1;

/**
 * Error thrown when a stream query is constructed without an explicit limit
 * or with an invalid limit, preventing unbounded result sets.
 */
export class UnboundedStreamQueryError extends Error {
  constructor(message = 'Stream query builder requires an explicit, positive limit') {
    super(message);
    this.name = 'UnboundedStreamQueryError';
  }
}

/**
 * Options for constructing a StreamQueryBuilder.
 * Requires an explicit limit at compile-time to guarantee bounded queries.
 */
export interface StreamQueryBuilderOptions {
  /**
   * Explicit page limit.
   * Required to prevent unbounded table scans.
   */
  limit: number;
}

/**
 * Options for emitting a stream query SQL string via StreamQueryBuilder.build().
 */
export interface StreamQueryBuildOptions {
  select?: string;
  columns?: string;
  whereClause?: string;
  orderBy?: string;
  limitParamIndex?: number;
  offsetParamIndex?: number;
  keyIndex?: number;
  previousKeyIndex?: number;
}

/**
 * Options for emitting cursor-paginated stream queries.
 */
export interface StreamCursorQueryOptions {
  columns?: string;
  keyIndex?: number;
  previousKeyIndex?: number;
  whereClause?: string;
  sortField?: string;
  sortDirection?: 'ASC' | 'DESC';
  limitParamIndex: number;
}

/**
 * Options for emitting offset-paginated stream queries.
 */
export interface StreamOffsetQueryOptions {
  columns?: string;
  keyIndex?: number;
  previousKeyIndex?: number;
  whereClause?: string;
  sortClause?: string;
  limitParamIndex: number;
  offsetParamIndex: number;
}

/**
 * Query builder for stream collection queries.
 *
 * Defense-in-depth:
 * 1. Compile-time enforcement: `limit` is a required parameter/option.
 * 2. Runtime invariant: Instantiating without a valid positive limit throws UnboundedStreamQueryError.
 * 3. Server-side clamping: Limits are clamped to [MIN_STREAM_LIMIT, MAX_STREAM_LIMIT] (1..100).
 * 4. Emission assertion: Every emitted query is verified to carry a LIMIT clause before return.
 */
export class StreamQueryBuilder {
  private readonly _limit: number;
  private readonly _effectiveLimit: number;

  constructor(limitOrOptions: number | StreamQueryBuilderOptions) {
    const rawLimit =
      typeof limitOrOptions === 'number'
        ? limitOrOptions
        : limitOrOptions && typeof limitOrOptions === 'object'
          ? (limitOrOptions as StreamQueryBuilderOptions).limit
          : undefined;

    if (rawLimit === undefined || rawLimit === null) {
      throw new UnboundedStreamQueryError('Stream query builder requires an explicit limit');
    }

    if (typeof rawLimit !== 'number' || Number.isNaN(rawLimit) || !Number.isFinite(rawLimit)) {
      throw new UnboundedStreamQueryError(
        `Invalid limit: expected a finite number, received ${String(rawLimit)}`,
      );
    }

    if (rawLimit <= 0) {
      throw new UnboundedStreamQueryError(
        `Invalid limit: limit must be greater than 0, received ${rawLimit}`,
      );
    }

    this._limit = rawLimit;
    this._effectiveLimit = Math.min(
      Math.max(Math.floor(rawLimit), MIN_STREAM_LIMIT),
      MAX_STREAM_LIMIT,
    );
  }

  /** The raw limit provided to the builder */
  get limit(): number {
    return this._limit;
  }

  /** The server-side clamped limit (between MIN_STREAM_LIMIT and MAX_STREAM_LIMIT) */
  get effectiveLimit(): number {
    return this._effectiveLimit;
  }

  /**
   * Build a stream query SQL string.
   * Asserts that the resulting SQL carries a valid LIMIT clause.
   */
  build(options?: StreamQueryBuildOptions): string {
    if (this._effectiveLimit === undefined || this._effectiveLimit === null || !Number.isFinite(this._effectiveLimit)) {
      throw new UnboundedStreamQueryError('Stream query builder requires an explicit limit');
    }

    const customCols = options?.columns ?? options?.select;
    const selectCols = customCols
      ? customCols
      : options?.keyIndex !== undefined
        ? streamSelectColumns(options.keyIndex, options.previousKeyIndex)
        : streamSelectColumns(1);

    let whereClause = '';
    if (options?.whereClause && options.whereClause.trim().length > 0) {
      const trimmed = options.whereClause.trim();
      whereClause = trimmed.toUpperCase().startsWith('WHERE') ? ` ${trimmed}` : ` WHERE ${trimmed}`;
    }

    let orderClause = ' ORDER BY id ASC';
    if (options?.orderBy && options.orderBy.trim().length > 0) {
      const trimmed = options.orderBy.trim();
      orderClause = trimmed.toUpperCase().startsWith('ORDER BY') ? ` ${trimmed}` : ` ORDER BY ${trimmed}`;
    }

    const limitClause =
      options?.limitParamIndex !== undefined
        ? ` LIMIT $${options.limitParamIndex}`
        : ` LIMIT ${this._effectiveLimit}`;

    const offsetClause =
      options?.offsetParamIndex !== undefined ? ` OFFSET $${options.offsetParamIndex}` : '';

    const sql = `SELECT ${selectCols} FROM streams${whereClause}${orderClause}${limitClause}${offsetClause}`;

    return this.assertBounded(sql);
  }

  /**
   * Build a cursor-paginated stream query.
   */
  buildCursorQuery(options: StreamCursorQueryOptions): string {
    const sortField = options.sortField ?? 'id';
    const direction = options.sortDirection ?? 'ASC';
    return this.build({
      columns: options.columns,
      keyIndex: options.keyIndex,
      previousKeyIndex: options.previousKeyIndex,
      whereClause: options.whereClause,
      orderBy: `${sortField} ${direction}`,
      limitParamIndex: options.limitParamIndex,
    });
  }

  /**
   * Build an offset-paginated stream query.
   */
  buildOffsetQuery(options: StreamOffsetQueryOptions): string {
    return this.build({
      columns: options.columns,
      keyIndex: options.keyIndex,
      previousKeyIndex: options.previousKeyIndex,
      whereClause: options.whereClause,
      orderBy: options.sortClause ?? 'created_at DESC, id DESC',
      limitParamIndex: options.limitParamIndex,
      offsetParamIndex: options.offsetParamIndex,
    });
  }

  /**
   * Invariant assertion: guarantees that no query leaves the builder without a LIMIT clause.
   */
  private assertBounded(sql: string): string {
    if (!/\bLIMIT\s+(\$\d+|\d+)\b/i.test(sql)) {
      throw new UnboundedStreamQueryError('Query builder emitted SQL without a LIMIT clause');
    }
    return sql;
  }
}

/**
 * Functional query builder helper.
 * Requires an explicit limit and emits a bounded stream query.
 */
export function buildStreamQuery(
  options: StreamQueryBuilderOptions & StreamQueryBuildOptions,
): string {
  const builder = new StreamQueryBuilder(options.limit);
  return builder.build(options);
}

