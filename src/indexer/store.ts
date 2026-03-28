import { ContractEventRecord, IndexerStoreKind } from './types.js';

export type InsertContractEventsResult = {
  insertedEventIds: string[];
  duplicateEventIds: string[];
};

export interface ContractEventStore {
  readonly kind: IndexerStoreKind;
  insertMany(events: ContractEventRecord[]): Promise<InsertContractEventsResult>;
  rollbackBeforeLedger(ledger: number): Promise<void>;
  getLedgerHash(ledger: number): Promise<string | null>;
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

    return {
      insertedEventIds,
      duplicateEventIds,
    };
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
      return {
        insertedEventIds: [],
        duplicateEventIds: [],
      };
    }

    const values: unknown[] = [];
    const placeholders = events.map((event, index) => {
      const offset = index * 10;
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
        event_id,
        ledger,
        contract_id,
        topic,
        tx_hash,
        tx_index,
        operation_index,
        event_index,
        payload,
        happened_at,
        ledger_hash
      )
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `;

    const result = await this.client.query<{ event_id: string }>(sql, values);
    const insertedEventIds = result.rows.map((row) => row.event_id);
    const inserted = new Set(insertedEventIds);
    const duplicateEventIds = events
      .map((event) => event.eventId)
      .filter((eventId) => !inserted.has(eventId));

    return {
      insertedEventIds,
      duplicateEventIds,
    };
  }

  async rollbackBeforeLedger(ledger: number): Promise<void> {
    const sql = `DELETE FROM ${this.tableName} WHERE ledger >= $1`;
    await this.client.query(sql, [ledger]);
  }

  async getLedgerHash(ledger: number): Promise<string | null> {
    const sql = `SELECT ledger_hash FROM ${this.tableName} WHERE ledger = $1 LIMIT 1`;
    const result = await this.client.query<{ ledger_hash: string }>(sql, [ledger]);
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0];
    return row ? row.ledger_hash : null;
  }
}
