/**
 * Indexer happy-path tests.
 *
 * Covers:
 *  - Sequential block ingestion and data persistence
 *  - Duplicate-event absorption
 *  - Authentication / authorisation enforcement
 *  - Payload size limits
 *  - Batch validation (empty, oversized, malformed, intra-batch duplicates)
 *  - Dependency-state fail-closed behaviour
 *  - Rate limiting
 *  - Health endpoint reflection
 *  - InMemoryContractEventStore unit tests (insertMany, rollback, helpers)
 *  - PostgresContractEventStore unit tests (via mock PgClientLike)
 *  - DecimalString precision preservation through the full stack
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import {
  InMemoryContractEventStore,
  PostgresContractEventStore,
} from '../src/indexer/store.js';
import {
  resetIndexerState,
  setIndexerDependencyState,
  setIndexerEventStore,
  setIndexerIngestAuthToken,
} from '../src/routes/indexer.js';
import { toDecimalString } from '../src/indexer/types.js';

const INDEXER_TOKEN = 'test-indexer-token';
const INGEST_ENDPOINT = '/internal/indexer/contract-events';
const REPLAY_ENDPOINT = '/internal/indexer/events';

function buildEvent(eventId: string, ledger = 512345) {
  return {
    eventId,
    ledger,
    contractId: 'CCONTRACT123',
    topic: 'stream.created',
    txHash: `tx-${eventId}`,
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: {
      streamId: `stream-${eventId}`,
      depositAmount: '100.0000000',
      ratePerSecond: '0.0000001',
    },
    happenedAt: '2026-03-26T12:00:00.000Z',
    ledgerHash,
  };
}

function post(events: unknown[]) {
  return request(app)
    .post(INGEST_ENDPOINT)
    .set('x-indexer-worker-token', INDEXER_TOKEN)
    .send({ events });
}

function getEvents(query: Record<string, unknown> = {}) {
  return request(app)
    .get(REPLAY_ENDPOINT)
    .set('x-indexer-worker-token', INDEXER_TOKEN)
    .query(query);
}

describe('Indexer worker contract event ingestion', () => {
  beforeEach(() => {
    resetIndexerState();
    setIndexerIngestAuthToken(TOKEN);
    setIndexerEventStore(new InMemoryContractEventStore());
  });

  it('persists a valid single-event batch', async () => {
    const res = await post([buildEvent('evt-1')]).expect(200);
    expect(res.body.outcome).toBe('persisted');
    expect(res.body.insertedCount).toBe(1);
    expect(res.body.duplicateCount).toBe(0);
    expect(res.body.insertedEventIds).toEqual(['evt-1']);
  });

  it('persists a multi-event batch and returns all inserted ids', async () => {
    const res = await post([buildEvent('evt-1'), buildEvent('evt-2'), buildEvent('evt-3')]).expect(200);
    expect(res.body.insertedCount).toBe(3);
    expect(res.body.insertedEventIds).toHaveLength(3);
  });

  it('absorbs duplicate delivery without failing the retry', async () => {
    await post([buildEvent('evt-1')]).expect(200);
    const res = await post([buildEvent('evt-1')]).expect(200);
    expect(res.body.insertedCount).toBe(0);
    expect(res.body.duplicateCount).toBe(1);
    expect(res.body.duplicateEventIds).toEqual(['evt-1']);
  });

  it('preserves decimal-string amounts in the payload without coercion', async () => {
    const store = new InMemoryContractEventStore();
    setIndexerEventStore(store);
    const preciseAmount = '9999999999999.9999999';
    const event = {
      ...buildEvent('evt-decimal'),
      payload: { depositAmount: preciseAmount, ratePerSecond: '0.0000001' },
    };
    await post([event]).expect(200);
    const stored = store.all()[0];
    expect(stored.payload.depositAmount).toBe(preciseAmount);
    expect(typeof stored.payload.depositAmount).toBe('string');
  });

  it('updates health after a successful ingest', async () => {
    await post([buildEvent('evt-1')]).expect(200);
    const health = await request(app).get('/health').expect(200);
    expect(health.body.dependencies.indexer.store).toBe('memory');
    expect(health.body.dependencies.indexer.dependency).toBe('healthy');
    expect(health.body.dependencies.indexer.lastSuccessfulIngestAt).toBeTruthy();
    expect(health.body.dependencies.indexer.acceptedEventCount).toBe(1);
  });

    expect(response.body.success).toBe(true);
    expect(response.body.data.outcome).toBe('persisted');
    expect(response.body.data.insertedCount).toBe(2);
    expect(response.body.data.duplicateCount).toBe(0);
    expect(response.body.data.insertedEventIds).toEqual(['evt-1', 'evt-2']);
  });

  it('reports lastSafeLedger as maxLedger - 1', async () => {
    await post([buildEvent('evt-1', 1000, 'hash-1000')]).expect(200);
    const health = await request(app).get('/health').expect(200);
    expect(health.body.dependencies.indexer.lastSafeLedger).toBe(999);
  });
});

describe('Indexer HTTP — auth & validation', () => {
  beforeEach(() => {
    resetIndexerState();
    setIndexerIngestAuthToken(TOKEN);
    setIndexerEventStore(new InMemoryContractEventStore());
  });

    expect(response.body.data.insertedCount).toBe(0);
    expect(response.body.data.duplicateCount).toBe(1);
    expect(response.body.data.duplicateEventIds).toEqual(['evt-1']);
  });

  it('rejects unauthenticated callers', async () => {
    const response = await request(app)
      .post(INGEST_ENDPOINT)
      .send({ events: [buildEvent('evt-1')] })
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects oversized payloads predictably', async () => {
    const oversizedPayload = 'x'.repeat(300 * 1024);
    const response = await request(app)
      .post(INGEST_ENDPOINT)
      .set('x-indexer-worker-token', INDEXER_TOKEN)
      .send({ events: [{ ...buildEvent('evt-1'), payload: { oversizedPayload } }] })
      .expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects a batch with an empty eventId', async () => {
    const res = await post([{ ...buildEvent('e1'), eventId: '' }]).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed batches atomically', async () => {
    const response = await postEvents([{ ...buildEvent('evt-1'), eventId: '' }]).expect(400);

  it('rejects a batch with a non-object payload', async () => {
    const res = await post([{ ...buildEvent('e1'), payload: 'not-an-object' }]).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects intra-batch duplicate eventIds', async () => {
    const e = buildEvent('e1');
    const res = await post([e, e]).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects an empty events array', async () => {
    const res = await post([]).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-array events field', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set('x-indexer-worker-token', TOKEN)
      .send({ events: 'not-an-array' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-object body', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set('x-indexer-worker-token', TOKEN)
      .send('plain string')
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Indexer HTTP — dependency state & rate limit', () => {
  beforeEach(() => {
    resetIndexerState();
    setIndexerIngestAuthToken(TOKEN);
    setIndexerEventStore(new InMemoryContractEventStore());
  });

  it('fails closed when dependency is unavailable', async () => {
    setIndexerDependencyState('unavailable', 'postgres down');
    const res = await post([buildEvent('e1')]).expect(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('fails closed when dependency is degraded', async () => {
    setIndexerDependencyState('degraded', 'slow queries');
    const res = await post([buildEvent('e1')]).expect(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rate limits after 30 requests in the same window', async () => {
    for (let i = 0; i < 30; i++) {
      await post([buildEvent(`evt-${i}`)]).expect(200);
    }
    const res = await post([buildEvent('evt-31')]).expect(429);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(res.body.error.details.retryAfterSeconds).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// InMemoryContractEventStore unit tests
// ---------------------------------------------------------------------------

describe('InMemoryContractEventStore — unit', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  function makeRecord(eventId: string, ledger: number, ledgerHash: string) {
    return {
      eventId,
      ledger,
      contractId: 'C1',
      topic: 'test',
      txHash: `tx-${eventId}`,
      txIndex: 0,
      operationIndex: 0,
      eventIndex: 0,
      payload: { amount: '1.0000000' },
      happenedAt: '2026-01-01T00:00:00.000Z',
      ledgerHash,
    };
  }

  it('kind is "memory"', () => {
    expect(store.kind).toBe('memory');
  });

  it('insertMany inserts new records and returns their ids', async () => {
    const result = await store.insertMany([
      makeRecord('e1', 100, 'h100'),
      makeRecord('e2', 101, 'h101'),
    ]);
    expect(result.insertedEventIds).toEqual(['e1', 'e2']);
    expect(result.duplicateEventIds).toEqual([]);
    expect(store.all()).toHaveLength(2);
  });

  it('insertMany treats same eventId as duplicate on second call', async () => {
    await store.insertMany([makeRecord('e1', 100, 'h100')]);
    const result = await store.insertMany([makeRecord('e1', 100, 'h100')]);
    expect(result.duplicateEventIds).toEqual(['e1']);
    expect(store.all()).toHaveLength(1);
  });

  it('insertMany treats intra-batch duplicate as duplicate', async () => {
    const r = makeRecord('e1', 100, 'h100');
    const result = await store.insertMany([r, r]);
    expect(result.insertedEventIds).toEqual(['e1']);
    expect(result.duplicateEventIds).toEqual(['e1']);
  });

  it('insertMany stamps ingestedAt and ignores caller-supplied value', async () => {
    const before = Date.now();
    await store.insertMany([{ ...makeRecord('e1', 100, 'h100'), ingestedAt: '1970-01-01T00:00:00.000Z' }]);
    const after = Date.now();
    const stored = store.all()[0];
    const ingestedMs = new Date(stored.ingestedAt!).getTime();
    expect(ingestedMs).toBeGreaterThanOrEqual(before);
    expect(ingestedMs).toBeLessThanOrEqual(after);
  });

  it('insertMany with empty array returns empty results', async () => {
    const result = await store.insertMany([]);
    expect(result.insertedEventIds).toEqual([]);
    expect(result.duplicateEventIds).toEqual([]);
  });

  it('getLedgerHash returns null for unknown ledger', async () => {
    expect(await store.getLedgerHash(999)).toBeNull();
  });

  it('getLedgerHash returns the hash for a known ledger', async () => {
    await store.insertMany([makeRecord('e1', 100, 'h100')]);
    expect(await store.getLedgerHash(100)).toBe('h100');
  });

  it('rollbackBeforeLedger removes records at and above the fork', async () => {
    await store.insertMany([
      makeRecord('e100', 100, 'h100'),
      makeRecord('e101', 101, 'h101'),
      makeRecord('e102', 102, 'h102'),
    ]);
    await store.rollbackBeforeLedger(101);
    const remaining = store.all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].eventId).toBe('e100');
  });

  it('rollbackBeforeLedger appends a ReorgRecord to the undo-log', async () => {
    await store.insertMany([makeRecord('e101', 101, 'h101')]);
    await store.rollbackBeforeLedger(101);
    const log = store.getReorgLog();
    expect(log).toHaveLength(1);
    expect(log[0].forkLedger).toBe(101);
    expect(log[0].evictedHash).toBe('h101');
    expect(log[0].removedEventIds).toContain('e101');
  });

  it('rollbackBeforeLedger on empty store does not append a log entry', async () => {
    await store.rollbackBeforeLedger(100);
    expect(store.getReorgLog()).toHaveLength(0);
  });

  it('byLedger returns only records for the requested ledger', async () => {
    await store.insertMany([
      makeRecord('e100', 100, 'h100'),
      makeRecord('e101', 101, 'h101'),
    ]);
    const records = store.byLedger(100);
    expect(records).toHaveLength(1);
    expect(records[0].eventId).toBe('e100');
  });

  it('ledgerCount returns the number of distinct ledgers', async () => {
    await store.insertMany([
      makeRecord('e100a', 100, 'h100'),
      makeRecord('e100b', 100, 'h100'),
      makeRecord('e101', 101, 'h101'),
    ]);
    expect(store.ledgerCount()).toBe(2);
  });

  it('tipLedger returns null on empty store', () => {
    expect(store.tipLedger()).toBeNull();
  });

  it('tipLedger returns the highest ledger', async () => {
    await store.insertMany([
      makeRecord('e100', 100, 'h100'),
      makeRecord('e200', 200, 'h200'),
      makeRecord('e150', 150, 'h150'),
    ]);
    expect(store.tipLedger()).toBe(200);
  });

  it('reset clears records and reorg log', async () => {
    await store.insertMany([makeRecord('e1', 100, 'h100')]);
    await store.rollbackBeforeLedger(100);
    store.reset();
    expect(store.all()).toHaveLength(0);
    expect(store.getReorgLog()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PostgresContractEventStore unit tests (mock client)
// ---------------------------------------------------------------------------

describe('PostgresContractEventStore — unit (mock client)', () => {
  function makeMockClient(rows: unknown[] = []) {
    return {
      query: async <T>(_sql: string, _values?: unknown[]) => ({ rows: rows as T[], rowCount: rows.length }),
    };
  }

  it('kind is "postgres"', () => {
    const store = new PostgresContractEventStore(makeMockClient());
    expect(store.kind).toBe('postgres');
  });

  it('insertMany with empty array returns empty results without querying', async () => {
    let called = false;
    const client = { query: async () => { called = true; return { rows: [] }; } };
    const store = new PostgresContractEventStore(client);
    const result = await store.insertMany([]);
    expect(result.insertedEventIds).toEqual([]);
    expect(called).toBe(false);
  });

  it('insertMany returns inserted ids from RETURNING clause', async () => {
    const client = makeMockClient([{ event_id: 'e1' }, { event_id: 'e2' }]);
    const store = new PostgresContractEventStore(client);
    const events = [
      { eventId: 'e1', ledger: 1, contractId: 'C', topic: 't', txHash: 'h', txIndex: 0, operationIndex: 0, eventIndex: 0, payload: {}, happenedAt: '2026-01-01T00:00:00.000Z', ledgerHash: 'lh' },
      { eventId: 'e2', ledger: 1, contractId: 'C', topic: 't', txHash: 'h', txIndex: 0, operationIndex: 0, eventIndex: 0, payload: {}, happenedAt: '2026-01-01T00:00:00.000Z', ledgerHash: 'lh' },
    ];
    const result = await store.insertMany(events);
    expect(result.insertedEventIds).toEqual(['e1', 'e2']);
    expect(result.duplicateEventIds).toEqual([]);
  });

  it('insertMany marks events not in RETURNING as duplicates', async () => {
    const client = makeMockClient([{ event_id: 'e1' }]);
    const store = new PostgresContractEventStore(client);
    const events = [
      { eventId: 'e1', ledger: 1, contractId: 'C', topic: 't', txHash: 'h', txIndex: 0, operationIndex: 0, eventIndex: 0, payload: {}, happenedAt: '2026-01-01T00:00:00.000Z', ledgerHash: 'lh' },
      { eventId: 'e2', ledger: 1, contractId: 'C', topic: 't', txHash: 'h', txIndex: 0, operationIndex: 0, eventIndex: 0, payload: {}, happenedAt: '2026-01-01T00:00:00.000Z', ledgerHash: 'lh' },
    ];
    const result = await store.insertMany(events);
    expect(result.duplicateEventIds).toEqual(['e2']);
  });

  it('rollbackBeforeLedger issues DELETE with correct parameter', async () => {
    let capturedSql = '';
    let capturedValues: unknown[] = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        capturedSql = sql;
        capturedValues = values ?? [];
        return { rows: [] };
      },
    };
    const store = new PostgresContractEventStore(client);
    await store.rollbackBeforeLedger(101);
    expect(capturedSql).toContain('DELETE');
    expect(capturedSql).toContain('ledger >= $1');
    expect(capturedValues).toEqual([101]);
  });

  it('getLedgerHash returns null when no rows returned', async () => {
    const store = new PostgresContractEventStore(makeMockClient([]));
    expect(await store.getLedgerHash(100)).toBeNull();
  });

  it('getLedgerHash returns the hash from the first row', async () => {
    const store = new PostgresContractEventStore(makeMockClient([{ ledger_hash: 'abc123' }]));
    expect(await store.getLedgerHash(100)).toBe('abc123');
  });
});

// ---------------------------------------------------------------------------
// toDecimalString utility
// ---------------------------------------------------------------------------

describe('toDecimalString()', () => {
  it('accepts valid decimal strings', () => {
    expect(toDecimalString('100.0000000')).toBe('100.0000000');
    expect(toDecimalString('0')).toBe('0');
    expect(toDecimalString('-50.5')).toBe('-50.5');
    expect(toDecimalString('+1.5')).toBe('+1.5');
  });

    expect(response.body.data.dependencies.indexer.store).toBe('memory');
    expect(response.body.data.dependencies.indexer.dependency).toBe('healthy');
    expect(response.body.data.dependencies.indexer.lastSuccessfulIngestAt).toBeTruthy();
    expect(response.body.data.dependencies.indexer.acceptedEventCount).toBe(1);
  });
});

describe('GET /internal/indexer/events — replay endpoint', () => {
  beforeEach(() => {
    resetIndexerState();
    setIndexerIngestAuthToken(INDEXER_TOKEN);
    setIndexerEventStore(new InMemoryContractEventStore());
  });

  it('returns empty result when no events have been ingested', async () => {
    const response = await getEvents().expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.events).toEqual([]);
    expect(response.body.data.total).toBe(0);
  });

  it('returns all ingested events in ledger order', async () => {
    await postEvents([buildEvent('evt-2', 600), buildEvent('evt-1', 500)]).expect(200);

    const response = await getEvents().expect(200);

    expect(response.body.data.total).toBe(2);
    expect(response.body.data.events[0].eventId).toBe('evt-1');
    expect(response.body.data.events[1].eventId).toBe('evt-2');
  });

  it('filters by fromLedger', async () => {
    await postEvents([buildEvent('evt-1', 100), buildEvent('evt-2', 200), buildEvent('evt-3', 300)]).expect(200);

    const response = await getEvents({ fromLedger: 200 }).expect(200);

    expect(response.body.data.total).toBe(2);
    expect(response.body.data.events.map((e: any) => e.eventId)).toEqual(['evt-2', 'evt-3']);
  });

  it('filters by toledger', async () => {
    await postEvents([buildEvent('evt-1', 100), buildEvent('evt-2', 200), buildEvent('evt-3', 300)]).expect(200);

    const response = await getEvents({ toledger: 200 }).expect(200);

    expect(response.body.data.total).toBe(2);
    expect(response.body.data.events.map((e: any) => e.eventId)).toEqual(['evt-1', 'evt-2']);
  });

  it('filters by contractId', async () => {
    const store = new InMemoryContractEventStore();
    setIndexerEventStore(store);
    await postEvents([
      { ...buildEvent('evt-1'), contractId: 'CONTRACT-A' },
      { ...buildEvent('evt-2'), contractId: 'CONTRACT-B' },
    ]).expect(200);

    const response = await getEvents({ contractId: 'CONTRACT-A' }).expect(200);

    expect(response.body.data.total).toBe(1);
    expect(response.body.data.events[0].contractId).toBe('CONTRACT-A');
  });

  it('filters by topic', async () => {
    await postEvents([
      { ...buildEvent('evt-1'), topic: 'stream.created' },
      { ...buildEvent('evt-2'), topic: 'stream.cancelled' },
    ]).expect(200);

    const response = await getEvents({ topic: 'stream.cancelled' }).expect(200);

    expect(response.body.data.total).toBe(1);
    expect(response.body.data.events[0].topic).toBe('stream.cancelled');
  });

  it('paginates with limit and offset', async () => {
    await postEvents([
      buildEvent('evt-1', 100),
      buildEvent('evt-2', 200),
      buildEvent('evt-3', 300),
    ]).expect(200);

    const page1 = await getEvents({ limit: 2, offset: 0 }).expect(200);
    expect(page1.body.data.events).toHaveLength(2);
    expect(page1.body.data.total).toBe(3);
    expect(page1.body.data.limit).toBe(2);
    expect(page1.body.data.offset).toBe(0);

    const page2 = await getEvents({ limit: 2, offset: 2 }).expect(200);
    expect(page2.body.data.events).toHaveLength(1);
    expect(page2.body.data.events[0].eventId).toBe('evt-3');
  });

  it('rejects unauthenticated replay requests', async () => {
    const response = await request(app).get(REPLAY_ENDPOINT).expect(401);

    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('preserves decimal-string amounts in replayed event payloads', async () => {
    await postEvents([buildEvent('evt-1')]).expect(200);

    const response = await getEvents().expect(200);
    const payload = response.body.data.events[0].payload;

    expect(typeof payload.depositAmount).toBe('string');
    expect(typeof payload.ratePerSecond).toBe('string');
    expect(payload.depositAmount).toMatch(/^\d+\.\d+$/);
    expect(payload.ratePerSecond).toMatch(/^\d+\.\d+$/);
  });

  it('caps limit at 1000', async () => {
    const response = await getEvents({ limit: 9999 }).expect(200);

    expect(response.body.data.limit).toBe(1000);
  });
});
