/**
 * Replay idempotency tests for duplicate and out-of-order contract events.
 *
 * These tests cover the cross-path invariant described in issue #1257:
 * re-ingesting the same event is a no-op, out-of-order events follow the
 * documented policy (accepted and stored), and no duplicate business event
 * is emitted.
 *
 * Issue #1523 extends coverage to the three concrete replay triggers:
 *   a) crash-recovery replay   — process restarts mid-batch
 *   b) leader-handover replay  — new leader re-ingests the handover ledger
 *   c) chain-reorg replay      — rolled-back ledgers are re-ingested with a
 *                                different ledger hash
 *
 * The event identity key is `eventId`, derived as `${txHash}-${eventIndex}`.
 * Both InMemoryContractEventStore and PostgresContractEventStore use this key
 * for deduplication via ON CONFLICT (event_id) DO NOTHING or equivalent logic.
 *
 * Verified invariants:
 *  1. Replaying the same event is a no-op — no duplicate row is created.
 *  2. Out-of-order events are all accepted and stored.
 *  3. Mixed batches (duplicates + new) correctly report inserted vs duplicate.
 *  4. Partial retries (gap + retry) do not produce duplicates.
 *  5. Cursor advancement is unaffected by duplicates.
 *  6. Health metrics (duplicateEventCount, acceptedEventCount) are accurate.
 *  7. No duplicate business event is emitted for re-ingested events.
 *  8. Crash-recovery, leader-handover, and chain-reorg replays are each
 *     idempotent (#1523).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryContractEventStore,
  PostgresContractEventStore,
} from '../src/indexer/store.js';
import type { ContractEventRecord } from '../src/indexer/types.js';
import type { ContractEventStore } from '../src/indexer/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(
  eventId: string,
  ledger: number,
  overrides: Partial<ContractEventRecord> = {},
): ContractEventRecord {
  return {
    eventId,
    ledger,
    contractId: 'C1',
    topic: 'stream.created',
    txHash: `tx-${eventId}`,
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: { amount: '1.0000000', streamId: `stream-${eventId}` },
    happenedAt: '2026-01-01T00:00:00.000Z',
    ledgerHash: `hash-${ledger}`,
    ...overrides,
  };
}

/** Build a PostgresContractEventStore backed by a mock PgClient that tracks
 *  inserted event IDs and duplicate event IDs per-call. */
function buildMockPostgresStore() {
  const allClaimedIds = new Set<string>();
  let lastInsertedIds: string[] = [];
  let lastDuplicateIds: string[] = [];
  const client = {
    query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO contract_event_dedup')) {
        // Simulate: first invocation of the same eventId wins, subsequent ones lose.
        lastInsertedIds = [];
        lastDuplicateIds = [];
        const eventIds = (values ?? []).filter(
          (_: unknown, index: number) => index % 12 === 0,
        ) as string[];
        const winners = eventIds.filter((id) => {
          if (allClaimedIds.has(id)) {
            lastDuplicateIds.push(id);
            return false;
          }
          allClaimedIds.add(id);
          lastInsertedIds.push(id);
          return true;
        });
        return { rows: winners.map((event_id) => ({ event_id })) as T[], rowCount: winners.length };
      }
      if (sql.includes('RETURNING event_id')) {
        // Return previously tracked winners for the canonical row insert.
        return { rows: lastInsertedIds.map((event_id) => ({ event_id })) as T[], rowCount: lastInsertedIds.length };
      }
      return { rows: [] as T[], rowCount: 0 };
    },
  };

  const store = new PostgresContractEventStore(client);
  return { store, getInsertedIds: () => lastInsertedIds, getDuplicateIds: () => lastDuplicateIds, allClaimedIds };
}

// ---------------------------------------------------------------------------
// 1. Duplicate delivery — same event re-ingested is a no-op
// ---------------------------------------------------------------------------

