/**
 * Failure-path coverage for src/routes/indexer.ts (#1786).
 *
 * Complements tests/integration/routes/indexer-routes.test.ts by pinning down
 * what the routes do when something underneath them goes wrong:
 *
 *  - success path of every route
 *  - invalid input answers with a 4xx envelope, never a 500
 *  - a downstream failure (ingestion, event store, replay progress, lock
 *    provider, audit log) is surfaced as a typed error envelope
 *  - nothing escapes the handlers as an unhandled rejection or a hung request
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../state/adminState.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/adminState.js')>();
  return { ...actual, getReindexLock: vi.fn(() => null) };
});

vi.mock('../lib/auditLog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/auditLog.js')>();
  return { ...actual, recordAuditEvent: vi.fn(actual.recordAuditEvent) };
});

import { app } from '../app.js';
import { generateToken } from '../lib/auth.js';
import { recordAuditEvent } from '../lib/auditLog.js';
import { indexerIngestionService } from '../indexer/ingestion.js';
import { indexerService } from '../indexer/service.js';
import { InMemoryContractEventStore, StaleCursorError } from '../indexer/store.js';
import { getReindexLock } from '../state/adminState.js';
import { AdminStateLockError, type Lock } from '../state/adminStateLock.js';
import {
  replayLock,
  resetIndexerState,
  setIndexerEventStore,
  setIndexerIngestAuthToken,
} from './indexer.js';

const TOKEN = 'unit-test-indexer-token';
const BASE = '/internal/indexer';
const REQUEST_TIMEOUT_MS = 3000;

let adminJwt: string;
let viewerJwt: string;

function event(eventId: string, ledger = 100) {
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
    ledgerHash: `hash-${ledger}`,
  };
}

const worker = (r: request.Test) => r.set('x-indexer-worker-token', TOKEN).timeout(REQUEST_TIMEOUT_MS);
const admin = (r: request.Test) => r.set('Authorization', `Bearer ${adminJwt}`).timeout(REQUEST_TIMEOUT_MS);

function expectErrorEnvelope(body: any, code: string) {
  expect(body.success).toBe(false);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
}

function fakeLock(release: () => Promise<void> = async () => {}): Lock {
  return { release } as unknown as Lock;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeAll(() => {
  adminJwt = generateToken({ address: 'GADMIN', role: 'admin', permissions: ['indexer:replay'] });
  viewerJwt = generateToken({ address: 'GVIEWER', role: 'viewer', permissions: [] });
});

beforeEach(() => {
  resetIndexerState();
  setIndexerIngestAuthToken(TOKEN);
  setIndexerEventStore(new InMemoryContractEventStore());
  vi.mocked(getReindexLock).mockReturnValue(null);
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  // Let any fire-and-forget promise chains settle before asserting on them.
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
  vi.restoreAllMocks();
  replayLock.release();
});

// ── Success paths ─────────────────────────────────────────────────────────────

describe('indexer routes — success paths', () => {
  it('POST /contract-events persists a batch and reports the outcome', async () => {
    const res = await worker(request(app).post(`${BASE}/contract-events`)).send({
      events: [event('evt-1'), event('evt-2', 101)],
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ outcome: 'persisted', insertedCount: 2, duplicateCount: 0 });
    expect(res.body.data.insertedEventIds).toEqual(['evt-1', 'evt-2']);
  });

  it('POST /contract-events reports a redelivered event as a duplicate', async () => {
    const send = () => worker(request(app).post(`${BASE}/contract-events`)).send({ events: [event('evt-1')] });
    await send();
    const res = await send();

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ insertedCount: 0, duplicateCount: 1 });
  });

  it('GET /events returns ingested events with pagination metadata', async () => {
    await worker(request(app).post(`${BASE}/contract-events`)).send({ events: [event('evt-1'), event('evt-2', 101)] });
    const res = await worker(request(app).get(`${BASE}/events`).query({ limit: 1, offset: 1 }));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.events).toHaveLength(1);
  });

  it('GET /events/replay returns events after a known cursor', async () => {
    await worker(request(app).post(`${BASE}/contract-events`)).send({ events: [event('evt-1'), event('evt-2', 101)] });
    const res = await worker(request(app).get(`${BASE}/events/replay`).query({ afterEventId: 'evt-1' }));

    expect(res.status).toBe(200);
    expect(res.body.data.events.map((e: any) => e.eventId)).toEqual(['evt-2']);
  });

  it('GET /events/replay treats a stale cursor as past the end of the store', async () => {
    vi.spyOn(indexerIngestionService, 'getEvents').mockRejectedValue(new StaleCursorError('gone'));
    const res = await worker(request(app).get(`${BASE}/events/replay`).query({ afterEventId: 'gone', limit: 5 }));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ events: [], total: 0, limit: 5, offset: 0 });
  });

  it('POST /events/replay accepts a replay and starts it in the background', async () => {
    const replay = vi.spyOn(indexerService, 'replayEvents').mockResolvedValue(undefined as never);
    const res = await admin(request(app).post(`${BASE}/events/replay`)).send({ contract_id: 'CABC', ledger: 10 });

    expect(res.status).toBe(202);
    expect(res.body.data.message).toBe('Replay started');
    expect(replay).toHaveBeenCalledWith(expect.objectContaining({ contract_id: 'CABC', ledger: 10 }));
    expect(recordAuditEvent).toHaveBeenCalledWith(
      'REINDEX_TRIGGERED', 'indexer', 'admin', expect.anything(), expect.objectContaining({ contract_id: 'CABC' }),
    );
  });

  it('GET /status returns the replay progress snapshot', async () => {
    vi.spyOn(indexerService, 'getReplayProgressExtended').mockResolvedValue(indexerService.getReplayProgress());
    const res = await admin(request(app).get(`${BASE}/status`));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isReplaying).toBe(false);
  });
});

// ── Invalid input → client error, never a 500 ─────────────────────────────────

describe('indexer routes — invalid input is a client error', () => {
  it.each([
    ['missing token', undefined],
    ['blank token', '   '],
    ['wrong token', 'not-the-token'],
  ])('worker routes answer 401 for a %s', async (_label, token) => {
    for (const path of ['/events', '/events/replay']) {
      const req = request(app).get(`${BASE}${path}`).timeout(REQUEST_TIMEOUT_MS);
      const res = await (token === undefined ? req : req.set('x-indexer-worker-token', token));
      expect(res.status).toBe(401);
      expectErrorEnvelope(res.body, 'UNAUTHORIZED');
    }
    const post = request(app).post(`${BASE}/contract-events`).timeout(REQUEST_TIMEOUT_MS);
    const res = await (token === undefined ? post : post.set('x-indexer-worker-token', token)).send({ events: [] });
    expect(res.status).toBe(401);
  });

  it.each([
    ['fromLedger', 'abc'],
    ['fromLedger', '-1'],
    ['fromLedger', '1.5'],
    ['toledger', 'x'],
    ['limit', '-5'],
    ['offset', 'NaN'],
  ])('GET /events rejects %s=%s with 400', async (name, value) => {
    const res = await worker(request(app).get(`${BASE}/events`).query({ [name]: value }));
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
  });

  it('GET /events/replay rejects a malformed limit with 400', async () => {
    const res = await worker(request(app).get(`${BASE}/events/replay`).query({ limit: 'many' }));
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
  });

  it.each([
    ['a body that is not an object', 'just text'],
    ['a missing events array', {}],
    ['an empty events array', { events: [] }],
    ['events that are not an array', { events: 'nope' }],
    ['an event that is not an object', { events: [42] }],
  ])('POST /contract-events rejects %s with 400', async (_label, body) => {
    const res = await worker(request(app).post(`${BASE}/contract-events`)).send(body as any);
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
  });

  it('POST /contract-events rejects an oversized declared body with 413', async () => {
    const res = await worker(request(app).post(`${BASE}/contract-events`))
      .set('content-length', String(256 * 1024 + 1))
      .send({ events: [event('evt-1')] });
    expect(res.status).toBe(413);
    expectErrorEnvelope(res.body, 'PAYLOAD_TOO_LARGE');
  });

  it('POST /events/replay rejects an invalid body with 400 and does not start a replay', async () => {
    const replay = vi.spyOn(indexerService, 'replayEvents');
    const res = await admin(request(app).post(`${BASE}/events/replay`)).send({ ledger: 'ten' });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    expect(replay).not.toHaveBeenCalled();
  });

  it('POST /events/replay rejects from_block > to_block with 400', async () => {
    const res = await admin(request(app).post(`${BASE}/events/replay`)).send({
      contract_id: 'CABC', ledger: 10, from_block: 50, to_block: 40,
    });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
  });

  it('POST /events/replay answers 409 while another replay holds the lock', async () => {
    replayLock.acquire();
    const res = await admin(request(app).post(`${BASE}/events/replay`)).send({ contract_id: 'CABC', ledger: 10 });
    expect(res.status).toBe(409);
    expectErrorEnvelope(res.body, 'CONFLICT');
  });

  it('JWT routes answer 401 without a token and 403 without the replay permission', async () => {
    const anon = await request(app).get(`${BASE}/status`).timeout(REQUEST_TIMEOUT_MS);
    expect(anon.status).toBe(401);

    const viewer = await request(app).get(`${BASE}/status`).set('Authorization', `Bearer ${viewerJwt}`).timeout(REQUEST_TIMEOUT_MS);
    expect(viewer.status).toBe(403);
    expectErrorEnvelope(viewer.body, 'FORBIDDEN');
  });
});

// ── Downstream failures → typed error ─────────────────────────────────────────

describe('indexer routes — downstream failures surface as typed errors', () => {
  it('POST /contract-events turns an ingestion failure into a 500 INTERNAL_ERROR envelope', async () => {
    vi.spyOn(indexerIngestionService, 'ingest').mockRejectedValue(new Error('db connection lost: secret-host'));
    const res = await worker(request(app).post(`${BASE}/contract-events`)).send({ events: [event('evt-1')] });

    expect(res.status).toBe(500);
    expectErrorEnvelope(res.body, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('secret-host');
  });

  it.each(['/events', '/events/replay'])('GET %s turns an event-store failure into a 500 envelope', async (path) => {
    vi.spyOn(indexerIngestionService, 'getEvents').mockRejectedValue(new Error('store offline'));
    const res = await worker(request(app).get(`${BASE}${path}`));

    expect(res.status).toBe(500);
    expectErrorEnvelope(res.body, 'INTERNAL_ERROR');
  });

  it('GET /status turns a progress lookup failure into a 500 INTERNAL_ERROR envelope', async () => {
    vi.spyOn(indexerService, 'getReplayProgressExtended').mockRejectedValue(new Error('pg down'));
    const res = await admin(request(app).get(`${BASE}/status`));

    expect(res.status).toBe(500);
    expectErrorEnvelope(res.body, 'INTERNAL_ERROR');
    expect(res.body.error.message).toBe('Failed to get indexer status');
  });

  it('POST /events/replay answers 409 when the reindex lock is already taken', async () => {
    vi.mocked(getReindexLock).mockReturnValue({
      acquire: vi.fn().mockRejectedValue(new AdminStateLockError('busy')),
    } as never);
    const replay = vi.spyOn(indexerService, 'replayEvents');

    const res = await admin(request(app).post(`${BASE}/events/replay`)).send({ contract_id: 'CABC', ledger: 10 });

    expect(res.status).toBe(409);
    expectErrorEnvelope(res.body, 'CONFLICT');
    expect(replay).not.toHaveBeenCalled();
  });

  it('POST /events/replay turns an unexpected lock provider failure into a typed 500, not a hung request', async () => {
    vi.mocked(getReindexLock).mockReturnValue({
      acquire: vi.fn().mockRejectedValue(new Error('redis ECONNRESET')),
    } as never);
    const replay = vi.spyOn(indexerService, 'replayEvents');

    const res = await admin(request(app).post(`${BASE}/events/replay`)).send({ contract_id: 'CABC', ledger: 10 });

    expect(res.status).toBe(500);
    expectErrorEnvelope(res.body, 'INTERNAL_ERROR');
    expect(replay).not.toHaveBeenCalled();
  });

  it('POST /events/replay releases the reindex lock and answers 500 if the audit log throws', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getReindexLock).mockReturnValue({ acquire: vi.fn().mockResolvedValue(fakeLock(release)) } as never);
    vi.mocked(recordAuditEvent).mockImplementationOnce(() => {
      throw new Error('audit sink down');
    });
    const replay = vi.spyOn(indexerService, 'replayEvents');

    const res = await admin(request(app).post(`${BASE}/events/replay`)).send({ contract_id: 'CABC', ledger: 10 });

    expect(res.status).toBe(500);
    expectErrorEnvelope(res.body, 'INTERNAL_ERROR');
    expect(release).toHaveBeenCalledTimes(1);
    expect(replay).not.toHaveBeenCalled();
  });

  it('POST /events/replay still answers 202 when the background replay later fails, and releases the lock', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getReindexLock).mockReturnValue({ acquire: vi.fn().mockResolvedValue(fakeLock(release)) } as never);
    vi.spyOn(indexerService, 'replayEvents').mockRejectedValue(new Error('rpc timeout'));

    const res = await admin(request(app).post(`${BASE}/events/replay`)).send({ contract_id: 'CABC', ledger: 10 });
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    // afterEach asserts that no unhandled rejection escaped the failed replay.
  });

  it('swallows a failing lock release after a replay finishes', async () => {
    const release = vi.fn().mockRejectedValue(new Error('release failed'));
    vi.mocked(getReindexLock).mockReturnValue({ acquire: vi.fn().mockResolvedValue(fakeLock(release)) } as never);
    vi.spyOn(indexerService, 'replayEvents').mockResolvedValue(undefined as never);

    const res = await admin(request(app).post(`${BASE}/events/replay`)).send({ contract_id: 'CABC', ledger: 10 });
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });
});
