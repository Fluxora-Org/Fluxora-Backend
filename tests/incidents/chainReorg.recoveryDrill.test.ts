/**
 * Chain reorganisation recovery drill (issue #1566).
 *
 * Simulates a Stellar chain reorganisation against the public ingest API and
 * follows the documented procedure end-to-end, exactly as an operator would
 * after a real fork:
 *
 *   docs/runbooks/chain-reorg-recovery.md
 *
 * Acceptance criteria exercised here:
 *   1. Reorg detection mechanism is asserted (hash mismatch at a stored ledger).
 *   2. The recovery procedure is followed step by step (convergence guard,
 *      replay re-verification).
 *   3. The data that must be invalidated is identified and asserted
 *      (all events at or above the fork ledger are evicted; below is kept).
 *   4. The procedure is exercised as a drill: a reorg is simulated and the
 *      final state is verified to be correct (canonical-only, contiguous).
 *
 * The webhook-suppression step asserts the real Prometheus counter object
 * (`fluxora_webhook_deliveries_suppressed_total`) with a spy, so the drill
 * remains hermetic without stubbing the global metrics registry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { webhookDeliveriesSuppressedTotal } from '../../src/metrics/businessMetrics.js';
import {
  resetIndexerState,
  setIndexerEventStore,
  setIndexerIngestAuthToken,
} from '../../src/routes/indexer.js';
import { InMemoryContractEventStore } from '../../src/indexer/store.js';
import { dispatchWebhook } from '../../src/webhooks/dispatcher.js';
import { _resetRolledBackLedgers } from '../../src/indexer/service.js';

const TOKEN = 'reorg-drill-token';
const INGEST_ENDPOINT = '/internal/indexer/contract-events';
const EVENTS_ENDPOINT = '/internal/indexer/events';

/** Ledger at which the canonical chain forks away from the indexed branch. */
const FORK_LEDGER = 512_345;

/** Tip of the originally indexed (soon-to-be-discarded) branch. */
const OLD_TIP = 512_345;

/** Tip of the canonical branch after the reorg settles. */
const NEW_TIP = 512_352;

const HAPPENED_AT = '2026-03-26T12:00:00.000Z';

function ev(eventId: string, ledger: number, ledgerHash: string) {
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
    happenedAt: HAPPENED_AT,
    ledgerHash,
  };
}

function ingest(events: unknown[]) {
  return request(app)
    .post(INGEST_ENDPOINT)
    .set('x-indexer-worker-token', TOKEN)
    .send({ events });
}

function listEvents(query: Record<string, unknown>) {
  return request(app)
    .get(EVENTS_ENDPOINT)
    .set('x-indexer-worker-token', TOKEN)
    .query(query);
}

/** Same snapshot that `GET /health` serves at `dependencies.indexer`. */
async function indexerHealth() {
  const res = await request(app).get('/health').expect(200);
  return res.body.dependencies.indexer as {
    reorgDetected: boolean;
    lastFailureReason: string | null;
  };
}

