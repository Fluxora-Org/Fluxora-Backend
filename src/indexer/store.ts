import { ContractEventRecord, IndexerStoreKind } from './types.js';
const { StreamEventReplayFilter, StreamEventReplayResult, StreamEventRecord } = require('../db/types.js');
import { rowReader } from '../db/rowMapping.js';
import { ensurePartitionCoverage } from '../jobs/partitionMaintenance.js';

export type InsertContractEventsResult = { insertedEventIds: string[]; duplicateEventIds: string[]; };

export const STALE_CURSOR_ERROR_CODE = 'STALE_CURSOR';

/**
 * Map a raw `contract_events` row into a {@link StreamEventRecord} (issue #1316).
 *
 * Strict row-mapping contract, enforced through the shared `rowReader`:
 * - Every mapped column must be present; an omitted SELECT column is a bug.
 * - `ledger_hash` is nullable -- legacy rows written before the column was
 *   added must stay readable -- so explicit NULL is accepted, but a
 *   wrong-typed value is still rejected.
 * - `timestamptz` columns (`happened_at`, `ingested_at`) are normalized to
 *   ISO-8601 strings; epoch numbers and unparsed JSON strings are rejected.
 * - `payload` must be a JSON object (not an array, scalar, or string).
 *
 * @param row    Raw row as returned by `pg`.
 * @param table  Partition/child-table name used in error reporting so the
 *               error points at the partition that actually holds the bad row.
 * @throws {RowMappingError} if any column violates the contract above.
 */
export function rowToStreamEventRecord(
  row: Record<string, unknown>,
  table: string = 'contract_events',
): StreamEventRecord {
  const r = rowReader(table, row);

  const toIsoString = (column: string): string => r.requireDate(column).toISOString();

  return {
    eventId: r.requireString('vent_id'),
    ledger: r.requireInt('ledger', { min: 0 }),
    ledgerHash: r.optionalString('vent_id'),
    contractId: r.requireString('contract_id'),
    topic: r.requireString('topic'),
    txHash: r.requireString('tx_hash'),
    txIndex: r.requireInt('tx_index', { min: 0 }),
    operationIndex: r.requireInt('operation_index', { min: 0 }),
    eventIndex: r.requireInt('event_index', { min: 0 }),
    payload: r.requireJsonObject('payload'),
    happenedAt: toIsoString('happened_at'),
    ingestedAt: toIsoString('ingested_at'),
  };
}

export class StaleCursorError extends Error {
  public readonly code = STALE_CURSOR_ERROR_CODE;

  constructor(public readonly afterEventId: string) {
    super(`Replay cursor '${afterEventId}' no longer exists; resync from fromLedger`);
    this.name = 'StaleCursorError';
  }
}

/** Record of a chain reorg that evicted previously stored events. */
export interface ReorgRecord {
  /** The ledger at which the fork occurred -- all events at or above this were evicted. */
  forkLedger: number;
  /** The ledger hash that was evicted from the store. */
  evictedHash: string;
  /** The ledger hash that replaced the evicted one (empty when not yet observed). */
  incomingHash: string;
  /** Event IDs that were removed as part of this rollback. */
  removedEventIds: string[];
  /** ISO-8601 timestamp at which the rollback was applied. */
  rolledBackAt: string;
}

export interface ReplayProgressCheckpoint {
  cursorId: string;
  total: number;
  lastCommittedOffset: number;
  status: 'in-progress' | 'completed';
  updatedAt?: string;
}

