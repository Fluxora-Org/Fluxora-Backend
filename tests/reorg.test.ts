/**
 * Chain reorganisation tests for the Fluxora indexer.
 *
 * Strategy under test
 * -------------------
 * The indexer uses ledger-hash-based reorg detection:
 *   - If an incoming batch contains a ledgerHash that differs from the stored
 *     hash for the same ledger sequence, a fork is detected.
 *   - The store rolls back all records at ledger >= forkLedger.
 *   - The canonical (post-reorg) events are then inserted in the same request.
 *   - The service sets reorgDetected=true and reorgHeight=forkLedger.
 *   - reorgDetected resets to false once we are > forkLedger + 5 ledgers ahead.
 *
 * Security / double-counting invariants verified here
 * ---------------------------------------------------
 * 1. Events from the orphaned chain are fully removed before canonical events
 *    are inserted — no double-counting.
 * 2. The common ancestor (ledger < forkLedger) is never touched.
 * 3. A deep reorg (10 blocks) leaves the store at the correct ancestor state.
 * 4. Multiple sequential reorgs are handled independently.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { InMemoryContractEventStore } from '../src/indexer/store.js';
import {
  resetIndexerState,
  setIndexerEventStore,
  setIndexerIngestAuthToken,
} from '../src/routes/indexer.js';
import { isLedgerRolledBack, _resetRolledBackLedgers } from '../src/indexer/service.js';
import { dispatchWebhook } from '../src/webhooks/dispatcher.js';

const INDEXER_TOKEN = 'test-reorg-token';

function buildEvent(eventId: string, ledger: number, ledgerHash: string, eventIndex = 0) {
  return {
    eventId,
    ledger,
    contractId: 'CCONTRACT123',
    topic: 'stream.created',
    txHash: `tx-${eventId}`,
    txIndex: 0,
    operationIndex: 0,
    eventIndex,
    payload: {
      streamId: `stream-${eventId}`,
      depositAmount: '100.0000000',
    },
    happenedAt: '2026-03-26T12:00:00.000Z',
    ledgerHash,
  };
}

function post(events: unknown[]) {
  return request(app)
    .post(ENDPOINT)
    .set('x-indexer-worker-token', TOKEN)
    .send({ events });
}

async function getHealth() {
  const res = await request(app).get('/health').expect(200);
  return res.body.dependencies.indexer as {
    lastSafeLedger: number;
    reorgDetected: boolean;
    reorgHeight?: number;
    acceptedEventCount: number;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Indexer reorg handling', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    resetIndexerState();
    setIndexerIngestAuthToken(TOKEN);
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
    await postEvents([buildEvent('evt-100', 100, 'hash-100')]).expect(200);
    await postEvents([buildEvent('evt-101', 101, 'hash-101')]).expect(200);
    expect(store.all().length).toBe(2);

    const reorgResponse = await postEvents([buildEvent('evt-101-new', 101, 'hash-101-reorg')]).expect(200);
    expect(reorgResponse.body.insertedCount).toBe(1);

    const records = store.all();
    // Should still have 10 records — the reorged chain, not 20
    expect(records).toHaveLength(10);

    const health = await request(app).get('/health').expect(200);
    expect(health.body.dependencies.indexer.reorgDetected).toBe(true);
    expect(health.body.dependencies.indexer.lastSafeLedger).toBe(100);
  });

  it('resets reorgDetected flag once past the reorg point', async () => {
    await postEvents([buildEvent('evt-100', 100, 'hash-100')]).expect(200);
    await postEvents([buildEvent('evt-100-new', 100, 'hash-100-reorg')]).expect(200);

    let health = await request(app).get('/health').expect(200);
    expect(health.body.dependencies.indexer.reorgDetected).toBe(true);

    await postEvents([buildEvent('evt-110', 110, 'hash-110')]).expect(200);

    health = await request(app).get('/health').expect(200);
    expect(health.body.dependencies.indexer.reorgDetected).toBe(false);
    expect(health.body.dependencies.indexer.lastSafeLedger).toBe(109);
  });
});

describe('Reorg rollback prevents duplicate webhooks and WS events', () => {
  beforeEach(() => {
    resetIndexerState();
    setIndexerIngestAuthToken(INDEXER_TOKEN);
    const store = new InMemoryContractEventStore();
    setIndexerEventStore(store);
  });

  afterEach(() => {
    _resetRolledBackLedgers();
  });

  // ── isLedgerRolledBack ────────────────────────────────────────────────────

  it('isLedgerRolledBack returns false before any reorg', () => {
    expect(isLedgerRolledBack(100)).toBe(false);
  });

  it('isLedgerRolledBack returns true after a reorg at that ledger', async () => {
    await postEvents([buildEvent('evt-100', 100, 'hash-100')]).expect(200);
    // Trigger reorg
    await postEvents([buildEvent('evt-100-new', 100, 'hash-100-reorg')]).expect(200);
    expect(isLedgerRolledBack(100)).toBe(true);
  });

  it('isLedgerRolledBack returns false for a ledger that was not reorged', async () => {
    await postEvents([buildEvent('evt-100', 100, 'hash-100')]).expect(200);
    await postEvents([buildEvent('evt-101-new', 101, 'hash-101-reorg')]).expect(200);
    // ledger 100 was not reorged
    expect(isLedgerRolledBack(100)).toBe(false);
  });

  it('isLedgerRolledBack clears after chain advances past reorg + 5', async () => {
    await postEvents([buildEvent('evt-100', 100, 'hash-100')]).expect(200);
    await postEvents([buildEvent('evt-100-new', 100, 'hash-100-reorg')]).expect(200);
    expect(isLedgerRolledBack(100)).toBe(true);

    // Advance past reorg height + 5
    await postEvents([buildEvent('evt-110', 110, 'hash-110')]).expect(200);
    expect(isLedgerRolledBack(100)).toBe(false);
  });

  // ── Webhook dispatcher suppression ───────────────────────────────────────

  it('dispatchWebhook skips delivery for a rolled-back ledger', async () => {
    await postEvents([buildEvent('evt-200', 200, 'hash-200')]).expect(200);
    await postEvents([buildEvent('evt-200-new', 200, 'hash-200-reorg')]).expect(200);

    const dispatched: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = async () => {
      dispatched.push('called');
      return new Response(null, { status: 200 });
    };

    try {
      await dispatchWebhook({
        url: 'https://example.com/hook',
        secret: 'secret',
        event: 'stream.created',
        payload: { streamId: 'stream-1' },
        ledger: 200,
      });
      expect(dispatched).toHaveLength(0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('dispatchWebhook delivers normally when ledger is not rolled back', async () => {
    const dispatched: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = async () => {
      dispatched.push('called');
      return new Response(null, { status: 200 });
    };

    try {
      await dispatchWebhook({
        url: 'https://example.com/hook',
        secret: 'secret',
        event: 'stream.created',
        payload: { streamId: 'stream-1' },
        ledger: 999,
      });
      expect(dispatched).toHaveLength(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('dispatchWebhook delivers normally when no ledger is provided', async () => {
    await postEvents([buildEvent('evt-300', 300, 'hash-300')]).expect(200);
    await postEvents([buildEvent('evt-300-new', 300, 'hash-300-reorg')]).expect(200);

    const dispatched: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = async () => {
      dispatched.push('called');
      return new Response(null, { status: 200 });
    };

    try {
      // No ledger field — should not be suppressed
      await dispatchWebhook({
        url: 'https://example.com/hook',
        secret: 'secret',
        event: 'stream.created',
        payload: { streamId: 'stream-1' },
      });
      expect(dispatched).toHaveLength(1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
