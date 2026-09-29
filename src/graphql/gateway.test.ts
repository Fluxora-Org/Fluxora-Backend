// src/graphql/gateway.test.ts
//
// #1422 — Alias repetition is not counted by the GraphQL complexity score.
//
// The gateway enforces MAX_QUERY_DEPTH and MAX_QUERY_COMPLEXITY before
// executing any query. Neither metric previously reacted to aliases: requesting
// the same expensive field under many aliases kept depth constant and the
// complexity score constant while executed work grew linearly. These tests pin
// the alias-aware scoring added by #1422.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'graphql';
import express, { type Express } from 'express';
import request from 'supertest';

import {
  computeQueryComplexity,
  computeQueryDepth,
  MAX_QUERY_COMPLEXITY,
  MAX_ALIAS_REPEATS,
  ALIAS_COMPLEXITY_COST,
  graphqlGatewayRouter,
} from './gateway.js';
import * as flagModule from '../config/featureFlags.js';
import { streamRepository } from '../db/repositories/streamRepository.js';

vi.mock('../db/repositories/streamRepository.js', () => ({
  streamRepository: {
    getById: vi.fn(async () => null),
    findWithCursor: vi.fn(async () => ({ streams: [], hasMore: false, total: 0 })),
  },
}));

vi.mock('../lib/auditLog.js', () => ({
  getAuditEntries: vi.fn(() => []),
}));

vi.mock('../lib/apiKey.js', () => ({
  getApiKeyFromRequest: vi.fn(() => null),
  findRecordByRawKey: vi.fn(async () => null),
}));

vi.mock('../redis/jwtRevocationStore.js', () => ({
  isRevoked: vi.fn(async () => false),
}));

// ── Complexity scorer (unit) ──────────────────────────────────────────────────

describe('computeQueryComplexity — alias repetition (#1422)', () => {
  it('charges no surcharge for the first aliased use of a field', () => {
    const doc = parse('{ a: stream(id: "s1") { id } }');
    // 2 selections (stream + id), no repeat surcharge.
    expect(computeQueryComplexity(doc)).toBe(2);
  });

  it('grows linearly as the same field is aliased more times', () => {
    const build = (n: number) =>
      parse(`{ ${Array.from({ length: n }, (_, i) => `f${i}: streams { streams { id } }`).join(' ')} }`);

    const one = computeQueryComplexity(build(1));
    const two = computeQueryComplexity(build(2));
    const five = computeQueryComplexity(build(5));

    // n aliases of `streams` (3 selections each) → 3n + (n−1)·ALIAS_COMPLEXITY_COST.
    const cost = (n: number) => 3 * n + (n - 1) * ALIAS_COMPLEXITY_COST;
    expect(one).toBe(cost(1));
    expect(two).toBe(cost(2));
    expect(five).toBe(cost(5));
    expect(two).toBeGreaterThan(one);
    expect(five).toBeGreaterThan(two);
  });

  it('charges the surcharge per repeat even when interleaved with distinct fields', () => {
    const doc = parse('{ a: stream(id: "1") { id } b: stream(id: "2") { id } other { id } }');
    // 6 selections + 1 aliased repeat of `stream` (b) × ALIAS_COMPLEXITY_COST.
    expect(computeQueryComplexity(doc)).toBe(6 + ALIAS_COMPLEXITY_COST);
  });

  it('does not charge the surcharge for repeated unaliased fields', () => {
    const doc = parse('{ streams { streams { id } } streams { streams { id } } }');
    // Same field selected twice without aliases: the executor merges response
    // keys, so there is no repeated resolver work — cost is just the selections.
    expect(computeQueryComplexity(doc)).toBe(6);
  });

  it('counts aliases inside fragments via the same document-wide ledger', () => {
    const doc = parse(`
      query {
        a: streams { streams { id } }
        ...F
      }
      fragment F on Query {
        b: streams { streams { id } }
      }
    `);
    // 6 selections + 1 aliased repeat of `streams` (second use, in the fragment).
    expect(computeQueryComplexity(doc)).toBe(6 + ALIAS_COMPLEXITY_COST);
  });

  it('pushes an alias-spam document over MAX_QUERY_COMPLEXITY', () => {
    const spam = parse(
      `{ ${Array.from(
        { length: MAX_ALIAS_REPEATS + 3 },
        (_, i) => `f${i}: streams { streams { id } }`
      ).join(' ')} }`
    );
    expect(computeQueryComplexity(spam)).toBeGreaterThan(MAX_QUERY_COMPLEXITY);
  });

  it('keeps depth scoring independent of alias count', () => {
    const single = parse('{ a: streams { streams { id } } }');
    const spammed = parse(
      `{ ${Array.from({ length: 12 }, (_, i) => `f${i}: streams { streams { id } }`).join(' ')} }`
    );
    expect(computeQueryDepth(single)).toBe(computeQueryDepth(spammed));
  });
});

// ── Gateway route (integration, repositories mocked) ──────────────────────────

/**
 * The gateway route is registered in app.ts behind the feature flag; the full
 * app wiring (rate limiter, Redis-backed stores, …) is not needed to exercise
 * the query-validation pipeline, so build a minimal Express app around the
 * router. A JWT-shaped principal with full scopes is injected so `requireScope`
 * passes and the request reaches validation.
 */
function buildGatewayApp(): Express {
  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = {
      address: 'GTESTADDRESS0000000000000000000000000000000000000000000000000000',
      role: 'admin',
      permissions: ['streams:read', 'streams:write', 'audit:read'],
    };
    (req as unknown as { id: string }).id = 'test-request';
    next();
  });
  app.use('/api/graphql', graphqlGatewayRouter);
  return app;
}

describe('POST /api/graphql — alias-spam refusal before execution (#1422)', () => {
  const app = buildGatewayApp();
  const requesterAddress = 'GTESTADDRESS0000000000000000000000000000000000000000000000000000';

  beforeAll(() => {
    // Feature flag: enable the gateway for this test's requester only.
    vi.spyOn(flagModule, 'isEnabled').mockImplementation(
      (_flag: string, requesterId: string) => requesterId === `address:${requesterAddress}`
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('refuses a query that aliases one expensive field beyond the budget', async () => {
    const aliases = Array.from(
      { length: MAX_ALIAS_REPEATS + 3 },
      (_, i) => `f${i}: streams { streams { id } }`
    ).join(' ');
    const res = await request(app).post('/api/graphql').send({ query: `{ ${aliases} }` });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
    // Rejected before execution — no resolver ran.
    expect(streamRepository.findWithCursor).not.toHaveBeenCalled();
  });

  it('executes an equivalent single-alias query within the documented budget', async () => {
    const res = await request(app)
      .post('/api/graphql')
      .send({ query: '{ a: streams { streams { id } } }' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    // Response mirrors the requested selections (only `streams { id }`).
    expect(res.body.data.a).toEqual({ streams: [] });
    expect(streamRepository.findWithCursor).toHaveBeenCalled();
  });

  it('pins the documented budget constants', () => {
    expect(MAX_QUERY_COMPLEXITY).toBe(15);
    expect(ALIAS_COMPLEXITY_COST).toBe(2);
    expect(MAX_ALIAS_REPEATS).toBe(7);
  });
});