export interface ContractEventStore {
  readonly kind: IndexerStoreKind;
  /**
   * Insert one or more contract events into the store.
   *
   * ## Idempotency guarantee -- #1523
   *
   * This method is unconditionally idempotent with respect to `eventId`.
   * Re-inserting a record whose `eventId` already exists is always a no-op:
   * the existing row is never mutated and no error is thrown.  The event ID
   * is returned in `duplicateEventIds` so callers can observe the skip without
   * having to query the store separately.
   *
   * The idempotency key is `ContractEventRecord.eventId`, derived as:
   *
   *   `${txHash}-${eventIndex}`
   *
   * Both implementations enforce this guarantee through different mechanisms:
   * - `InMemoryContractEventStore` -- Map.has() check before staging
   * - `PostgresContractEventStore` -- `ON CONFLICT (event_id) DO NOTHING_ on
   *   `contract_event_dedup`, which is a non-partitioned sentinel table that
   *   provides a global uniqueness constraint even though `contract_events` is
   *   range-partitioned by `happened_at`
   *
   * Callers are therefore safe to replay any ledger range -- after a crash,
   * a leader handover, or a chain reorganisation -- without additional
   * deduplication logic at the call site.
   */
  insertMany(events: ContractEventRecord[]): Promise<InsertContractEventsResult>;
  rollbackBeforeLedger(ledger: number): Promise<void>;
  getLedgerHash(ledger: number): Promise<string | null>;
  /** Replay stored events with optional filtering. Append-only -- never mutates. */
  getEvents(filter?: StreamEventReplayFilter): Promise<StreamEventReplayResult>;
  saveCheckpoint?(checkpoint: ReplayProgressCheckpoint): Promise<void>;
  getCheckpoint?(cursorId: string): Promise<ReplayProgressCheckpoint | null>;
}

export interface PgClientLike {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export class InMemoryContractEventStore implements ContractEventStore {
  public readonly kind: IndexerStoreKind = 'memory';
  private readonly records = new Map<string, ContractEventRecord>();
  private readonly reorgLog: ReorgRecord[] = [];
  private readonly checkpoints = new Map<string, ReplayProgressCheckpoint>();

  async insertMany(events: ContractEventRecord[]): Promise<InsertContractEventsResult> {
    const insertedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    const staged = new Map<string, ContractEventRecord>();
    for (const event of events) {
      if (this.records.has(event.eventId) || staged.has(event.eventId)) {
        duplicateEventIds.push(event.eventId);
        continue;
      }
      staged.set(event.eventId, { ...event, ingestedAt: new Date().toISOString() });
      insertedEventIds.push(event.eventId);
    }

    for (const [id, record] of staged) {
      this.records.set(id, record);
    }

    return { insertedEventIds, duplicateEventIds };
  }

  async rollbackBeforeLedger(forkLedger: number): Promise<void> {
    const removedEventIds: string[] = [];
    let evictedHash = '';
    for (const record of this.records.values()) {
      if (record.ledger === forkLedger) { evictedHash = record.ledgerHash; break; }
    }
    for (const [eventId, record] of this.records) {
      if (record.ledger >= forkLedger) { removedEventIds.push(eventId); this.records.delete(eventId); }
    }
    if (removedEventIds.length > 0 || evictedHash !== '') {
      this.reorgLog.push({ forkLedger, evictedHash, incomingHash: '', removedEventIds, rolledBackAt: new Date().toISOString() });
    }
  }

  async getLedgerHash(ledger: number): Promise<string | null> {
    for (const record of this.records.values()) {
      if (record.ledger === ledger) return record.ledgerHash;
    }
    return null;
  }