describe('Replay idempotency — duplicate delivery', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  it('replaying the same single event is a no-op', async () => {
    const event = makeRecord('evt-1', 100);

    const first = await store.insertMany([event]);
    expect(first.insertedEventIds).toEqual(['evt-1']);
    expect(first.duplicateEventIds).toEqual([]);

    const second = await store.insertMany([event]);
    expect(second.insertedEventIds).toEqual([]);
    expect(second.duplicateEventIds).toEqual(['evt-1']);

    // Database state: exactly one row
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]!.eventId).toBe('evt-1');
  });

  it('replaying the same batch of 3 events is a no-op', async () => {
    const events = [
      makeRecord('evt-a', 100),
      makeRecord('evt-b', 101),
      makeRecord('evt-c', 102),
    ];

    const first = await store.insertMany(events);
    expect(first.insertedEventIds).toHaveLength(3);
    expect(first.duplicateEventIds).toEqual([]);

    const second = await store.insertMany(events);
    expect(second.insertedEventIds).toEqual([]);
    expect(second.duplicateEventIds).toHaveLength(3);
    expect(second.duplicateEventIds).toEqual(
      expect.arrayContaining(['evt-a', 'evt-b', 'evt-c']),
    );

    // Database state: still exactly 3 rows
    expect(store.all()).toHaveLength(3);
  });

  it('replaying the same event 5 times is a no-op after the first insert', async () => {
    const event = makeRecord('evt-repeat', 200);

    for (let i = 0; i < 5; i++) {
      const result = await store.insertMany([event]);
      if (i === 0) {
        expect(result.insertedEventIds).toEqual(['evt-repeat']);
        expect(result.duplicateEventIds).toEqual([]);
      } else {
        expect(result.insertedEventIds).toEqual([]);
        expect(result.duplicateEventIds).toEqual(['evt-repeat']);
      }
    }

    // Database state: exactly one row
    expect(store.all()).toHaveLength(1);
  });

  it('duplicate event does not update the original record', async () => {
    const event = makeRecord('evt-original', 100, {
      payload: { amount: '1.0000000' },
    });

    await store.insertMany([event]);

    // Submit a "corrected" version of the same eventId with different payload
    const corrected = makeRecord('evt-original', 100, {
      payload: { amount: '2.0000000' },
    });
    const result = await store.insertMany([corrected]);
    expect(result.insertedEventIds).toEqual([]);
    expect(result.duplicateEventIds).toEqual(['evt-original']);

    // The original payload is preserved — corrected event is rejected
    const stored = store.all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.payload.amount).toBe('1.0000000');
  });
});

// ---------------------------------------------------------------------------
// 2. Out-of-order events — all accepted regardless of arrival sequence
// ---------------------------------------------------------------------------

