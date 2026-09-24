/**
 * Integration tests for indexer contract-event routes.
 *
 * Covers HTTP-level concerns that unit/store tests cannot see:
 *  - Guarding against concurrent control operations while another is running (#1549)
 *  - Complete negative paths for every endpoint in src/routes/indexer.ts
 *  - Malformed input handling across all endpoints
 *  - Missing and insufficient authorisation across all endpoints
 *  - Boundary values for each parameter across all endpoints
 *  - Documented response envelope shape compliance across all error conditions
 *  - Ledger-range filter behavior (fromLedger + toledger combinations)
 *  - Cursor/offset pagination metadata (defaults, edge cases, last-page)
 *
 * @see tests/indexer.test.ts — existing coverage for ingestion, basic replay,
 *      store unit tests, and authentication for worker-token routes.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../../src/app.js';
import { InMemoryContractEventStore } from '../../../src/indexer/store.js';
import {
  resetIndexerState,
  setIndexerEventStore,
  setIndexerIngestAuthToken,
  replayLock,
} from '../../../src/routes/indexer.js';
import { indexerService } from '../../../src/indexer/service.js';
import { initializeConfig } from '../../../src/config/env.js';
import { generateToken } from '../../../src/lib/auth.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const INDEXER_TOKEN = 'test-indexer-token';
const CONTRACT_EVENTS_ENDPOINT = '/internal/indexer/contract-events';
const EVENTS_ENDPOINT = '/internal/indexer/events';
const CURSOR_REPLAY_ENDPOINT = '/internal/indexer/events/replay';
const REPLAY_TRIGGER_ENDPOINT = '/internal/indexer/events/replay';
const STATUS_ENDPOINT = '/internal/indexer/status';

// ── Test JWTs (lazy — config initialises when app is imported) ─────────────────

let adminToken: string;
let operatorToken: string;
let viewerToken: string;

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildEvent(eventId: string, ledger = 512345, ledgerHash = `hash-${ledger}`) {
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

function ingestEvents(events: unknown[]) {
  return request(app)
    .post(CONTRACT_EVENTS_ENDPOINT)
    .set('x-indexer-worker-token', INDEXER_TOKEN)
    .send({ events });
}

function postContractEvents(
  body: unknown,
  token: string | null = INDEXER_TOKEN,
  headers: Record<string, string> = {},
) {
  const req = request(app).post(CONTRACT_EVENTS_ENDPOINT);
  if (token !== null) {
    req.set('x-indexer-worker-token', token);
  }
  for (const [k, v] of Object.entries(headers)) {
    req.set(k, v);
  }
  return req.send(body as string | object);
}

function getEvents(query: Record<string, unknown> = {}) {
  return request(app)
    .get(EVENTS_ENDPOINT)
    .set('x-indexer-worker-token', INDEXER_TOKEN)
    .query(query);
}

function getReplay(query: Record<string, unknown> = {}) {
  return request(app)
    .get(CURSOR_REPLAY_ENDPOINT)
    .set('x-indexer-worker-token', INDEXER_TOKEN)
    .query(query);
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeAll(() => {
  initializeConfig();
  adminToken = generateToken({
    address: 'GADMIN',
    role: 'admin',
    permissions: ['indexer:replay'],
  });
  operatorToken = generateToken({
    address: 'GOPERATOR',
    role: 'operator',
  });
  viewerToken = generateToken({
    address: 'GVIEWER',
    role: 'viewer',
    permissions: [],
  });
});

beforeEach(() => {
  resetIndexerState();
  setIndexerIngestAuthToken(INDEXER_TOKEN);
  setIndexerEventStore(new InMemoryContractEventStore());
  vi.spyOn(indexerService, 'replayEvents').mockImplementation(async () => {
    if (replayLock.isHeld()) {
      throw new Error('Replay operation already in progress');
    }
    replayLock.acquire();
  });
});

// ===========================================================================
// POST /internal/indexer/contract-events — Ingestion endpoint
// ===========================================================================

describe('POST /internal/indexer/contract-events — negative paths & boundaries', () => {
  describe('authorization', () => {
    it('rejects missing worker token with 401 and documented error shape', async () => {
      const res = await request(app)
        .post(CONTRACT_EVENTS_ENDPOINT)
        .send({ events: [buildEvent('e1')] })
        .expect(401);

      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Indexer worker authentication is required',
        },
      });
    });

    it('rejects empty worker token with 401', async () => {
      const res = await request(app)
        .post(CONTRACT_EVENTS_ENDPOINT)
        .set('x-indexer-worker-token', '   ')
        .send({ events: [buildEvent('e1')] })
        .expect(401);

      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Indexer worker authentication is required',
        },
      });
    });

    it('rejects wrong worker token with 401', async () => {
      const res = await request(app)
        .post(CONTRACT_EVENTS_ENDPOINT)
        .set('x-indexer-worker-token', 'wrong-worker-token')
        .send({ events: [buildEvent('e1')] })
        .expect(401);

      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Indexer worker authentication failed',
        },
      });
    });
  });

  describe('malformed input', () => {
    it('rejects non-object body with 400', async () => {
      const res = await postContractEvents('plain string').expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects body missing events property with 400', async () => {
      const res = await postContractEvents({}).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects non-array events field with 400', async () => {
      const res = await postContractEvents({ events: 'not-an-array' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects events array containing a non-object with 400', async () => {
      const res = await postContractEvents({ events: ['not-an-object'] }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects event with missing or empty eventId with 400', async () => {
      const res = await postContractEvents({
        events: [{ ...buildEvent('e1'), eventId: '' }],
      }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects event with non-object payload with 400', async () => {
      const res = await postContractEvents({
        events: [{ ...buildEvent('e1'), payload: 'non-object' }],
      }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects event with invalid happenedAt timestamp with 400', async () => {
      const res = await postContractEvents({
        events: [{ ...buildEvent('e1'), happenedAt: 'invalid-iso-date' }],
      }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects intra-batch duplicate eventIds with 409 CONFLICT', async () => {
      const e = buildEvent('dup-event-1');
      const res = await postContractEvents({ events: [e, e] }).expect(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toContain('duplicate eventId');
    });
  });

  describe('boundary values', () => {
    it('rejects empty events array (boundary < 1) with 400', async () => {
      const res = await postContractEvents({ events: [] }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('at least one contract event');
    });

    it('accepts single event batch (minimum valid boundary 1) with 200', async () => {
      const res = await postContractEvents({ events: [buildEvent('single-1')] }).expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.insertedCount).toBe(1);
    });

    it('accepts 100 events batch (maximum valid boundary 100) with 200', async () => {
      const events = Array.from({ length: 100 }, (_, i) => buildEvent(`batch100-${i}`));
      const res = await postContractEvents({ events }).expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.insertedCount).toBe(100);
    });

    it('rejects 101 events batch (boundary > 100) with 400', async () => {
      const events = Array.from({ length: 101 }, (_, i) => buildEvent(`batch101-${i}`));
      const res = await postContractEvents({ events }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('must not contain more than 100 items');
    });

    it('accepts ledger = 0 (minimum non-negative integer boundary) with 200', async () => {
      const res = await postContractEvents({ events: [buildEvent('l0', 0)] }).expect(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects negative ledger = -1 (boundary < 0) with 400', async () => {
      const res = await postContractEvents({ events: [buildEvent('l-neg', -1)] }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects negative txIndex with 400', async () => {
      const res = await postContractEvents({
        events: [{ ...buildEvent('e-neg-tx'), txIndex: -1 }],
      }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects negative operationIndex with 400', async () => {
      const res = await postContractEvents({
        events: [{ ...buildEvent('e-neg-op'), operationIndex: -1 }],
      }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects negative eventIndex with 400', async () => {
      const res = await postContractEvents({
        events: [{ ...buildEvent('e-neg-idx'), eventIndex: -1 }],
      }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects payload exceeding 256 KiB with 413 PAYLOAD_TOO_LARGE', async () => {
      const oversizedPayload = 'x'.repeat(260 * 1024);
      const res = await postContractEvents({
        events: [{ ...buildEvent('oversized'), payload: { oversizedPayload } }],
      }).expect(413);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });
});

// ===========================================================================
// GET /internal/indexer/events — offset-based replay
// ===========================================================================

describe('GET /internal/indexer/events — ledger range, pagination & negative paths', () => {
  describe('authorization', () => {
    it('rejects missing worker token with 401', async () => {
      const res = await request(app).get(EVENTS_ENDPOINT).expect(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects empty worker token with 401', async () => {
      const res = await request(app)
        .get(EVENTS_ENDPOINT)
        .set('x-indexer-worker-token', '')
        .expect(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects wrong worker token with 401', async () => {
      const res = await request(app)
        .get(EVENTS_ENDPOINT)
        .set('x-indexer-worker-token', 'wrong-worker-token')
        .expect(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('ledger-range filtering', () => {
    it('filters by fromLedger and toledger together (bounded range)', async () => {
      await ingestEvents([
        buildEvent('e1', 100),
        buildEvent('e2', 200),
        buildEvent('e3', 300),
        buildEvent('e4', 400),
      ]).expect(200);

      const res = await getEvents({ fromLedger: 200, toledger: 300 }).expect(200);
      expect(res.body.data.events.map((e: { eventId: string }) => e.eventId)).toEqual(['e2', 'e3']);
      expect(res.body.data.total).toBe(2);
    });

    it('returns empty when fromLedger > toledger (empty range)', async () => {
      await ingestEvents([
        buildEvent('e1', 100),
        buildEvent('e2', 200),
      ]).expect(200);

      const res = await getEvents({ fromLedger: 200, toledger: 100 }).expect(200);
      expect(res.body.data.events).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });

    it('returns events for a single ledger when fromLedger equals toledger', async () => {
      await ingestEvents([
        buildEvent('e1', 100),
        buildEvent('e2', 200),
        buildEvent('e3', 200),
      ]).expect(200);

      const res = await getEvents({ fromLedger: 200, toledger: 200 }).expect(200);
      expect(res.body.data.events).toHaveLength(2);
      expect(res.body.data.total).toBe(2);
    });

    it('returns empty when fromLedger exceeds the highest ledger', async () => {
      await ingestEvents([
        buildEvent('e1', 100),
        buildEvent('e2', 200),
      ]).expect(200);

      const res = await getEvents({ fromLedger: 999 }).expect(200);
      expect(res.body.data.events).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });

    it('includes fromLedger boundary (>= semantics)', async () => {
      await ingestEvents([
        buildEvent('e1', 100),
        buildEvent('e2', 200),
      ]).expect(200);

      const res = await getEvents({ fromLedger: 100 }).expect(200);
      expect(res.body.data.events).toHaveLength(2);
    });

    it('includes toledger boundary (<= semantics)', async () => {
      await ingestEvents([
        buildEvent('e1', 100),
        buildEvent('e2', 200),
      ]).expect(200);

      const res = await getEvents({ toledger: 100 }).expect(200);
      expect(res.body.data.events).toHaveLength(1);
      expect(res.body.data.events[0].eventId).toBe('e1');
    });
  });

  describe('pagination metadata & boundaries', () => {
    it('defaults limit to 100 when not specified', async () => {
      const events = Array.from({ length: 50 }, (_, i) => buildEvent(`e${i}`, 100 + i));
      await ingestEvents(events).expect(200);

      const res = await getEvents().expect(200);
      expect(res.body.data.limit).toBe(100);
      expect(res.body.data.offset).toBe(0);
    });

    it('returns offset and limit in the response body', async () => {
      await ingestEvents([
        buildEvent('e1', 100),
        buildEvent('e2', 200),
        buildEvent('e3', 300),
      ]).expect(200);

      const res = await getEvents({ limit: 1, offset: 1 }).expect(200);
      expect(res.body.data.offset).toBe(1);
      expect(res.body.data.limit).toBe(1);
      expect(res.body.data.events).toHaveLength(1);
      expect(res.body.data.events[0].eventId).toBe('e2');
    });

    it('accepts offset = 0 (minimum boundary) with 200', async () => {
      await ingestEvents([buildEvent('e1', 100)]).expect(200);
      const res = await getEvents({ offset: 0 }).expect(200);
      expect(res.body.data.offset).toBe(0);
      expect(res.body.data.events).toHaveLength(1);
    });

    it('accepts limit = 0 (minimum boundary) with 200', async () => {
      await ingestEvents([buildEvent('e1', 100)]).expect(200);
      const res = await getEvents({ limit: 0 }).expect(200);
      expect(res.body.data.limit).toBe(0);
      expect(res.body.data.events).toHaveLength(0);
    });

    it('returns empty events when offset exceeds total count', async () => {
      await ingestEvents([buildEvent('e1', 100)]).expect(200);

      const res = await getEvents({ offset: 100 }).expect(200);
      expect(res.body.data.events).toEqual([]);
      expect(res.body.data.total).toBe(1);
    });

    it('caps limit at 1000', async () => {
      const events = Array.from({ length: 50 }, (_, i) => buildEvent(`e${i}`, 100 + i));
      await ingestEvents(events).expect(200);

      const res = await getEvents({ limit: 9999 }).expect(200);
      expect(res.body.data.limit).toBe(1000);
    });

    it('accepts fromLedger = 0 (minimum non-negative boundary) with 200', async () => {
      await ingestEvents([buildEvent('e0', 0)]).expect(200);
      const res = await getEvents({ fromLedger: 0 }).expect(200);
      expect(res.body.data.events).toHaveLength(1);
    });

    it('accepts toledger = 0 (minimum non-negative boundary) with 200', async () => {
      await ingestEvents([buildEvent('e0', 0)]).expect(200);
      const res = await getEvents({ toledger: 0 }).expect(200);
      expect(res.body.data.events).toHaveLength(1);
    });
  });

  describe('malformed parameter validation', () => {
    it('rejects non-integer fromLedger with 400', async () => {
      const res = await getEvents({ fromLedger: 'abc' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects negative fromLedger with 400', async () => {
      const res = await getEvents({ fromLedger: '-5' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects non-integer toledger with 400', async () => {
      const res = await getEvents({ toledger: 'bad' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects negative toledger with 400', async () => {
      const res = await getEvents({ toledger: '-1' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects non-integer limit with 400', async () => {
      const res = await getEvents({ limit: 'abc' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects negative limit with 400', async () => {
      const res = await getEvents({ limit: '-1' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects non-integer offset with 400', async () => {
      const res = await getEvents({ offset: 'xyz' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects negative offset with 400', async () => {
      const res = await getEvents({ offset: '-1' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

// ===========================================================================
// GET /internal/indexer/events/replay — cursor-based replay
// ===========================================================================

describe('GET /internal/indexer/events/replay — cursor pagination & negative paths', () => {
  describe('authorization', () => {
    it('rejects missing worker token with 401', async () => {
      const res = await request(app).get(CURSOR_REPLAY_ENDPOINT).expect(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects empty worker token with 401', async () => {
      const res = await request(app)
        .get(CURSOR_REPLAY_ENDPOINT)
        .set('x-indexer-worker-token', '')
        .expect(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects wrong worker token with 401', async () => {
      const res = await request(app)
        .get(CURSOR_REPLAY_ENDPOINT)
        .set('x-indexer-worker-token', 'wrong-token')
        .expect(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('pagination metadata & boundaries', () => {
    it('defaults limit to 100 when not specified', async () => {
      const events = Array.from({ length: 50 }, (_, i) => buildEvent(`e${i}`, 100 + i));
      await ingestEvents(events).expect(200);

      const res = await getReplay().expect(200);
      expect(res.body.data.limit).toBe(100);
    });

    it('returns all events when total is within a single page', async () => {
      await ingestEvents([
        buildEvent('e1', 100),
        buildEvent('e2', 200),
      ]).expect(200);

      const res = await getReplay({ limit: 10 }).expect(200);
      expect(res.body.data.events).toHaveLength(2);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.nextCursor).toBeUndefined();
    });

    it('omits nextCursor on the last page', async () => {
      await ingestEvents([
        buildEvent('e1', 100),
        buildEvent('e2', 200),
        buildEvent('e3', 300),
      ]).expect(200);

      const res = await getReplay({ limit: 3 }).expect(200);
      expect(res.body.data.events).toHaveLength(3);
      expect(res.body.data.nextCursor).toBeUndefined();
    });

    it('accepts limit = 0 (boundary) with 200', async () => {
      await ingestEvents([buildEvent('e1', 100)]).expect(200);
      const res = await getReplay({ limit: 0 }).expect(200);
      expect(res.body.data.limit).toBe(0);
      expect(res.body.data.events).toHaveLength(0);
    });

    it('caps limit at 1000', async () => {
      await ingestEvents([buildEvent('e1', 100)]).expect(200);
      const res = await getReplay({ limit: 9999 }).expect(200);
      expect(res.body.data.limit).toBe(1000);
    });

    it('accepts fromLedger = 0 (boundary) with 200', async () => {
      await ingestEvents([buildEvent('e0', 0)]).expect(200);
      const res = await getReplay({ fromLedger: 0 }).expect(200);
      expect(res.body.data.events).toHaveLength(1);
    });

    it('accepts toledger = 0 (boundary) with 200', async () => {
      await ingestEvents([buildEvent('e0', 0)]).expect(200);
      const res = await getReplay({ toledger: 0 }).expect(200);
      expect(res.body.data.events).toHaveLength(1);
    });
  });

  describe('malformed parameter validation', () => {
    it('rejects non-integer fromLedger with 400', async () => {
      const res = await getReplay({ fromLedger: 'invalid' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects negative fromLedger with 400', async () => {
      const res = await getReplay({ fromLedger: '-1' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects non-integer toledger on cursor replay with 400', async () => {
      const res = await getReplay({ toledger: 'bad' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects negative toledger with 400', async () => {
      const res = await getReplay({ toledger: '-2' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects non-integer limit with 400', async () => {
      const res = await getReplay({ limit: 'abc' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects negative limit with 400', async () => {
      const res = await getReplay({ limit: '-1' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('ledger-range combined with cursor', () => {
    it('filters by fromLedger and toledger with afterEventId', async () => {
      await ingestEvents([
        buildEvent('e1', 100),
        buildEvent('e2', 200),
        buildEvent('e3', 300),
        buildEvent('e4', 400),
      ]).expect(200);

      const res = await getReplay({
        afterEventId: 'e1',
        fromLedger: 200,
        toledger: 300,
      }).expect(200);

      expect(res.body.data.events.map((e: { eventId: string }) => e.eventId)).toEqual(['e2', 'e3']);
      expect(res.body.data.total).toBe(2);
    });
  });
});

// ===========================================================================
// POST /internal/indexer/events/replay — JWT + RBAC replay trigger & control guard
// ===========================================================================

describe('POST /internal/indexer/events/replay — auth, validation & concurrency guard', () => {
  describe('authorization', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .send({ contract_id: 'C1', ledger: 1 })
        .expect(401);

      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toBe('Authentication required to access this resource');
    });

    it('rejects non-Bearer scheme Authorization header with 401', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', 'Basic dXNlcjpwYXNz')
        .send({ contract_id: 'C1', ledger: 1 })
        .expect(401);

      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects empty Bearer token with 401', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', 'Bearer ')
        .send({ contract_id: 'C1', ledger: 1 })
        .expect(401);

      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects malformed / invalid JWT with 401', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', 'Bearer invalid.token.payload')
        .send({ contract_id: 'C1', ledger: 1 })
        .expect(401);

      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects requests from operator without INDEXER_REPLAY permission with 403', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ contract_id: 'C1', ledger: 1 })
        .expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toBe('Insufficient permissions to access this resource');
    });

    it('rejects requests from viewer without INDEXER_REPLAY permission with 403', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ contract_id: 'C1', ledger: 1 })
        .expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toBe('Insufficient permissions to access this resource');
    });
  });

  describe('malformed input & validation', () => {
    it('returns 400 for missing required fields (empty object)', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toBeDefined();
    });

    it('returns 400 for missing contract_id', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ledger: 1 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for missing ledger', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for non-string contract_id', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 12345, ledger: 1 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for non-number ledger', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1', ledger: 'one' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for non-number from_block', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1', ledger: 1, from_block: 'abc' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for non-number to_block', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1', ledger: 1, to_block: 'xyz' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('boundary values', () => {
    it('returns 400 for empty contract_id (boundary < min 1)', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: '', ledger: 1 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('accepts single-character contract_id (boundary min 1) with 202', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C', ledger: 1 })
        .expect(202);

      expect(res.body.success).toBe(true);
    });

    it('accepts ledger = 0 (boundary min 0) with 202', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1', ledger: 0 })
        .expect(202);

      expect(res.body.success).toBe(true);
    });

    it('returns 400 for negative ledger = -1 (boundary < 0)', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1', ledger: -1 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('accepts from_block = 0 and to_block = 0 (boundary min 0) with 202', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1', ledger: 1, from_block: 0, to_block: 0 })
        .expect(202);

      expect(res.body.success).toBe(true);
    });

    it('returns 400 for negative from_block = -1 (boundary < 0)', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1', ledger: 1, from_block: -1, to_block: 10 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for negative to_block = -1 (boundary < 0)', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1', ledger: 1, from_block: 0, to_block: -1 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('accepts from_block equal to to_block (boundary ==) with 202', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1', ledger: 1, from_block: 50, to_block: 50 })
        .expect(202);

      expect(res.body.success).toBe(true);
    });

    it('returns 400 when from_block > to_block (boundary >)', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1', ledger: 1, from_block: 200, to_block: 100 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('accepts a valid replay request from admin with 202', async () => {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1', ledger: 1 })
        .expect(202);

      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toBe('Replay started');
      expect(res.body.meta.timestamp).toBeDefined();
    });
  });

  // ── Concurrent control operation guard (#1549) ─────────────────────────────
  describe('concurrent control operation guard (#1549)', () => {
    it('rejects a replay control operation with 409 CONFLICT while another replay is running', async () => {
      // Simulate an active replay operation in progress by acquiring the replay lock
      replayLock.acquire();
      expect(replayLock.isHeld()).toBe(true);

      try {
        const res = await request(app)
          .post(REPLAY_TRIGGER_ENDPOINT)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ contract_id: 'CCONTRACT123', ledger: 100 })
          .expect(409);

        expect(res.body).toEqual({
          success: false,
          error: {
            code: 'CONFLICT',
            message: 'Replay operation already in progress',
            requestId: expect.any(String),
          },
        });
      } finally {
        replayLock.release();
      }
    });

    it('accepts a reindex request after the previously running control operation finishes', async () => {
      replayLock.acquire();
      // While running, rejection is guaranteed
      await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'CCONTRACT123', ledger: 100 })
        .expect(409);

      // Previous operation completes and releases the lock
      replayLock.release();
      expect(replayLock.isHeld()).toBe(false);

      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'CCONTRACT123', ledger: 100 })
        .expect(202);

      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toBe('Replay started');
    });

    it('ensures exactly one request succeeds and the concurrent request is rejected with 409 CONFLICT', async () => {
      // Dispatch two concurrent reindex requests
      const req1 = request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'CCONTRACT123', ledger: 100 });

      const req2 = request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'CCONTRACT123', ledger: 100 });

      const [res1, res2] = await Promise.all([req1, req2]);
      const statuses = [res1.status, res2.status].sort();

      expect(statuses).toEqual([202, 409]);

      const conflictRes = res1.status === 409 ? res1 : res2;
      expect(conflictRes.body).toMatchObject({
        success: false,
        error: {
          code: 'CONFLICT',
          message: 'Replay operation already in progress',
        },
      });
    });
  });
});

// ===========================================================================
// GET /internal/indexer/status — JWT + RBAC replay progress
// ===========================================================================

describe('GET /internal/indexer/status — auth & envelope', () => {
  describe('authorization', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app)
        .get(STATUS_ENDPOINT)
        .expect(401);

      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects non-Bearer scheme Authorization header with 401', async () => {
      const res = await request(app)
        .get(STATUS_ENDPOINT)
        .set('Authorization', 'Basic dXNlcjpwYXNz')
        .expect(401);

      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects empty Bearer token with 401', async () => {
      const res = await request(app)
        .get(STATUS_ENDPOINT)
        .set('Authorization', 'Bearer ')
        .expect(401);

      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects invalid JWT with 401', async () => {
      const res = await request(app)
        .get(STATUS_ENDPOINT)
        .set('Authorization', 'Bearer invalid.jwt.token')
        .expect(401);

      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects requests from operator without INDEXER_REPLAY permission with 403', async () => {
      const res = await request(app)
        .get(STATUS_ENDPOINT)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects requests from viewer without INDEXER_REPLAY permission with 403', async () => {
      const res = await request(app)
        .get(STATUS_ENDPOINT)
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  it('returns progress envelope when authenticated as admin', async () => {
    const res = await request(app)
      .get(STATUS_ENDPOINT)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect((r) => {
        // Accept 200 (DB reachable) or 500 (DB unreachable; e.g. CI without PG)
        expect([200, 500]).toContain(r.status);
      });

    if (res.status === 200) {
      expect(res.body.success).toBe(true);
      expect(res.body.data.isReplaying).toBe(false);
      expect(res.body.meta.timestamp).toBeDefined();
    } else {
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    }
  });
});

// ===========================================================================
// Envelope shape compliance
// ===========================================================================

describe('response envelope shapes', () => {
  it('success response has the standard shape', async () => {
    await ingestEvents([buildEvent('e1', 100)]).expect(200);

    const res = await getEvents({ fromLedger: 100 }).expect(200);

    expect(res.body).toMatchObject({
      success: true,
      data: expect.any(Object),
      meta: {
        timestamp: expect.any(String),
      },
    });
  });

  it('validation error response has the standard shape with details array', async () => {
    const res = await request(app)
      .post(REPLAY_TRIGGER_ENDPOINT)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);

    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.any(String),
      },
    });
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    expect(res.body.error.details[0]).toMatchObject({
      field: expect.any(String),
      message: expect.any(String),
    });
  });

  it('unauthorized error response (worker token) has the standard shape', async () => {
    const res = await request(app)
      .post(CONTRACT_EVENTS_ENDPOINT)
      .send({ events: [buildEvent('e1')] })
      .expect(401);

    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: expect.any(String),
      },
    });
  });

  it('unauthorized error response (JWT auth) has the documented auth error shape', async () => {
    const res = await request(app)
      .post(REPLAY_TRIGGER_ENDPOINT)
      .send({ contract_id: 'C1', ledger: 1 })
      .expect(401);

    expect(res.body.error).toMatchObject({
      code: 'UNAUTHORIZED',
      message: expect.any(String),
    });
  });

  it('forbidden error response has the documented forbidden error shape', async () => {
    const res = await request(app)
      .post(REPLAY_TRIGGER_ENDPOINT)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ contract_id: 'C1', ledger: 1 })
      .expect(403);

    expect(res.body.error).toMatchObject({
      code: 'FORBIDDEN',
      message: expect.any(String),
    });
  });

  it('conflict error response (concurrent replay) has the standard shape', async () => {
    replayLock.acquire();
    try {
      const res = await request(app)
        .post(REPLAY_TRIGGER_ENDPOINT)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contract_id: 'C1', ledger: 1 })
        .expect(409);

      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'CONFLICT',
          message: 'Replay operation already in progress',
          requestId: expect.any(String),
        },
      });
    } finally {
      replayLock.release();
    }
  });

  it('conflict error response (intra-batch duplicate) has the standard shape', async () => {
    const e = buildEvent('dup-env-shape');
    const res = await postContractEvents({ events: [e, e] }).expect(409);

    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'CONFLICT',
        message: expect.any(String),
      },
    });
  });

  it('payload too large error response has the standard shape', async () => {
    const oversizedPayload = 'x'.repeat(260 * 1024);
    const res = await postContractEvents({
      events: [{ ...buildEvent('oversized-shape'), payload: { oversizedPayload } }],
    }).expect(413);

    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: expect.any(String),
      },
    });
  });
});
