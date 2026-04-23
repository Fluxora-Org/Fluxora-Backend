import { ContractEventRecord, IndexerStoreKind } from './types.js';
import { StreamEventReplayFilter, StreamEventReplayResult, StreamEventRecord } from '../db/types.js';

export type InsertContractEventsResult = {
  insertedEventIds: string[];
  duplicateEventIds: string[];
};

export interface ContractEventStore {
  readonly kind: IndexerStoreKind;
  insertMany(events: ContractEventRecord[]): Promise<InsertContractEventsResult>;
  rollbackBeforeLedger(ledger: number): Promise<void>;
  getLedgerHash(ledger: number): Promise<string | null>;
  /** Replay stored events with optional filtering. Append-only — never mutates. */
  getEvents(filter?: StreamEventReplayFilter): Promise<StreamEventReplayResult>;
}

export interface PgClientLike {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{
    rows: T[];
    rowCount?: number | null;
  }>;
}

export class InMemoryContractEventStore implements ContractEventStore {
  public readonly kind: IndexerStoreKind = 'memory';

  private readonly records = new Map<string, ContractEventRecord>();

  async insertMany(events: ContractEventRecord[]): Promise<InsertContractEventsResult> {
    const insertedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];

    for (const event of events) {
      if (this.records.has(event.eventId)) {
        duplicateEventIds.push(event.eventId);
        continue;
      }

      this.records.set(event.eventId, {
        ...event,
        ingestedAt: event.ingestedAt ?? new Date().toISOString(),
      });
      insertedEventIds.push(event.eventId);
    }

    return { insertedEventIds, duplicateEventIds };
  }

  async rollbackBeforeLedger(ledger: number): Promise<void> {
    for (const [eventId, record] of this.records) {
      if (record.ledger >= ledger) {
        this.records.delete(eventId);
      }
    }
  }

  async getLedgerHash(ledger: number): Promise<string | null> {
    for (const record of this.records.values()) {
      if (record.ledger === ledger) {
        return record.ledgerHash;
      }
    }
    return null;
  }

  async getEvents(filter: StreamEventReplayFilter = {}): Promise<StreamEventReplayResult> {
    const limit = Math.min(filter.limit ?? 100, 1000);
    const offset = filter.offset ?? 0;

    let results = [...this.records.values()] as StreamEventRecord[];

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

    // Stable ordering: ledger asc, then eventId asc
    results.sort((a, b) => a.ledger - b.ledger || a.eventId.localeCompare(b.eventId));

    const total = results.length;
    const events = results.slice(offset, offset + limit).map((r) => ({
      ...r,
      ingestedAt: r.ingestedAt ?? new Date().toISOString(),
    }));

    return { events, total, limit, offset };
  }

  reset(): void {
    this.records.clear();
  }

  all(): ContractEventRecord[] {
    return [...this.records.values()].sort((a, b) => a.eventId.localeCompare(b.eventId));
  }
}

export class PostgresContractEventStore implements ContractEventStore {
  public readonly kind: IndexerStoreKind = 'postgres';

  constructor(
    private readonly client: PgClientLike,
    private readonly tableName = 'contract_events'
  ) {}

  async insertMany(events: ContractEventRecord[]): Promise<InsertContractEventsResult> {
    if (events.length === 0) {
      return { insertedEventIds: [], duplicateEventIds: [] };
    }

    const values: unknown[] = [];
    const placeholders = events.map((event, index) => {
      const offset = index * 11;
      values.push(
        event.eventId,
        event.ledger,
        event.contractId,
        event.topic,
        event.txHash,
        event.txIndex,
        event.operationIndex,
        event.eventIndex,
        JSON.stringify(event.payload),
        event.happenedAt,
        event.ledgerHash
      );

      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}::jsonb, $${offset + 10}::timestamptz, $${offset + 11})`;
    });

    const sql = `
      INSERT INTO ${this.tableName} (
        event_id, ledger, contract_id, topic, tx_hash,
        tx_index, operation_index, event_index, payload, happened_at, ledger_hash
      )
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `;

    const result = await this.client.query<{ event_id: string }>(sql, values);
    const insertedEventIds = result.rows.map((row) => row.event_id);
    const inserted = new Set(insertedEventIds);
    const duplicateEventIds = events
      .map((e) => e.eventId)
      .filter((id) => !inserted.has(id));

    return { insertedEventIds, duplicateEventIds };
  }

  async rollbackBeforeLedger(ledger: number): Promise<void> {
    await this.client.query(`DELETE FROM ${this.tableName} WHERE ledger >= $1`, [ledger]);
  }

  async getLedgerHash(ledger: number): Promise<string | null> {
    const result = await this.client.query<{ ledger_hash: string }>(
      `SELECT ledger_hash FROM ${this.tableName} WHERE ledger = $1 LIMIT 1`,
      [ledger]
    );
    return result.rows[0]?.ledger_hash ?? null;
  }

  async getEvents(filter: StreamEventReplayFilter = {}): Promise<StreamEventReplayResult> {
    const limit = Math.min(filter.limit ?? 100, 1000);
    const offset = filter.offset ?? 0;

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.fromLedger !== undefined) {
      values.push(filter.fromLedger);
      conditions.push(`ledger >= $${values.length}`);
    }
    if (filter.toledger !== undefined) {
      values.push(filter.toledger);
      conditions.push(`ledger <= $${values.length}`);
    }
    if (filter.contractId !== undefined) {
      values.push(filter.contractId);
      conditions.push(`contract_id = $${values.length}`);
    }
    if (filter.topic !== undefined) {
      values.push(filter.topic);
      conditions.push(`topic = $${values.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await this.client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${this.tableName} ${where}`,
      values
    );
    const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

    values.push(limit, offset);
    const dataResult = await this.client.query<{
      event_id: string; ledger: number; ledger_hash: string; contract_id: string;
      topic: string; tx_hash: string; tx_index: number; operation_index: number;
      event_index: number; payload: Record<string, unknown>; happened_at: string;
      ingested_at: string;
    }>(
      `SELECT event_id, ledger, ledger_hash, contract_id, topic, tx_hash,
              tx_index, operation_index, event_index, payload, happened_at, ingested_at
       FROM ${this.tableName} ${where}
       ORDER BY ledger ASC, event_id ASC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    const events: StreamEventRecord[] = dataResult.rows.map((row) => ({
      eventId: row.event_id,
      ledger: row.ledger,
      ledgerHash: row.ledger_hash,
      contractId: row.contract_id,
      topic: row.topic,
      txHash: row.tx_hash,
      txIndex: row.tx_index,
      operationIndex: row.operation_index,
      eventIndex: row.event_index,
      payload: row.payload,
      happenedAt: row.happened_at,
      ingestedAt: row.ingested_at,
    }));

    return { events, total, limit, offset };
  }
}