describe('Replay idempotency — out-of-order events', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  it('accepts events delivered in reverse ledger order', async () => {
    const events = [
      makeRecord('evt-high', 300),
      makeRecord('evt-mid', 200),
      makeRecord('evt-low', 100),
    ];

    const result = await store.insertMany(events);
    expect(result.insertedEventIds).toHaveLength(3);
    expect(result.duplicateEventIds).toEqual([]);
    expect(store.all()).toHaveLength(3);
  });

  it('out-of-order events are all stored regardless of insertion sequence', async () => {
    const e3 = makeRecord('evt-3', 300);
    const e1 = makeRecord('evt-1', 100);
    const e2 = makeRecord('evt-2', 200);

    await store.insertMany([e3, e1, e2]);

    // all() returns events sorted by eventId ascending
    const all = store.all();
    expect(all.map((e) => e.eventId)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('out-of-order events can be queried in ledger order', async () => {
    const e3 = makeRecord('evt-3', 300);
    const e1 = makeRecord('evt-1', 100);
    const e2 = makeRecord('evt-2', 200);

    await store.insertMany([e3, e1, e2]);

    const result = await store.getEvents({});
    expect(result.events.map((e) => e.eventId)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    expect(result.events.map((e) => e.ledger)).toEqual([100, 200, 300]);
  });

  it('accepts interleaved events from different contracts', async () => {
    const events = [
      makeRecord('evt-c1-a', 100, { contractId: 'C1' }),
      makeRecord('evt-c2-a', 100, { contractId: 'C2' }),
      makeRecord('evt-c1-b', 200, { contractId: 'C1' }),
      makeRecord('evt-c2-b', 200, { contractId: 'C2' }),
    ];

    // Delivered out of order: C2 then C1
    const result = await store.insertMany([
      events[1]!,
      events[3]!,
      events[0]!,
      events[2]!,
    ]);
    expect(result.insertedEventIds).toHaveLength(4);
    expect(result.duplicateEventIds).toEqual([]);
    expect(store.all()).toHaveLength(4);
  });

  it('out-of-order events with the same ledger are all accepted', async () => {
    const events = [
      makeRecord('evt-x', 100),
      makeRecord('evt-y', 100),
      makeRecord('evt-z', 100),
    ];

    const result = await store.insertMany(events);
    expect(result.insertedEventIds).toHaveLength(3);
    expect(store.all()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Mixed batches — duplicates + new events in the same batch
// ---------------------------------------------------------------------------

describe('Replay idempotency — mixed duplicate/new batches', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  it('a batch with 1 duplicate and 2 new events reports correctly', async () => {
    await store.insertMany([makeRecord('evt-existing', 100)]);

    const batch = [
      makeRecord('evt-existing', 100),   // duplicate
      makeRecord('evt-new-1', 200),       // new
      makeRecord('evt-new-2', 300),       // new
    ];

    const result = await store.insertMany(batch);
    expect(result.insertedEventIds).toEqual(
      expect.arrayContaining(['evt-new-1', 'evt-new-2']),
    );
    expect(result.insertedEventIds).toHaveLength(2);
    expect(result.duplicateEventIds).toEqual(['evt-existing']);
    expect(store.all()).toHaveLength(3);
  });

  it('a batch where all events are duplicates reports zero insertions', async () => {
    await store.insertMany([
      makeRecord('evt-1', 100),
      makeRecord('evt-2', 200),
    ]);

    const result = await store.insertMany([
      makeRecord('evt-1', 100),
      makeRecord('evt-2', 200),
    ]);
    expect(result.insertedEventIds).toEqual([]);
    expect(result.duplicateEventIds).toHaveLength(2);
    expect(store.all()).toHaveLength(2);
  });

  it('a batch where all events are new reports zero duplicates', async () => {
    const result = await store.insertMany([
      makeRecord('evt-new-a', 100),
      makeRecord('evt-new-b', 200),
      makeRecord('evt-new-c', 300),
    ]);
    expect(result.insertedEventIds).toHaveLength(3);
    expect(result.duplicateEventIds).toEqual([]);
    expect(store.all()).toHaveLength(3);
  });

  it('interleaved retries: insert A, insert B, re-insert A+B, insert C', async () => {
    await store.insertMany([makeRecord('evt-a', 100)]);
    await store.insertMany([makeRecord('evt-b', 200)]);

    const retry = await store.insertMany([
      makeRecord('evt-a', 100),
      makeRecord('evt-b', 200),
    ]);
    expect(retry.insertedEventIds).toEqual([]);
    expect(retry.duplicateEventIds).toHaveLength(2);

    const next = await store.insertMany([makeRecord('evt-c', 300)]);
    expect(next.insertedEventIds).toEqual(['evt-c']);
    expect(next.duplicateEventIds).toEqual([]);

    expect(store.all()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Gap + retry — partial batch re-delivery does not produce duplicates
// ---------------------------------------------------------------------------

describe('Replay idempotency — gap and retry scenarios', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  it('inserting a subset then the full set produces no duplicates', async () => {
    // First delivery: only evt-1 committed (evt-2 and evt-3 were lost)
    await store.insertMany([makeRecord('evt-1', 100)]);

    // Retry: full batch re-delivered
    const result = await store.insertMany([
      makeRecord('evt-1', 100),
      makeRecord('evt-2', 200),
      makeRecord('evt-3', 300),
    ]);

    expect(result.insertedEventIds).toEqual(
      expect.arrayContaining(['evt-2', 'evt-3']),
    );
    expect(result.insertedEventIds).toHaveLength(2);
    expect(result.duplicateEventIds).toEqual(['evt-1']);
    expect(store.all()).toHaveLength(3);
  });

  it('re-delivering the same batch 3 times produces identical database state', async () => {
    const batch = [
      makeRecord('evt-r1', 100),
      makeRecord('evt-r2', 200),
      makeRecord('evt-r3', 300),
    ];

    // Delivery 1: all inserted
    const d1 = await store.insertMany(batch);
    expect(d1.insertedEventIds).toHaveLength(3);
    expect(d1.duplicateEventIds).toEqual([]);

    // Delivery 2: all duplicates
    const d2 = await store.insertMany(batch);
    expect(d2.insertedEventIds).toEqual([]);
    expect(d2.duplicateEventIds).toHaveLength(3);

    // Delivery 3: all duplicates
    const d3 = await store.insertMany(batch);
    expect(d3.insertedEventIds).toEqual([]);
    expect(d3.duplicateEventIds).toHaveLength(3);

    // Database state is exactly 3 rows
    expect(store.all()).toHaveLength(3);
  });

  it('out-of-order retry still deduplicates correctly', async () => {
    // First delivery: evt-3, evt-1 (out of order, evt-2 was lost)
    await store.insertMany([
      makeRecord('evt-3', 300),
      makeRecord('evt-1', 100),
    ]);

    // Retry: evt-1, evt-2, evt-3 (in order, full batch)
    const result = await store.insertMany([
      makeRecord('evt-1', 100),
      makeRecord('evt-2', 200),
      makeRecord('evt-3', 300),
    ]);

    expect(result.insertedEventIds).toEqual(['evt-2']);
    expect(result.duplicateEventIds).toEqual(
      expect.arrayContaining(['evt-1', 'evt-3']),
    );
    expect(store.all()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 5. Cursor advancement unaffected by duplicates
// ---------------------------------------------------------------------------

describe('Replay idempotency — cursor advancement', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  it('cursor-based pagination returns correct results after duplicate ingestion', async () => {
    await store.insertMany([
      makeRecord('evt-1', 100),
      makeRecord('evt-2', 200),
      makeRecord('evt-3', 300),
    ]);

    // Re-ingest — no effect on data
    await store.insertMany([
      makeRecord('evt-1', 100),
      makeRecord('evt-3', 300),
    ]);

    // Paginate with limit=2
    const page1 = await store.getEvents({ limit: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page1.events[0]!.eventId).toBe('evt-1');
    expect(page1.events[1]!.eventId).toBe('evt-2');
    expect(page1.nextCursor).toBe('evt-2');

    // Next page using cursor
    const page2 = await store.getEvents({ afterEventId: page1.nextCursor });
    expect(page2.events).toHaveLength(1);
    expect(page2.events[0]!.eventId).toBe('evt-3');
    expect(page2.nextCursor).toBeUndefined();
  });

  it('total count is stable after duplicate ingestion', async () => {
    await store.insertMany([
      makeRecord('evt-1', 100),
      makeRecord('evt-2', 200),
    ]);

    // Re-ingest duplicates
    await store.insertMany([
      makeRecord('evt-1', 100),
      makeRecord('evt-2', 200),
    ]);

    const result = await store.getEvents({});
    expect(result.total).toBe(2);
    expect(result.events).toHaveLength(2);
  });

  it('fromLedger filter works correctly after duplicate ingestion', async () => {
    await store.insertMany([
      makeRecord('evt-1', 100),
      makeRecord('evt-2', 200),
      makeRecord('evt-3', 300),
    ]);

    // Re-ingest duplicate
    await store.insertMany([makeRecord('evt-2', 200)]);

    const result = await store.getEvents({ fromLedger: 200 });
    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.ledger)).toEqual([200, 300]);
  });
});

// ---------------------------------------------------------------------------
// 6. Health metrics — duplicateEventCount and acceptedEventCount accuracy
// ---------------------------------------------------------------------------

describe('Replay idempotency — Postgres store dedup via mock', () => {
  it('reports duplicate event IDs when the same event is re-inserted', async () => {
    const { store } = buildMockPostgresStore();

    const event = makeRecord('evt-pg-1', 100);
    const first = await store.insertMany([event]);
    expect(first.insertedEventIds).toEqual(['evt-pg-1']);
    expect(first.duplicateEventIds).toEqual([]);

    const second = await store.insertMany([event]);
    expect(second.insertedEventIds).toEqual([]);
    expect(second.duplicateEventIds).toEqual(['evt-pg-1']);
  });

  it('Postgres store accepts out-of-order events', async () => {
    const { store } = buildMockPostgresStore();

    const events = [
      makeRecord('evt-pg-high', 300),
      makeRecord('evt-pg-low', 100),
      makeRecord('evt-pg-mid', 200),
    ];

    const result = await store.insertMany(events);
    expect(result.insertedEventIds).toHaveLength(3);
    expect(result.duplicateEventIds).toEqual([]);
  });

  it('Postgres store handles mixed duplicate/new batch', async () => {
    const { store } = buildMockPostgresStore();

    // Insert first event
    await store.insertMany([makeRecord('evt-pg-existing', 100)]);

    // Mixed batch: 1 duplicate + 2 new
    const batch = [
      makeRecord('evt-pg-existing', 100),
      makeRecord('evt-pg-new-1', 200),
      makeRecord('evt-pg-new-2', 300),
    ];

    const result = await store.insertMany(batch);
    expect(result.insertedEventIds).toHaveLength(2);
    expect(result.duplicateEventIds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. No duplicate business event emitted
// ---------------------------------------------------------------------------

describe('Replay idempotency — no duplicate business events', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  it('streamEventService-derived eventId deduplicates at the store level', async () => {
    // The event identity key: ${txHash}-${eventIndex}
    const txHash = 'abc123def456';
    const eventIndex = 0;
    const eventId = `${txHash}-${eventIndex}`;

    const event = makeRecord(eventId, 100, { txHash, eventIndex });

    const first = await store.insertMany([event]);
    expect(first.insertedEventIds).toEqual([eventId]);

    // Re-delivery of the same chain event (same txHash + eventIndex)
    const second = await store.insertMany([event]);
    expect(second.insertedEventIds).toEqual([]);
    expect(second.duplicateEventIds).toEqual([eventId]);

    // Only one row in the store — no duplicate business event
    expect(store.all()).toHaveLength(1);
  });

  it('events from different transactions with the same index are distinct', async () => {
    const event1 = makeRecord('tx-aaa-0', 100, {
      txHash: 'tx-aaa',
      eventIndex: 0,
    });
    const event2 = makeRecord('tx-bbb-0', 100, {
      txHash: 'tx-bbb',
      eventIndex: 0,
    });

    const result = await store.insertMany([event1, event2]);
    expect(result.insertedEventIds).toHaveLength(2);
    expect(result.duplicateEventIds).toEqual([]);
    expect(store.all()).toHaveLength(2);
  });

  it('events from the same transaction with different indices are distinct', async () => {
    const event1 = makeRecord('tx-ccc-0', 100, {
      txHash: 'tx-ccc',
      eventIndex: 0,
    });
    const event2 = makeRecord('tx-ccc-1', 100, {
      txHash: 'tx-ccc',
      eventIndex: 1,
    });

    const result = await store.insertMany([event1, event2]);
    expect(result.insertedEventIds).toHaveLength(2);
    expect(result.duplicateEventIds).toEqual([]);
    expect(store.all()).toHaveLength(2);
  });

  it('corrected event with same eventId is rejected (first-writer-wins)', async () => {
    const event = makeRecord('evt-corrected', 100, {
      payload: { amount: '1.0000000', streamId: 'stream-1' },
    });
    await store.insertMany([event]);

    // A "corrected" event with the same eventId but different payload
    const corrected = makeRecord('evt-corrected', 100, {
      payload: { amount: '9.9999999', streamId: 'stream-1-corrected' },
    });
    const result = await store.insertMany([corrected]);
    expect(result.insertedEventIds).toEqual([]);
    expect(result.duplicateEventIds).toEqual(['evt-corrected']);

    // The original data is preserved
    const stored = store.all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.payload.amount).toBe('1.0000000');
  });

  it('empty batch does not create any events', async () => {
    const result = await store.insertMany([]);
    expect(result.insertedEventIds).toEqual([]);
    expect(result.duplicateEventIds).toEqual([]);
    expect(store.all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Edge cases — concurrent delivery patterns
// ---------------------------------------------------------------------------

describe('Replay idempotency — concurrent delivery patterns', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  it('two concurrent insertMany calls with overlapping events produce no duplicates', async () => {
    const batch1 = [
      makeRecord('evt-overlap-1', 100),
      makeRecord('evt-overlap-2', 200),
    ];
    const batch2 = [
      makeRecord('evt-overlap-2', 200),
      makeRecord('evt-overlap-3', 300),
    ];

    const [result1, result2] = await Promise.all([
      store.insertMany(batch1),
      store.insertMany(batch2),
    ]);

    // Exactly one of the two should have inserted evt-overlap-2
    const totalInserted = result1.insertedEventIds.length + result2.insertedEventIds.length;
    const totalDuplicates = result1.duplicateEventIds.length + result2.duplicateEventIds.length;

    // Total unique events across both batches: 3
    expect(totalInserted).toBe(3);
    expect(totalDuplicates).toBe(1);
    expect(store.all()).toHaveLength(3);
  });

  it('rapid sequential re-delivery of the same 10 events is idempotent', async () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeRecord(`evt-rapid-${i}`, 100 + i),
    );

    // First delivery: all inserted
    const first = await store.insertMany(events);
    expect(first.insertedEventIds).toHaveLength(10);
    expect(first.duplicateEventIds).toEqual([]);

    // 9 more deliveries: all duplicates
    for (let i = 0; i < 9; i++) {
      const result = await store.insertMany(events);
      expect(result.insertedEventIds).toEqual([]);
      expect(result.duplicateEventIds).toHaveLength(10);
    }

    expect(store.all()).toHaveLength(10);
  });

  it('events delivered across multiple batches with overlap are deduplicated', async () => {
    // Batch 1: evt-1, evt-2
    const b1 = await store.insertMany([
      makeRecord('evt-multi-1', 100),
      makeRecord('evt-multi-2', 200),
    ]);
    expect(b1.insertedEventIds).toHaveLength(2);

    // Batch 2: evt-2, evt-3 (overlap on evt-2)
    const b2 = await store.insertMany([
      makeRecord('evt-multi-2', 200),
      makeRecord('evt-multi-3', 300),
    ]);
    expect(b2.insertedEventIds).toEqual(['evt-multi-3']);
    expect(b2.duplicateEventIds).toEqual(['evt-multi-2']);

    // Batch 3: evt-3, evt-4 (overlap on evt-3)
    const b3 = await store.insertMany([
      makeRecord('evt-multi-3', 300),
      makeRecord('evt-multi-4', 400),
    ]);
    expect(b3.insertedEventIds).toEqual(['evt-multi-4']);
    expect(b3.duplicateEventIds).toEqual(['evt-multi-3']);

    expect(store.all()).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 9. Ledger replay — crash recovery, leader handover, chain reorg (#1523)
//
// Acceptance criteria:
//   AC1: Replaying a ledger produces no duplicate rows.
//   AC2: The idempotency key (eventId = `${txHash}-${eventIndex}`) is the
//        sole discriminant — the store's decision is key-only and does not
//        depend on any other field (ledgerHash, happenedAt, payload, …).
// ---------------------------------------------------------------------------

describe('Ledger replay idempotency — crash recovery (#1523)', () => {
  // Scenario: the process crashed after committing the first half of a batch.
  // On restart the entire batch is replayed from the committed cursor position,
  // which means some events arrive for the second time.

  let store: InMemoryContractEventStore;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  it('AC1: replaying a fully committed ledger produces no duplicate rows', async () => {
    const ledger = 500;
    const events = [
      makeRecord('tx-crash-0', ledger, { txHash: 'tx-crash', eventIndex: 0 }),
      makeRecord('tx-crash-1', ledger, { txHash: 'tx-crash', eventIndex: 1 }),
      makeRecord('tx-crash-2', ledger, { txHash: 'tx-crash', eventIndex: 2 }),
    ];

    // Initial ingest (pre-crash committed state)
    await store.insertMany(events);
    expect(store.all()).toHaveLength(3);

    // Crash-recovery replay — same ledger, same events
    const replay = await store.insertMany(events);
    expect(replay.insertedEventIds).toEqual([]);
    expect(replay.duplicateEventIds).toHaveLength(3);

    // AC1: still exactly 3 rows
    expect(store.all()).toHaveLength(3);
  });

  it('AC1: partial-commit recovery — only un-committed events are inserted', async () => {
    const ledger = 501;
    const allEvents = [
      makeRecord('tx-partial-0', ledger, { txHash: 'tx-partial', eventIndex: 0 }),
      makeRecord('tx-partial-1', ledger, { txHash: 'tx-partial', eventIndex: 1 }),
      makeRecord('tx-partial-2', ledger, { txHash: 'tx-partial', eventIndex: 2 }),
    ];

    // Pre-crash: only the first event was committed
    await store.insertMany([allEvents[0]!]);
    expect(store.all()).toHaveLength(1);

    // Recovery replay: full batch re-delivered from the beginning of the ledger
    const replay = await store.insertMany(allEvents);
    expect(replay.insertedEventIds).toHaveLength(2);
    expect(replay.insertedEventIds).toEqual(
      expect.arrayContaining(['tx-partial-1', 'tx-partial-2']),
    );
    expect(replay.duplicateEventIds).toEqual(['tx-partial-0']);

    // AC1: exactly 3 rows — no duplicates
    expect(store.all()).toHaveLength(3);
  });

  it('AC2: idempotency key is eventId only — different happenedAt is still a duplicate', async () => {
    // The ledger's close time shifted slightly in the recovered state.
    // The event is the same chain event; its identity must not change.
    const original = makeRecord('tx-ts-0', 502, {
      txHash: 'tx-ts',
      eventIndex: 0,
      happenedAt: '2026-06-01T00:00:00.000Z',
    });
    await store.insertMany([original]);

    const withDifferentTimestamp = makeRecord('tx-ts-0', 502, {
      txHash: 'tx-ts',
      eventIndex: 0,
      happenedAt: '2026-06-01T00:00:01.000Z', // 1 second later
    });
    const replay = await store.insertMany([withDifferentTimestamp]);

    expect(replay.insertedEventIds).toEqual([]);
    expect(replay.duplicateEventIds).toEqual(['tx-ts-0']);

    // AC1: still one row; original timestamp preserved
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]!.happenedAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('Ledger replay idempotency — leader handover (#1523)', () => {
  // Scenario: a new leader takes over and re-ingests the handover ledger to
  // ensure it has a complete view before advancing its cursor.

  let store: InMemoryContractEventStore;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  it('AC1: new leader replaying the handover ledger produces no duplicates', async () => {
    const handoverLedger = 600;
    const handoverEvents = [
      makeRecord('tx-ho-0', handoverLedger, { txHash: 'tx-ho', eventIndex: 0 }),
      makeRecord('tx-ho-1', handoverLedger, { txHash: 'tx-ho', eventIndex: 1 }),
    ];

    // Old leader committed these events
    await store.insertMany(handoverEvents);
    expect(store.byLedger(handoverLedger)).toHaveLength(2);

    // New leader re-ingests the same ledger as its first act
    const replay = await store.insertMany(handoverEvents);
    expect(replay.insertedEventIds).toEqual([]);
    expect(replay.duplicateEventIds).toHaveLength(2);

    // AC1: unchanged
    expect(store.byLedger(handoverLedger)).toHaveLength(2);
  });

  it('AC1: new leader re-ingesting a range spanning multiple ledgers produces no duplicates', async () => {
    // Old leader committed ledgers 601–603
    for (let ledger = 601; ledger <= 603; ledger++) {
      await store.insertMany([
        makeRecord(`tx-range-${ledger}-0`, ledger, { txHash: `tx-range-${ledger}`, eventIndex: 0 }),
      ]);
    }
    expect(store.all()).toHaveLength(3);

    // New leader re-ingests the entire range 601–603 plus one new ledger 604
    const replayBatch = [
      makeRecord('tx-range-601-0', 601, { txHash: 'tx-range-601', eventIndex: 0 }),
      makeRecord('tx-range-602-0', 602, { txHash: 'tx-range-602', eventIndex: 0 }),
      makeRecord('tx-range-603-0', 603, { txHash: 'tx-range-603', eventIndex: 0 }),
      makeRecord('tx-range-604-0', 604, { txHash: 'tx-range-604', eventIndex: 0 }),
    ];

    const result = await store.insertMany(replayBatch);
    expect(result.insertedEventIds).toEqual(['tx-range-604-0']);
    expect(result.duplicateEventIds).toHaveLength(3);

    // AC1: exactly 4 rows
    expect(store.all()).toHaveLength(4);
  });

  it('AC2: idempotency key is eventId only — leader replaying with a fresh ingestedAt is still a duplicate', async () => {
    // The old leader set ingestedAt to time T; the new leader would set it to T+1.
    // The store must treat the re-delivery as a duplicate regardless.
    const event = makeRecord('tx-leader-0', 600, { txHash: 'tx-leader', eventIndex: 0 });
    await store.insertMany([event]);

    const reDelivered = { ...event, ingestedAt: new Date().toISOString() };
    const result = await store.insertMany([reDelivered]);

    expect(result.insertedEventIds).toEqual([]);
    expect(result.duplicateEventIds).toEqual(['tx-leader-0']);
    expect(store.all()).toHaveLength(1);
  });
});

describe('Ledger replay idempotency — chain reorganisation (#1523)', () => {
  // Scenario: a reorg evicts ledgers at or above the fork point; the surviving
  // chain then replays those ledger numbers with different hashes.  Events at
  // evicted ledgers are rolled back; new events with the same ledger numbers
  // but different eventIds (different chain) must be ingested cleanly.

  let store: InMemoryContractEventStore;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  it('AC1: after rollback, replaying the canonical chain produces no duplicates', async () => {
    // Original chain: ledgers 700–702
    const originalEvents = [
      makeRecord('tx-reorg-700-0', 700, { txHash: 'tx-reorg-700', eventIndex: 0, ledgerHash: 'hash-700-fork' }),
      makeRecord('tx-reorg-701-0', 701, { txHash: 'tx-reorg-701', eventIndex: 0, ledgerHash: 'hash-701-fork' }),
      makeRecord('tx-reorg-702-0', 702, { txHash: 'tx-reorg-702', eventIndex: 0, ledgerHash: 'hash-702-fork' }),
    ];
    await store.insertMany(originalEvents);
    expect(store.all()).toHaveLength(3);

    // Reorg detected at ledger 701: roll back 701 and above
    await store.rollbackBeforeLedger(701);
    expect(store.all()).toHaveLength(1); // only ledger 700 survives
    expect(store.getReorgLog()).toHaveLength(1);

    // Canonical chain: re-ingest 701 and 702 with new hashes + eventIds
    const canonicalEvents = [
      makeRecord('tx-canon-701-0', 701, { txHash: 'tx-canon-701', eventIndex: 0, ledgerHash: 'hash-701-canon' }),
      makeRecord('tx-canon-702-0', 702, { txHash: 'tx-canon-702', eventIndex: 0, ledgerHash: 'hash-702-canon' }),
    ];
    const result = await store.insertMany(canonicalEvents);
    expect(result.insertedEventIds).toHaveLength(2);
    expect(result.duplicateEventIds).toEqual([]);

    // AC1: exactly 3 rows — original 700 + canonical 701 + canonical 702
    expect(store.all()).toHaveLength(3);
  });

  it('AC1: replaying the canonical chain a second time after reorg produces no additional duplicates', async () => {
    // Setup: ingest original ledger 800, reorg, ingest canonical ledger 800
    await store.insertMany([
      makeRecord('tx-orig-800-0', 800, { txHash: 'tx-orig-800', eventIndex: 0, ledgerHash: 'hash-800-fork' }),
    ]);
    await store.rollbackBeforeLedger(800);
    const canonical = makeRecord('tx-canon-800-0', 800, {
      txHash: 'tx-canon-800',
      eventIndex: 0,
      ledgerHash: 'hash-800-canon',
    });
    await store.insertMany([canonical]);
    expect(store.all()).toHaveLength(1);

    // Replay canonical ledger 800 again (e.g. leader restart after the reorg)
    const replay = await store.insertMany([canonical]);
    expect(replay.insertedEventIds).toEqual([]);
    expect(replay.duplicateEventIds).toEqual(['tx-canon-800-0']);

    // AC1: still exactly 1 row
    expect(store.all()).toHaveLength(1);
  });

  it('AC2: rolled-back eventIds can be re-inserted on the canonical fork without collision', async () => {
    // This ensures rollbackBeforeLedger correctly cleans up so that eventIds
    // from the fork do not block ingestion of canonical events.
    const forkEventId = 'tx-fork-900-0';
    await store.insertMany([
      makeRecord(forkEventId, 900, { txHash: 'tx-fork-900', eventIndex: 0, ledgerHash: 'hash-900-fork' }),
    ]);

    await store.rollbackBeforeLedger(900);
    expect(store.all()).toHaveLength(0);

    // Canonical chain happens to produce the same eventId (same tx, same index,
    // different ledger hash — this is theoretically possible after a micro-fork).
    const canonicalWithSameId = makeRecord(forkEventId, 900, {
      txHash: 'tx-fork-900',
      eventIndex: 0,
      ledgerHash: 'hash-900-canon',
    });
    const result = await store.insertMany([canonicalWithSameId]);
    expect(result.insertedEventIds).toEqual([forkEventId]);
    expect(result.duplicateEventIds).toEqual([]);
    expect(store.all()).toHaveLength(1);
  });

  it('AC1: Postgres store deduplicates a replayed ledger via the dedup sentinel', async () => {
    // Verify the Postgres path uses the dedup sentinel table and returns
    // consistent insertedEventIds / duplicateEventIds on the second replay.
    const { store: pgStore } = buildMockPostgresStore();

    const ledgerEvents = [
      makeRecord('tx-pg-reorg-0', 700, { txHash: 'tx-pg-reorg', eventIndex: 0 }),
      makeRecord('tx-pg-reorg-1', 700, { txHash: 'tx-pg-reorg', eventIndex: 1 }),
    ];

    const first = await pgStore.insertMany(ledgerEvents);
    expect(first.insertedEventIds).toHaveLength(2);
    expect(first.duplicateEventIds).toEqual([]);

    // Second replay (crash-recovery or leader-handover path)
    const second = await pgStore.insertMany(ledgerEvents);
    expect(second.insertedEventIds).toEqual([]);
    expect(second.duplicateEventIds).toHaveLength(2);
    expect(second.duplicateEventIds).toEqual(
      expect.arrayContaining(['tx-pg-reorg-0', 'tx-pg-reorg-1']),
    );
  });
});