describe('Chain reorg recovery drill (docs/runbooks/chain-reorg-recovery.md)', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    _resetRolledBackLedgers();
    resetIndexerState();
    setIndexerIngestAuthToken(TOKEN);
    store = new InMemoryContractEventStore();
    setIndexerEventStore(store);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetRolledBackLedgers();
  });

  it('detects a reorg, invalidates the forked range, and converges to the canonical final state', async () => {
    // ── Step 1: baseline — index the original branch up to OLD_TIP ──────────
    const oldBranch = [];
    for (let ledger = FORK_LEDGER - 5; ledger <= OLD_TIP; ledger += 1) {
      oldBranch.push(ev(`old-${ledger}`, ledger, `hash-${ledger}`));
    }
    const baseline = await ingest(oldBranch).expect(200);
    expect(baseline.body.data.outcome).toBe('persisted');
    expect(baseline.body.data.insertedCount).toBe(oldBranch.length);

    // ── Step 2: simulate the reorg — the canonical branch overwrites ledger
    //    FORK_LEDGER (different hash) and extends past it ────────────────────
    const canonicalBranch = [
      ev(`canon-${FORK_LEDGER}`, FORK_LEDGER, `hash-${FORK_LEDGER}-canonical`),
      ev(`canon-${FORK_LEDGER + 1}`, FORK_LEDGER + 1, `hash-${FORK_LEDGER + 1}-canonical`),
      ev(`canon-${FORK_LEDGER + 2}`, FORK_LEDGER + 2, `hash-${FORK_LEDGER + 2}-canonical`),
    ];
    await ingest(canonicalBranch).expect(200);

    // ── Step 3 (acceptance 1+3): the detection signal fires and exactly the
    //    data at or above the fork is invalidated ────────────────────────────
    const reorgLog = store.getReorgLog();
    expect(reorgLog).toHaveLength(1);
    expect(reorgLog[0].forkLedger).toBe(FORK_LEDGER);
    expect(reorgLog[0].evictedHash).toBe(`hash-${FORK_LEDGER}`);
    expect(reorgLog[0].removedEventIds).toEqual(
      expect.arrayContaining([`old-${FORK_LEDGER}`]),
    );

    // Everything below the fork survives untouched.
    const belowFork = store.all().filter((r) => r.ledger < FORK_LEDGER);
    expect(belowFork.map((r) => r.eventId)).toEqual(
      oldBranch.slice(0, -1).map((e) => e.eventId),
    );
    // Nothing from the discarded branch at or above the fork remains.
    expect(store.all().some((r) => r.ledgerHash === `hash-${OLD_TIP}`)).toBe(false);
    // The canonical replacement for the fork ledger was persisted in the same ingest.
    expect(store.byLedger(FORK_LEDGER).map((r) => r.ledgerHash)).toEqual([
      `hash-${FORK_LEDGER}-canonical`,
    ]);

    const healthDuringReorg = await indexerHealth();
    expect(healthDuringReorg.reorgDetected).toBe(true);
    expect(healthDuringReorg.lastFailureReason).toBe(
      `Reorg detected at ledger ${FORK_LEDGER}`,
    );

    // ── Step 4 (acceptance 2): converge — ingest canonical ledgers past the
    //    +5 guard window and confirm the service clears the reorg state ─────
    const tail = [];
    for (let ledger = FORK_LEDGER + 3; ledger <= NEW_TIP; ledger += 1) {
      tail.push(ev(`canon-${ledger}`, ledger, `hash-${ledger}-canonical`));
    }
    await ingest(tail).expect(200); // maxLedger = NEW_TIP > FORK_LEDGER + 5

    const healthAfterConvergence = await indexerHealth();
    expect(healthAfterConvergence.reorgDetected).toBe(false);
    // lastFailureReason is a historical "last failure" record, not an active
    // flag: it keeps the reorg message for post-incident review. The active
    // reorg signal is `reorgDetected`, which the convergence guard cleared.

    // ── Step 5 (acceptance 4): verify the correct final state — the replay
    //    API over [fork, tip] returns only canonical events, contiguous ──────
    const replay = await listEvents({
      fromLedger: FORK_LEDGER,
      toledger: NEW_TIP,
      limit: 100,
    }).expect(200);

    const replayed = replay.body.data.events as Array<{
      eventId: string;
      ledger: number;
      ledgerHash: string;
    }>;
    expect(replayed).toHaveLength(NEW_TIP - FORK_LEDGER + 1);
    expect(replayed.map((e) => e.ledger)).toEqual(
      Array.from({ length: NEW_TIP - FORK_LEDGER + 1 }, (_, i) => FORK_LEDGER + i),
    );
    for (const e of replayed) {
      expect(e.ledgerHash).toBe(`hash-${e.ledger}-canonical`);
      expect(e.eventId).toBe(`canon-${e.ledger}`);
    }
    // Pre-fork data is still intact for its consumers.
    expect(store.all().some((r) => r.eventId === `old-${FORK_LEDGER - 1}`)).toBe(true);
  });

  it('suppresses webhook deliveries for rolled-back ledgers while the reorg window is open', async () => {
    // Establish the baseline and trigger the reorg so FORK_LEDGER lands in
    // the rolled-back set (procedure steps 1–3).
    await ingest([
      ev('old-baseline', FORK_LEDGER, `hash-${FORK_LEDGER}`),
    ]).expect(200);
    await ingest([
      ev(`canon-${FORK_LEDGER}`, FORK_LEDGER, `hash-${FORK_LEDGER}-canonical`),
      ev(`canon-${FORK_LEDGER + 1}`, FORK_LEDGER + 1, `hash-${FORK_LEDGER + 1}-canonical`),
    ]).expect(200);

    const incSpy = vi.spyOn(webhookDeliveriesSuppressedTotal, 'inc');

    // A delivery referencing a rolled-back ledger is suppressed, not sent.
    // (8.8.8.8 is a public IP over HTTPS, so the SSRF guard passes and the
    // suppression branch is what short-circuits the dispatch.)
    await expect(
      dispatchWebhook({
        url: 'https://8.8.8.8/webhook',
        secret: 'drill-secret',
        event: 'stream.created',
        payload: { eventId: 'stale-branch-event' },
        ledger: FORK_LEDGER,
      }),
    ).resolves.toBeUndefined();
    expect(incSpy).toHaveBeenCalledOnce();
    expect(incSpy).toHaveBeenCalledWith({ outcome: 'suppressed' });

    // A delivery for a ledger that was never rolled back is unaffected.
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      dispatchWebhook({
        url: 'https://8.8.8.8/webhook',
        secret: 'drill-secret',
        event: 'stream.created',
        payload: { eventId: 'unaffected-event' },
        ledger: FORK_LEDGER + 1, // canonical branch, never rolled back
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(incSpy).toHaveBeenCalledOnce(); // no additional suppression
  });
});
