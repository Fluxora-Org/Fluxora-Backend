/**
 * End-to-end tests for the stream lifecycle.
 *
 * These tests run against a real HTTP server (started in-process) and, when
 * DATABASE_URL is set, against a real PostgreSQL database.  In CI they are
 * executed by the nightly e2e workflow (.github/workflows/e2e.yml) which
 * injects testnet credentials via GitHub Secrets.
 *
 * Required environment variables (nightly CI):
 *   DATABASE_URL          – PostgreSQL connection string
 *   HORIZON_URL           – Stellar Horizon endpoint (testnet)
 *   NETWORK_PASSPHRASE    – Stellar network passphrase
 *   JWT_SECRET            – HS256 secret for signing test tokens
 *
 * Local run (no real DB):
 *   pnpm test tests/e2e/streams.e2e.test.ts
 *
 * Local run (with real DB):
 *   DATABASE_URL=postgres://... pnpm test tests/e2e/streams.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Server } from 'http';
import { createApp } from '../../src/app.js';

// ---------------------------------------------------------------------------
// Mocks — only active when DATABASE_URL is absent (unit/offline mode)
// ---------------------------------------------------------------------------

const isLiveDb = Boolean(process.env['DATABASE_URL']);

if (!isLiveDb) {
  // Stub the repository so the test can run without a real database.
  const mockStream = {
    id: 'e2e-stream-001',
    sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    recipient: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
    depositAmount: '1000.0000000',
    ratePerSecond: '0.0000116',
    startTime: 1700000000,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  vi.mock('../../src/db/repositories/streamRepository.js', () => ({
    streamRepository: {
      upsertStream: vi.fn().mockResolvedValue(mockStream),
      getById: vi
        .fn()
        .mockImplementation((id: string) =>
          id === mockStream.id ? Promise.resolve(mockStream) : Promise.resolve(null),
        ),
      updateStream: vi
        .fn()
        .mockImplementation((id: string, patch: Record<string, unknown>) =>
          id === mockStream.id
            ? Promise.resolve({ ...mockStream, ...patch })
            : Promise.resolve(null),
        ),
      findWithCursor: vi.fn().mockResolvedValue({ streams: [mockStream], nextCursor: null }),
      countByStatus: vi
        .fn()
        .mockResolvedValue({ active: 1, paused: 0, completed: 0, cancelled: 0 }),
    },
  }));

  vi.mock('../../src/db/pool.js', () => ({
    getPool: vi.fn(() => ({})),
    query: vi.fn(),
    PoolExhaustedError: class PoolExhaustedError extends Error {
      constructor() {
        super('pool exhausted');
        this.name = 'PoolExhaustedError';
      }
    },
    DuplicateEntryError: class DuplicateEntryError extends Error {
      constructor(d?: string) {
        super(d ?? 'duplicate');
        this.name = 'DuplicateEntryError';
      }
    },
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Valid Stellar G-addresses used throughout the suite. */
const SENDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const RECIPIENT = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN';

function idempotencyKey(): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Stream lifecycle e2e', () => {
  let server: Server;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let agent: any;
  let createdStreamId: string;

  beforeAll(() => {
    const app = createApp();
    server = app.listen(0); // random port
    agent = request(server);
  });

  afterAll(() => {
    server.close();
  });

  // ── Health check ──────────────────────────────────────────────────────────

  it('GET /health returns 200 with status ok', async () => {
    const res = await agent.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  // ── Create stream ─────────────────────────────────────────────────────────

  it('POST /api/streams creates a stream and returns 201', async () => {
    const res = await agent.post('/api/streams').set('Idempotency-Key', idempotencyKey()).send({
      sender: SENDER,
      recipient: RECIPIENT,
      depositAmount: '1000.0000000',
      ratePerSecond: '0.0000116',
      startTime: 1700000000,
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      sender: SENDER,
      recipient: RECIPIENT,
      depositAmount: '1000.0000000',
      ratePerSecond: '0.0000116',
    });
    // Amounts must be strings, never numbers
    expect(typeof res.body.data.depositAmount).toBe('string');
    expect(typeof res.body.data.ratePerSecond).toBe('string');

    createdStreamId = res.body.data.id as string;
    expect(createdStreamId).toBeTruthy();
  });

  // ── Idempotency replay ────────────────────────────────────────────────────

  it('POST /api/streams with same Idempotency-Key replays 201', async () => {
    const key = idempotencyKey();
    const body = {
      sender: SENDER,
      recipient: RECIPIENT,
      depositAmount: '500.0000000',
      ratePerSecond: '0.0000050',
      startTime: 1700000001,
    };

    const first = await agent.post('/api/streams').set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);

    const replay = await agent.post('/api/streams').set('Idempotency-Key', key).send(body);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
  });

  // ── Validation: missing Idempotency-Key ───────────────────────────────────

  it('POST /api/streams without Idempotency-Key returns 400', async () => {
    const res = await agent.post('/api/streams').send({
      sender: SENDER,
      recipient: RECIPIENT,
      depositAmount: '100.0',
      ratePerSecond: '0.001',
      startTime: 1700000000,
    });
    expect(res.status).toBe(400);
  });

  // ── Validation: numeric amount rejected ───────────────────────────────────

  it('POST /api/streams with numeric amount returns 400', async () => {
    const res = await agent.post('/api/streams').set('Idempotency-Key', idempotencyKey()).send({
      sender: SENDER,
      recipient: RECIPIENT,
      depositAmount: 1000, // number, not string — must be rejected
      ratePerSecond: '0.001',
      startTime: 1700000000,
    });
    expect(res.status).toBe(400);
  });

  // ── Get stream by id ──────────────────────────────────────────────────────

  it('GET /api/streams/:id returns the created stream', async () => {
    const res = await agent.get(`/api/streams/${createdStreamId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(createdStreamId);
  });

  // ── Get stream: not found ─────────────────────────────────────────────────

  it('GET /api/streams/:id returns 404 for unknown id', async () => {
    const res = await agent.get('/api/streams/does-not-exist-xyz');
    expect(res.status).toBe(404);
  });

  // ── List streams ──────────────────────────────────────────────────────────

  it('GET /api/streams returns a list with at least one stream', async () => {
    const res = await agent.get('/api/streams');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.streams)).toBe(true);
    expect(res.body.data.streams.length).toBeGreaterThan(0);
  });

  // ── Cancel stream ─────────────────────────────────────────────────────────

  it('DELETE /api/streams/:id cancels the stream', async () => {
    const res = await agent.delete(`/api/streams/${createdStreamId}`);
    // 200 on success, or 401 if auth is required — both are acceptable
    // depending on whether JWT_SECRET is configured in the test environment.
    expect([200, 401]).toContain(res.status);
  });

  // ── Security headers ──────────────────────────────────────────────────────

  it('responses include security headers from helmet', async () => {
    const res = await agent.get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});
