/**
 * Cursor-based event replay endpoint tests.
 *
 * Covers:
 *  - GET /internal/indexer/events/replay — cursor-based pagination
 *  - afterEventId cursor: start from beginning, advance, end-of-store
 *  - nextCursor in response for multi-page traversal
 *  - Combined cursor + filter (fromLedger, topic)
 *  - Authentication enforcement
 *  - Decimal-string serialization preservation
 *  - limit cap at 1000
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { InMemoryContractEventStore } from '../src/indexer/store.js';
import {
  indexerRouter,
  resetIndexerState,
  setIndexerEventStore,
  setIndexerIngestAuthToken,
} from '../src/routes/indexer.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

// Minimal app — just the indexer router + error handler
const app = express();
app.use(express.json());
app.use('/internal/indexer', indexerRouter);
app.use(errorHandler);

const INDEXER_TOKEN = 'test-indexer-token';
const INGEST_ENDPOINT = '/internal/indexer/contract-events';
const CURSOR_REPLAY_ENDPOINT = '/internal/indexer/events/replay';

function buildEvent(eventId: string, ledger: number, ledgerHash = `hash-${ledger}`) {
  return {
    eventId,
    ledger,
    contractId: 'CCONTRACT123',
    topic: 'stream.created',
    txHash: `tx-${eventId}`,
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: { depositAmount: '100.0000000', ratePerSecond: '0.0000001' },
    happenedAt: '2026-03-26T12:00:00.000Z',
    ledgerHash,
  };
}

function ingest(events: unknown[]) {
  return request(app)
    .post(INGEST_ENDPOINT)
    .set('x-indexer-worker-token', INDEXER_TOKEN)
    .send({ events });
}

function getReplay(query: Record<string, unknown> = {}) {
  return request(app)
    .get(CURSOR_REPLAY_ENDPOINT)
    .set('x-indexer-worker-token', INDEXER_TOKEN)
    .query(query);
}

describe('GET /internal/indexer/events/replay — cursor-based replay', () => {
  beforeEach(() => {
    resetIndexerState();
    setIndexerIngestAuthToken(INDEXER_TOKEN);
    setIndexerEventStore(new InMemoryContractEventStore());
  });

  it('returns empty result when no events have been ingested', async () => {
    const res = await getReplay().expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.events).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it('returns all events in ledger-ascending order when no cursor is supplied', async () => {
    await ingest([buildEvent('e2', 200), buildEvent('e1', 100)]).expect(200);

    const res = await getReplay().expect(200);
    expect(res.body.data.events.map((e: any) => e.eventId)).toEqual(['e1', 'e2']);
  });

  it('returns only events after the cursor when afterEventId is supplied', async () => {
    await ingest([
      buildEvent('e1', 100),
      buildEvent('e2', 200),
      buildEvent('e3', 300),
    ]).expect(200);

    const res = await getReplay({ afterEventId: 'e1' }).expect(200);
    expect(res.body.data.events.map((e: any) => e.eventId)).toEqual(['e2', 'e3']);
  });

  it('returns empty events when cursor is at the last event', async () => {
    await ingest([buildEvent('e1', 100)]).expect(200);

    const res = await getReplay({ afterEventId: 'e1' }).expect(200);
    expect(res.body.data.events).toEqual([]);
  });

  it('returns empty events when afterEventId is unknown (cursor past end)', async () => {
    await ingest([buildEvent('e1', 100)]).expect(200);

    const res = await getReplay({ afterEventId: 'nonexistent-cursor' }).expect(200);
    expect(res.body.data.events).toEqual([]);
  });

  it('includes nextCursor in response when more events exist beyond the page', async () => {
    await ingest([
      buildEvent('e1', 100),
      buildEvent('e2', 200),
      buildEvent('e3', 300),
    ]).expect(200);

    const res = await getReplay({ limit: 2 }).expect(200);
    expect(res.body.data.events).toHaveLength(2);
    expect(res.body.data.nextCursor).toBe('e2');
  });

  it('can page through all events using nextCursor', async () => {
    await ingest([
      buildEvent('e1', 100),
      buildEvent('e2', 200),
      buildEvent('e3', 300),
    ]).expect(200);

    const page1 = await getReplay({ limit: 2 }).expect(200);
    expect(page1.body.data.events.map((e: any) => e.eventId)).toEqual(['e1', 'e2']);
    const cursor = page1.body.data.nextCursor;
    expect(cursor).toBe('e2');

    const page2 = await getReplay({ limit: 2, afterEventId: cursor }).expect(200);
    expect(page2.body.data.events.map((e: any) => e.eventId)).toEqual(['e3']);
    expect(page2.body.data.nextCursor).toBeUndefined();
  });

  it('caps limit at 1000', async () => {
    const res = await getReplay({ limit: 9999 }).expect(200);
    expect(res.body.data.limit).toBe(1000);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get(CURSOR_REPLAY_ENDPOINT).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('preserves decimal-string amounts in replayed event payloads', async () => {
    const preciseAmount = '9999999999999.9999999';
    await ingest([{
      ...buildEvent('e-decimal', 100),
      payload: { depositAmount: preciseAmount, ratePerSecond: '0.0000001' },
    }]).expect(200);

    const res = await getReplay().expect(200);
    const payload = res.body.data.events[0].payload;
    expect(typeof payload.depositAmount).toBe('string');
    expect(payload.depositAmount).toBe(preciseAmount);
  });

  it('filters by fromLedger combined with cursor', async () => {
    await ingest([
      buildEvent('e1', 100),
      buildEvent('e2', 200),
      buildEvent('e3', 300),
      buildEvent('e4', 400),
    ]).expect(200);

    // afterEventId=e1 AND fromLedger=200 → e2, e3, e4
    const res = await getReplay({ afterEventId: 'e1', fromLedger: 200 }).expect(200);
    expect(res.body.data.events.map((e: any) => e.eventId)).toEqual(['e2', 'e3', 'e4']);
  });

  it('filters by topic combined with cursor', async () => {
    await ingest([
      { ...buildEvent('e1', 100), topic: 'stream.created' },
      { ...buildEvent('e2', 200), topic: 'stream.cancelled' },
      { ...buildEvent('e3', 300), topic: 'stream.created' },
    ]).expect(200);

    const res = await getReplay({ afterEventId: 'e1', topic: 'stream.created' }).expect(200);
    expect(res.body.data.events.map((e: any) => e.eventId)).toEqual(['e3']);
  });
});
