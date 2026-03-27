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
const ENDPOINT = '/internal/indexer/contract-events';

function buildEvent(eventId: string) {
  return {
    eventId,
    ledger: 512345,
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
  };
}

function postEvents(events: unknown[]) {
  return request(app)
    .post(ENDPOINT)
    .set('x-indexer-worker-token', INDEXER_TOKEN)
    .send({ events });
}

describe('Indexer worker contract event ingestion', () => {
  beforeEach(() => {
    resetIndexerState();
    setIndexerIngestAuthToken(INDEXER_TOKEN);
    setIndexerEventStore(new InMemoryContractEventStore());
  });

  it('persists a valid batch and reports inserted ids', async () => {
    const response = await postEvents([buildEvent('evt-1'), buildEvent('evt-2')]).expect(200);

    expect(response.body.outcome).toBe('persisted');
    expect(response.body.insertedCount).toBe(2);
    expect(response.body.duplicateCount).toBe(0);
    expect(response.body.insertedEventIds).toEqual(['evt-1', 'evt-2']);
  });

  it('absorbs duplicate delivery by eventId without failing the retry', async () => {
    await postEvents([buildEvent('evt-1')]).expect(200);

    const response = await postEvents([buildEvent('evt-1')]).expect(200);

    expect(response.body.insertedCount).toBe(0);
    expect(response.body.duplicateCount).toBe(1);
    expect(response.body.duplicateEventIds).toEqual(['evt-1']);
  });

  it('rejects unauthenticated callers', async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .send({ events: [buildEvent('evt-1')] })
      .expect(401);

    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects oversized payloads predictably', async () => {
    const oversizedPayload = 'x'.repeat(300 * 1024);
    const response = await request(app)
      .post(ENDPOINT)
      .set('x-indexer-worker-token', INDEXER_TOKEN)
      .send({
        events: [
          {
            ...buildEvent('evt-1'),
            payload: {
              oversizedPayload,
            },
          },
        ],
      })
      .expect(413);

    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects malformed batches atomically', async () => {
    const response = await postEvents([
      {
        ...buildEvent('evt-1'),
        eventId: '',
      },
    ]).expect(400);

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

    expect(response.body.dependencies.indexer.store).toBe('memory');
    expect(response.body.dependencies.indexer.dependency).toBe('healthy');
    expect(response.body.dependencies.indexer.lastSuccessfulIngestAt).toBeTruthy();
    expect(response.body.dependencies.indexer.acceptedEventCount).toBe(1);
  });
});
