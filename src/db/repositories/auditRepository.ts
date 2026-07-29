/**
 * Audit repository — read access to the durable `audit_logs` table.
 *
 * The paginated `GET /api/audit` listing is served from the process-local
 * in-memory ring (see `src/lib/auditLog.ts`). That is fine for "what happened
 * on this instance recently", but a compliance export must cover the *durable*
 * record: every row every instance ever committed. This repository is that read
 * path.
 *
 * ## Why keyset batching instead of `DECLARE CURSOR`
 *
 * A date-bounded compliance export can span millions of rows and take minutes
 * to transfer to a slow client. A server-side cursor would pin one pooled
 * connection inside an open transaction for that entire wall-clock window,
 * which:
 *   - holds back `VACUUM` on a table that is already partition-maintenance
 *     sensitive (see `docs/database.md`),
 *   - starves the pool under concurrent exports, and
 *   - dies outright against any `idle_in_transaction_session_timeout`.
 *
 * {@link auditRepository.streamFiltered} instead pages with a keyset predicate
 * (`id > $lastId ORDER BY id ASC LIMIT $batchSize`). Each page is an
 * independent short query that borrows a connection and gives it straight back,
 * so peak memory is one batch and no connection is ever held across the export.
 *
 * `id` is a `bigserial` primary key, so the keyset is unique, gap-tolerant, and
 * index-backed — unlike `OFFSET`, its cost does not grow with how far into the
 * export we are.
 *
 * ## Consistency
 *
 * Because each page is its own statement, rows committed *during* the export
 * may appear if their `id` sorts after the current position. For an append-only
 * audit table that is the desired behaviour (a superset of the requested range
 * is never a compliance problem, a missing row is). Rows are never skipped or
 * duplicated: `id` is monotonic and never reused.
 *
 * @module db/repositories/auditRepository
 */

import { getPool, query } from '../pool.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** One durable audit row, mapped from `audit_logs`. */
export interface AuditLogRow {
  /** `bigserial` primary key. Returned as a string — int8 exceeds `Number.MAX_SAFE_INTEGER`. */
  id: string;
  /** Global ordering value from the `audit_seq` sequence. Also int8-as-string. */
  seq: string;
  /** ISO-8601 timestamp recorded at the moment of the event. */
  timestamp: string;
  action: string;
  resourceType: string;
  resourceId: string;
  correlationId: string | null;
  meta: Record<string, unknown> | null;
}

/**
 * Filters shared by the paginated listing and the streaming export so the two
 * always select the same population.
 *
 * Every field is optional; omitted fields do not constrain the query. All
 * values are bound as positional parameters — no value is ever interpolated
 * into SQL.
 */
export interface AuditLogFilter {
  /** Matches `meta->>'actor'` exactly. */
  actor?: string | undefined;
  /** Matches the `action` column exactly (e.g. `STREAM_CREATED`). */
  action?: string | undefined;
  /** Matches the `resource_type` column exactly (e.g. `stream`). */
  resourceType?: string | undefined;
  /** Matches the `resource_id` column exactly. */
  resourceId?: string | undefined;
  /** Inclusive lower bound on `timestamp`. Must be an ISO-8601 UTC string. */
  dateFrom?: string | undefined;
  /** Inclusive upper bound on `timestamp`. Must be an ISO-8601 UTC string. */
  dateTo?: string | undefined;
}

/** Tuning knobs for {@link auditRepository.streamFiltered}. */
export interface AuditStreamOptions {
  /**
   * Rows fetched per round-trip. This is the export's memory ceiling: at most
   * this many rows are materialised at once, regardless of how many match.
   */
  batchSize?: number;
  /**
   * Cooperative cancellation. Checked before every round-trip so a client that
   * disconnects mid-export stops costing database work immediately.
   */
  signal?: { readonly aborted: boolean } | undefined;
}

// ── Batch-size bounds ─────────────────────────────────────────────────────────

export const DEFAULT_EXPORT_BATCH_SIZE = 500;
export const MIN_EXPORT_BATCH_SIZE = 1;
/** Upper bound on rows held in memory at once. Caps peak heap per export. */
export const MAX_EXPORT_BATCH_SIZE = 5_000;

/** Clamp a caller-supplied batch size into the safe range. */
function resolveBatchSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_EXPORT_BATCH_SIZE;
  const truncated = Math.trunc(requested);
  if (truncated < MIN_EXPORT_BATCH_SIZE) return MIN_EXPORT_BATCH_SIZE;
  if (truncated > MAX_EXPORT_BATCH_SIZE) return MAX_EXPORT_BATCH_SIZE;
  return truncated;
}

// ── Query construction ────────────────────────────────────────────────────────

const SELECT_COLUMNS =
  'id, seq, timestamp, action, resource_type, resource_id, correlation_id, meta';

