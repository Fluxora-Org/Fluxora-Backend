/**
 * Integration tests for indexer contract-event routes.
 *
 * Covers HTTP-level concerns that unit/store tests cannot see:
 *  - Ledger-range filter behavior (fromLedger + toledger combinations)
 *  - Cursor/offset pagination metadata (defaults, edge cases, last-page)
 *  - Invalid parameter handling (silently ignored per current lenient parsing)
 *  - Auth / RBAC on JWT-protected routes (POST /events/replay, GET /status)
 *  - Success/error envelope shape compliance
 *
 * @see tests/indexer.test.ts — existing coverage for ingestion, basic replay,
 *      store unit tests, and authentication for worker-token routes.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../../src/app.js';
import { InMemoryContractEventStore } from '../../../src/indexer/store.js';
import {
  resetIndexerState,
  setIndexerEventStore,
  setIndexerIngestAuthToken,
} from '../../../src/routes/indexer.js';
import { initializeConfig } from '../../../src/config/env.js';
import { generateToken } from '../../../src/lib/auth.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const INDEXER_TOKEN = 'test-indexer-token';
const EVENTS_ENDPOINT = '/internal/indexer/events';
const CURSOR_REPLAY_ENDPOINT = '/internal/indexer/events/replay';
const REPLAY_TRIGGER_ENDPOINT = '/internal/indexer/events/replay';
const STATUS_ENDPOINT = '/internal/indexer/status';

// ── Test JWTs (lazy — config initialises when app is imported) ─────────────────

let adminToken: string;
let operatorToken: string;

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
    .post('/internal/indexer/contract-events')
    .set('x-indexer-worker-token', INDEXER_TOKEN)
    .send({ events });
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
});

beforeEach(() => {
  resetIndexerState();
  setIndexerIngestAuthToken(INDEXER_TOKEN);
  setIndexerEventStore(new InMemoryContractEventStore());
});

// ===========================================================================
// GET /internal/indexer/events — offset-based replay
// ===========================================================================

describe('GET /internal/indexer/events — ledger range & pagination', () => {
  describe('ledger-range filtering', () => {
    it('filters by fromLedger and toledger together (bounded range)', async () => {
      await ingestEvents([
        buildEvent('e1', 100),
        buildEvent('e2', 200),
        buildEvent('e3', 300),
        buildEvent('e4', 400),
      ]).expect(200);

      const res = await getEvents({ fromLedger: 200, toledger: 300 }).expect(200);
      expect(res.body.data.events.map((e: any) => e.eventId)).toEqual(['e2', 'e3']);
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

  describe('pagination metadata', () => {
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
  });

  describe('invalid parameter validation', () => {
    /**
     * parseIntParam now throws a VALIDATION_ERROR for non-integer or
     * negative values, so the errorHandler returns 400 with the standard
     * error envelope.
     */
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

    it('rejects non-integer toledger on cursor replay with 400', async () => {
      const res = await getReplay({ toledger: 'bad' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

// ===========================================================================
// GET /internal/indexer/events/replay — cursor-based replay
// ===========================================================================

describe('GET /internal/indexer/events/replay — cursor pagination', () => {
  describe('pagination metadata', () => {
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

      expect(res.body.data.events.map((e: any) => e.eventId)).toEqual(['e2', 'e3']);
      expect(res.body.data.total).toBe(2);
    });
  });
});

// ===========================================================================
// POST /internal/indexer/events/replay — JWT + RBAC replay trigger
// ===========================================================================

describe('POST /internal/indexer/events/replay — auth & validation', () => {
  /**
   * Auth middleware (requireAuth / requirePermission) returns envelopes without
   * a `success` field: `{ error: { code, message, requestId } }`.
   */
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .post(REPLAY_TRIGGER_ENDPOINT)
      .send({ contract_id: 'C1', ledger: 1 })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Authentication required to access this resource');
  });

  it('rejects requests without INDEXER_REPLAY permission with 403', async () => {
    const res = await request(app)
      .post(REPLAY_TRIGGER_ENDPOINT)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ contract_id: 'C1', ledger: 1 })
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Insufficient permissions to access this resource');
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

  it('accepts request with optional from_block and to_block', async () => {
    const res = await request(app)
      .post(REPLAY_TRIGGER_ENDPOINT)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ contract_id: 'C1', ledger: 1, from_block: 0, to_block: 100 })
      .expect(202);

    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toBe('Replay started');
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request(app)
      .post(REPLAY_TRIGGER_ENDPOINT)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toBeDefined();
  });

  it('returns 400 for empty contract_id', async () => {
    const res = await request(app)
      .post(REPLAY_TRIGGER_ENDPOINT)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ contract_id: '', ledger: 1 })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for negative ledger', async () => {
    const res = await request(app)
      .post(REPLAY_TRIGGER_ENDPOINT)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ contract_id: 'C1', ledger: -1 })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when from_block > to_block', async () => {
    const res = await request(app)
      .post(REPLAY_TRIGGER_ENDPOINT)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ contract_id: 'C1', ledger: 1, from_block: 200, to_block: 100 })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ===========================================================================
// GET /internal/indexer/status — JWT + RBAC replay progress
// ===========================================================================

describe('GET /internal/indexer/status — auth & envelope', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .get(STATUS_ENDPOINT)
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests without INDEXER_REPLAY permission with 403', async () => {
    const res = await request(app)
      .get(STATUS_ENDPOINT)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
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

  /**
   * Route-level error responses (via errorResponse helper) include `success: false`.
   * Auth-middleware errors omit `success` — this test uses the body-validation path
   * which is a route-level response.
   */
  it('error response has the standard shape', async () => {
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
  });

  it('validation error includes details array', async () => {
    const res = await request(app)
      .post(REPLAY_TRIGGER_ENDPOINT)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    expect(res.body.error.details[0]).toMatchObject({
      field: expect.any(String),
      message: expect.any(String),
    });
  });
});