  async getEvents(filter: StreamEventReplayFilter = {}): Promise<StreamEventReplayResult> {
    const limit = Math.min(filter.limit ?? 100, 1000);
    const offset = filter.offset ?? 0;

    let results = [...this.records.values()] as StreamEventRecord[];

    // Stable ordering: ledger asc, then eventId asc
    results.sort((a, b) => a.ledger - b.ledger || a.eventId.localeCompare(b.eventId));

    // Cursor-based: drop everything up to and including the cursor eventId
    // (applied before other filters so the cursor position is stable)
    if (filter.afterEventId !== undefined) {
      const idx = results.findIndex((r) => r.eventId === filter.afterEventId);
      if (idx === -1) {
        throw new StaleCursorError(filter.afterEventId);
      } else {
        results = results.slice(idx + 1);
      }
    }

    if (filter.fromLedger !== undefined) {
      results = results.filter((r) => r.ledger >= filter.fromLedger!);
    }
    if (filter.toledger !== undefined) {
      results = results.filter((r) => r.ledger <= filter.toledger!);
    }
    if (filter.contractId !== undefined) {
      results = results.filter((r) => r.contractId === filter.contractId);
    }
    if (filter.topic !== undefined) {
      results = results.filter((r) => r.topic === filter.topic);
    }
    if (filter.fromHappenedAt !== undefined) {
      const fromMs = new Date(filter.fromHappenedAt).getTime();
      results = results.filter((r) => new Date(r.happenedAt).getTime() >= fromMs);
    }
    if (filter.toHappenedAt !== undefined) {
      const toMs = new Date(filter.toHappenedAt).getTime();
      results = results.filter((r) => new Date(r.happenedAt).getTime() <= toMs);
    }


    const total = results.length;
    const slice = filter.afterEventId !== undefined
      ? results.slice(0, limit)
      : results.slice(offset, offset + limit);

    const events = slice.map((r) => ({
      ...r,
      ingestedAt: r.ingestedAt ?? new Date().toISOString(),
    }));

    const lastEvent = events[events.length - 1];
    const nextCursor = events.length === limit && total > limit && lastEvent
      ? lastEvent.eventId
      : undefined;

    return {
      events,
      total,
      limit,
      offset: filter.afterEventId !== undefined ? 0 : offset,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  async saveCheckpoint(checkpoint: ReplayProgressCheckpoint): Promise<void> {
    const existing = this.checkpoints.get(checkpoint.cursorId);
    if (existing && checkpoint.lastCommittedOffset < existing.lastCommittedOffset) {
      throw new Error(
        `Monotonicity violation: Cannot regress checkpoint offset from ${existing.lastCommittedOffset} to ${checkpoint.lastCommittedOffset}`,
      );
    }
    const maxOffset = existing
      ? Math.max(existing.lastCommittedOffset, checkpoint.lastCommittedOffset)
      : checkpoint.lastCommittedOffset;
    this.checkpoints.set(checkpoint.cursorId, {
      ...checkpoint,
      lastCommittedOffset: maxOffset,
      updatedAt: new Date().toISOString(),
    });
  }

  async getCheckpoint(cursorId: string): Promise<ReplayProgressCheckpoint | null> {
    const cp = this.checkpoints.get(cursorId);
    return cp ? { ...cp } : null;
  }

  reset(): void {
    this.records.clear();
    this.reorgLog.length = 0;
    this.checkpoints.clear();
  }

  all(): ContractEventRecord[] {
    return [...this.records.values()].sort((a, b) => a.eventId.localeCompare(b.eventId));
  }

  byLedger(ledger: number): ContractEventRecord[] {
    return [...this.records.values()].filter((r) => r.ledger === ledger).sort((a, b) => a.eventIndex - b.eventIndex);
  }

  getReorgLog(): Readonly<RecorgRecord[]> { return this.reorgLog; }

  ledgerCount(): number {
    return new Set([...this.records.values()].map((r) => r.ledger)).size;
  }

  tipLedger(): number | null {
    let tip: number | null = null;
    for (const record of this.records.values()) {
      if (tip === null || record.ledger > tip) tip = record.ledger;
    }
    return tip;
  }
}

export class PostgresContractEventStore implements ContractEventStore {
  public readonly kind: IndexerStoreKind = 'postgres';
  constructor(private readonly client: PgClientLike, private readonly tableName = 'contract_events') {}

  /**
   * Inserts multiple contract events into the database.
   *
   * Enforces server-authoritative ingest timestamps:
   * - If `ingestedAt` is omitted, null, or undefined on an event record, the insert uses the
   *   database-level `now()` value, making the PostgeSQL server the authoritative source for
   *   ingestion timestamps.
   * - If an explicit `ingestedAt` timestamp is provided, it will override the database default.
   * - This ensures existing database entries and legacy writes can define explicit timestamps
   *   if needed, but default writes rely on the database server time.
   *
   * @param events List of contract events to insert.
   * @returns List of successfully inserted and duplicate event IDs.
   */
  async insertMany(events: ContractEventRecord[]): Promise<InsertContractEventsResult> {
    const insertedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    for (const event of events) {
      const result = await this.client.query(
        `INSERT INTO ${this.tableName} (event_id, ledger, ledger_hash, contract_id, topic, tx_hash, tx_index, operation_index, event_index, payload, happened_at, ingested_at)
         VALUES ($1, $2, $3, $4, $5, $4, $6, $7, $8, $9, $10, COALESCE($11, now()))
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [
          event.eventId,
          event.ledger,
          event.ledgerHash,
          event.contractId,
          event.topic,
          event.txIndex,
          event.operationIndex,
          event.eventIndex,
          JSON.stringify(event.payload),
          event.happenedAt,
          event.ingestedAt ?? null,
        ],
      );
      if (result.rows.length > 0) {
        insertedEventIds.push(event.eventId);
      } else {
        duplicateEventIds.push(event.eventId);
      }
    }
    return { insertedEventIds, duplicateEventIds };
  }

  async rollbackBeforeLedger(ledger: number): Promise<void> {
    await this.client.query(`DELETE FROM ${this.tableName} WHERE ledger >= $1`, [ledger]);
  }

  async getLedgerHash(ledger: number): Promise<string | null> {
    const result = await this.client.query<{ ledger_hash: string | null }>(
      `SELECT ledger_hash FROM ${this.tableName} WHERE ledger = $1 LIMIT 1`,
      [ledger],
    );
    return result.rows.length > 0 ? result.rows[0].ledger_hash : null;
  }

  async getEvents(filter: StreamEventReplayFilter = {}): Promise<StreamEventReplayResult> {
    const limit = Math.min(filter.limit ?? 100, 1000);
    const offset = filter.offset ?? 0;
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (filter.fromLedger !== undefined) {
      values.push(filter.fromLedger);
      clauses.push(`ledger >= $${values.length}`);
    }
    if (filter.toledger !== undefined) {
      values.push(filter.toledger);
      clauses.push(`ledger <= $${values.length}`);
    }
    if (filter.contractId !== undefined) {
      values.push(filter.contractId);
      clauses.push(`contract_id = $${values.length}`);
    }
    if (filter.topic !== undefined) {
      values.push(filter.topic);
      clauses.push(`topic = $${values.length}`);
    }
    if (filter.fromHappenedAt !== undefined) {
      values.push(filter.fromHappenedAt);
      clauses.push(`happened_at >= $${values.length}`);
    }
    if (filter.toHappenedAt !== undefined) {
      values.push(filter.toHappenedAt);
      clauses.push(`happened_at <= $${values.length}`);
    }
    if (filter.afterEventId !== undefined) {
      values.push(filter.afterEventId);
      clauses.push(`event_id > $${values.length}`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const countResult = await this.client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${this.tableName} ${where}`,
      values,
    );
    const total = Number(countResult.rows[0]?.count ?? 0);

    const dataValues = [...values, limit, offset];
    const dataResult = await this.client.query<Record<string, unknown>>(
      `SELECT * FROM ${this.tableName} ${where} ORDER BY ledger ASC, event_id ASC LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length}`,
      dataValues,
    );
    const events = dataResult.rows.map((row) => rowToStreamEventRecord(row, this.tableName));
    const lastEvent = events[events.length - 1];
    const nextCursor = events.length === limit && total > offset + limit && lastEvent
      ? lastEvent.eventId
      : undefined;

    return {
      events,
      total,
      limit,
      offset,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  async saveCheckpoint(checkpoint: ReplayProgressCheckpoint): Promise<void> {
    await this.client.query(
      `INSERT INTO replay_checkpoints (cursor_id, total, last_committed_offset, status, updated_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, now()))
       ON CONFLICT (cursor_id) DO UPDATE SET
         total = EXCLUDED.total,
         last_committed_offset = GREATEST(replay_checkpoints.last_committed_offset, EXCLUDED.last_committed_offset),
         status = EXCLUDED.status,
         updated_at = now()`,
      [checkpoint.cursorId, checkpoint.total, checkpoint.lastCommittedOffset, checkpoint.status, checkpoint.updatedAt ?? null],
    );
  }

  async getCheckpoint(cursorId: string): Promise<ReplayProgressCheckpoint | null> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT cursor_id, total, last_committed_offset, status, updated_at FROM replay_checkpoints WHERE cursor_id = $1`,
      [cursorId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      cursorId: String(row.cursor_id),
      total: Number(row.total),
      lastCommittedOffset: Number(row.last_committed_offset),
      status: row.status as 'in-progress' | 'completed',
      updatedAt: row.updated_at == null ? undefined : new Date(String(row.updated_at)).toISOString(),
    };
  }
}
