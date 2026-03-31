import request from 'supertest';
import { app } from '../src/app.js';
import { InMemoryContractEventStore } from '../src/indexer/store.js';
import {
  resetIndexerState,
  setIndexerEventStore,
  setIndexerIngestAuthToken,
} from '../src/routes/indexer.js';

const INDEXER_TOKEN = 'test-reorg-token';
const ENDPOINT = '/internal/indexer/contract-events';

let idempotencyKeyCounter = 0;
function nextIdempotencyKey(): string {
  idempotencyKeyCounter += 1;
  return `test-reorg-idempotency-${idempotencyKeyCounter}`;
}

function buildEvent(eventId: string, ledger: number, ledgerHash: string) {
  return {
    eventId,
    ledger,
    contractId: 'CCONTRACT123',
    topic: 'stream.created',
    txHash: `tx-${eventId}`,
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: { streamId: `stream-${eventId}` },
    happenedAt: '2026-03-26T12:00:00.000Z',
    ledgerHash,
  };
}

function postEvents(events: unknown[]) {
  return request(app)
    .post('/internal/indexer/contract-events')
    .set('x-indexer-worker-token', INDEXER_TOKEN)
    .send({ events });
}

describe('Indexer Reorg Handling and Chain Tip Safety', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    resetIndexerState();
    setIndexerIngestAuthToken(INDEXER_TOKEN);
    store = new InMemoryContractEventStore();
    setIndexerEventStore(store);
  });

  it('reports lastSafeLedger as (maxLedger - 1)', async () => {
    await postEvents([buildEvent('evt-1', 100, 'hash-100')]).expect(200);
    
    const response = await request(app).get('/health').expect(200);
    expect(response.body.dependencies.indexer.lastSafeLedger).toBe(99);
    expect(response.body.dependencies.indexer.reorgDetected).toBe(false);
  });

  it('detects a reorg and rolls back the store', async () => {
    // Ingest ledger 100
    await postEvents([buildEvent('evt-100', 100, 'hash-100')]).expect(200);
    // Ingest ledger 101
    await postEvents([buildEvent('evt-101', 101, 'hash-101')]).expect(200);
    
    expect(store.all().length).toBe(2);

    // Ingest ledger 101 with DIFFERENT hash (reorg)
    const reorgResponse = await postEvents([buildEvent('evt-101-new', 101, 'hash-101-reorg')]).expect(200);
    
    expect(reorgResponse.body.insertedCount).toBe(1);
    
    // Ledger 101 should have been rolled back and re-inserted
    const records = store.all();
    expect(records.length).toBe(2);
    expect(records.find(r => r.ledger === 101)?.ledgerHash).toBe('hash-101-reorg');
    expect(records.find(r => r.ledger === 101)?.eventId).toBe('evt-101-new');

    const health = await request(app).get('/health').expect(200);
    if (!health.body.dependencies.indexer.reorgDetected) {
      console.log('REORG DETECTED FAIL. Health body:', JSON.stringify(health.body, null, 2));
    }
    expect(health.body.dependencies.indexer.reorgDetected).toBe(true);
    expect(health.body.dependencies.indexer.lastSafeLedger).toBe(100);
  });

  it('resets reorgDetected flag once past the reorg point', async () => {
    // Trigger reorg at ledger 100
    await postEvents([buildEvent('evt-100', 100, 'hash-100')]).expect(200);
    await postEvents([buildEvent('evt-100-new', 100, 'hash-100-reorg')]).expect(200);
    
    let health = await request(app).get('/health').expect(200);
    expect(health.body.dependencies.indexer.reorgDetected).toBe(true);

    // Ingest ledger 110 (vastly past 100 + 5 buffer)
    await postEvents([buildEvent('evt-110', 110, 'hash-110')]).expect(200);
    
    health = await request(app).get('/health').expect(200);
    expect(health.body.dependencies.indexer.reorgDetected).toBe(false);
    expect(health.body.dependencies.indexer.lastSafeLedger).toBe(109);
  });
});
