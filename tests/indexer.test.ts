import request from 'supertest';
import { app } from '../src/app.js';
import { InMemoryContractEventStore } from '../src/indexer/store.js';
import {
  resetIndexerState,
  setIndexerDependencyState,
  setIndexerEventStore,
  setIndexerIngestAuthToken,
} from '../src/routes/indexer.js';

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
      ratePerSecond: '0.1000000',
      sender: 'GAAA',
      recipient: 'GBBB',
    },
    happenedAt: '2026-03-26T12:00:00.000Z',
    ledgerHash: `hash-${ledger}`,
  };
}

function postEvents(events: unknown[]) {
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
    setIndexerIngestAuthToken(INDEXER_TOKEN);
    setIndexerEventStore(new InMemoryContractEventStore());
  });

  it('persists a valid batch and reports inserted ids', async () => {
    const response = await postEvents([buildEvent('evt-1'), buildEvent('evt-2')]).expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.outcome).toBe('persisted');
    expect(response.body.data.insertedCount).toBe(2);
    expect(response.body.data.duplicateCount).toBe(0);
    expect(response.body.data.insertedEventIds).toEqual(['evt-1', 'evt-2']);
  });

  it('absorbs duplicate delivery by eventId without failing the retry', async () => {
    await postEvents([buildEvent('evt-1')]).expect(200);

    const response = await postEvents([buildEvent('evt-1')]).expect(200);

    expect(response.body.data.insertedCount).toBe(0);
    expect(response.body.data.duplicateCount).toBe(1);
    expect(response.body.data.duplicateEventIds).toEqual(['evt-1']);
  });

  it('rejects unauthenticated callers', async () => {
    const response = await request(app)
      .post(INGEST_ENDPOINT)
      .send({ events: [buildEvent('evt-1')] })
      .expect(401);

    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects oversized payloads predictably', async () => {
    const oversizedPayload = 'x'.repeat(300 * 1024);
    const response = await request(app)
      .post(INGEST_ENDPOINT)
      .set('x-indexer-worker-token', INDEXER_TOKEN)
      .send({ events: [{ ...buildEvent('evt-1'), payload: { oversizedPayload } }] })
      .expect(413);

    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects malformed batches atomically', async () => {
    const response = await postEvents([{ ...buildEvent('evt-1'), eventId: '' }]).expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects duplicate event ids within a single submitted batch', async () => {
    const event = buildEvent('evt-1');
    const response = await postEvents([event, event]).expect(409);

    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('fails closed when the durable store is unavailable', async () => {
    setIndexerDependencyState('unavailable', 'postgres unavailable');

    const response = await postEvents([buildEvent('evt-1')]).expect(503);

    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rate limits excessive ingest requests from the same actor', async () => {
    for (let index = 0; index < 30; index += 1) {
      await postEvents([buildEvent(`evt-${index}`)]).expect(200);
    }

    const response = await postEvents([buildEvent('evt-31')]).expect(429);

    expect(response.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(response.body.error.details.retryAfterSeconds).toBe(60);
  });

  it('exposes operator health for the indexer dependency', async () => {
    await postEvents([buildEvent('evt-1')]).expect(200);

    const response = await request(app).get('/health').expect(200);

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
