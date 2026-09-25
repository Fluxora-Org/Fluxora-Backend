import { describe, expect, it } from 'vitest';
import { PostgresContractEventStore } from '../src/indexer/store.js';
import type { ContractEventRecord } from '../src/indexer/types.js';

function event(happenedAt: string): ContractEventRecord {
  return {
    eventId: 'same-event',
    ledger: 42,
    contractId: 'contract',
    topic: 'stream.created',
    txHash: 'transaction',
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: { value: 'canonical' },
    happenedAt,
    ledgerHash: 'ledger-hash',
  };
}

describe('PostgresContractEventStore concurrent event deduplication', () => {
  it('uses one durable event-ID claim for concurrent workers', async () => {
    const claimed = new Set<string>();
    const queries: string[] = [];
    const client = {
      query: async <T>(sql: string, values?: unknown[]) => {
        queries.push(sql);
        if (sql.includes('contract_event_dedup')) {
          const eventIds = (values ?? []).filter((_, index) => index % 12 === 0) as string[];
          const winners = eventIds.filter((id) => {
            if (claimed.has(id)) return false;
            claimed.add(id);
            return true;
          });
          return { rows: winners.map((event_id) => ({ event_id })) as T[], rowCount: winners.length };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const first = new PostgresContractEventStore(client);
    const second = new PostgresContractEventStore(client);
    const [winner, loser] = await Promise.all([
      first.insertMany([event('2026-08-27T00:00:00.000Z')]),
      second.insertMany([event('2026-08-27T00:00:01.000Z')]),
    ]);

    expect([winner.insertedEventIds, loser.insertedEventIds].filter((ids) => ids.length === 1)).toHaveLength(1);
    expect([winner.duplicateEventIds, loser.duplicateEventIds].filter((ids) => ids.length === 1)).toHaveLength(1);
    expect(queries.every((sql) => sql.includes('WITH input') && sql.includes('ON CONFLICT (event_id) DO NOTHING'))).toBe(true);
  });
});