/**
 * Build the `WHERE` fragment and its bound parameters for a filter.
 *
 * @param filter     Caller-supplied filter values.
 * @param startIndex 1-based index of the first placeholder to allocate.
 * @returns SQL conditions (already `AND`-joined, no leading `WHERE`) and the
 *          matching parameter array.
 *
 * @security Column names are compile-time constants; only *values* become
 *           parameters. No caller input reaches the SQL string.
 */
function buildFilterClauses(
  filter: AuditLogFilter,
  startIndex: number,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let next = startIndex;

  if (filter.action !== undefined) {
    conditions.push(`action = $${next++}`);
    params.push(filter.action);
  }
  if (filter.resourceType !== undefined) {
    conditions.push(`resource_type = $${next++}`);
    params.push(filter.resourceType);
  }
  if (filter.resourceId !== undefined) {
    conditions.push(`resource_id = $${next++}`);
    params.push(filter.resourceId);
  }
  if (filter.actor !== undefined) {
    // `meta` is jsonb; ->> extracts the value as text so the comparison is a
    // plain text equality against a bound parameter.
    conditions.push(`meta->>'actor' = $${next++}`);
    params.push(filter.actor);
  }
  if (filter.dateFrom !== undefined) {
    // `timestamp` is a text column holding ISO-8601 UTC strings, for which
    // lexicographic order equals chronological order. The route validates the
    // format before we get here, so this comparison is sound.
    conditions.push(`timestamp >= $${next++}`);
    params.push(filter.dateFrom);
  }
  if (filter.dateTo !== undefined) {
    conditions.push(`timestamp <= $${next++}`);
    params.push(filter.dateTo);
  }

  return { conditions, params };
}

/** Map a raw `audit_logs` row to a typed {@link AuditLogRow}. */
function rowToAuditLogRow(row: Record<string, unknown>): AuditLogRow {
  const meta = row['meta'];
  return {
    id: String(row['id']),
    seq: String(row['seq']),
    timestamp: String(row['timestamp']),
    action: String(row['action']),
    resourceType: String(row['resource_type']),
    resourceId: String(row['resource_id']),
    correlationId: row['correlation_id'] === null || row['correlation_id'] === undefined
      ? null
      : String(row['correlation_id']),
    // pg decodes jsonb to a JS value already; guard against a driver that
    // hands back the raw text instead.
    meta: typeof meta === 'string'
      ? (JSON.parse(meta) as Record<string, unknown>)
      : ((meta as Record<string, unknown> | null) ?? null),
  };
}

// ── Repository ────────────────────────────────────────────────────────────────

export const auditRepository = {
  /**
   * Stream every `audit_logs` row matching `filter`, oldest first.
   *
   * Rows are fetched in keyset-paginated batches and yielded one at a time, so
   * a caller can pipe straight to an HTTP response without ever materialising
   * the full result set. Peak memory is `batchSize` rows.
   *
   * @param filter Filter values; see {@link AuditLogFilter}.
   * @param opts   Batch size and cancellation signal.
   * @yields Each matching row in ascending `id` order.
   *
   * @example
   * for await (const row of auditRepository.streamFiltered({ dateFrom, dateTo })) {
   *   res.write(toCsvLine(row));
   * }
   */
  async *streamFiltered(
    filter: AuditLogFilter = {},
    opts: AuditStreamOptions = {},
  ): AsyncGenerator<AuditLogRow, void, undefined> {
    const batchSize = resolveBatchSize(opts.batchSize);
    const signal = opts.signal;
    const pool = getPool();

    // Keyset position. '0' is below every bigserial value, so the first page
    // starts at the beginning of the table.
    let lastId = '0';

    for (;;) {
      if (signal?.aborted) return;

      // $1 is the keyset bound, $2 the page size; filters take $3 onward.
      const { conditions, params } = buildFilterClauses(filter, 3);
      const where = ['id > $1', ...conditions].join(' AND ');
      const sql = `
        SELECT ${SELECT_COLUMNS}
          FROM audit_logs
         WHERE ${where}
         ORDER BY id ASC
         LIMIT $2
      `;

      const result = await query<Record<string, unknown>>(pool, sql, [lastId, batchSize, ...params]);
      const rows = result.rows;
      if (rows.length === 0) return;

      for (const row of rows) {
        if (signal?.aborted) return;
        yield rowToAuditLogRow(row);
      }

      // A short page means the table is exhausted — stop without a final
      // round-trip that we already know returns nothing.
      if (rows.length < batchSize) return;

      lastId = String(rows[rows.length - 1]?.['id']);
    }
  },

  /**
   * Count the rows a filter matches.
   *
   * Not used by the export itself (which must not pay for a full count before
   * it can start streaming) — exposed for operator tooling that wants to size a
   * range before requesting it.
   */
  async countFiltered(filter: AuditLogFilter = {}): Promise<number> {
    const { conditions, params } = buildFilterClauses(filter, 1);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query<{ count: string }>(
      getPool(),
      `SELECT COUNT(*)::text AS count FROM audit_logs ${where}`,
      params,
    );
    return Number.parseInt(result.rows[0]?.count ?? '0', 10);
  },
};
