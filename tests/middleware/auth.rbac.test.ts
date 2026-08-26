/**
 * RBAC / scope permission middleware integration tests.
 *
 * These tests verify that the permission/scope enforcement layer (requirePermission,
 * requireScope) correctly gates requests based on JWT roles or API key scopes.
 *
 * DB layers are mocked so no live database is required.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { vi, describe, it, expect, beforeAll } from 'vitest';

// ── Module-scope mocks (must be hoisted by Vitest) ───────────────────────────
// The DLQ route calls the real dlqRepository, which needs a live DB.
// Mock it so the route can return 200 when auth passes.
vi.mock('../../src/db/repositories/dlqRepository.js', () => ({
  dlqRepository: {
    findAll: vi.fn(async () => ({ entries: [], total: 0 })),
    listSuspendedConsumers: vi.fn(async () => []),
    findById: vi.fn(async () => undefined),
    insert: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    replay: vi.fn(async () => {}),
    getConsumerSuspension: vi.fn(async () => undefined),
    recordReplaySuccess: vi.fn(async () => {}),
    recordReplayFailure: vi.fn(async () => {}),
    resumeConsumer: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/db/repositories/streamRepository.js', () => ({ streamRepository: {} }));

vi.mock('../../src/db/repositories/auditRepository.js', () => ({
  auditRepository: {
    findAll: vi.fn(async () => ({ items: [], total: 0, cursor: null })),
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────
import { app } from '../../src/app.js';
import { generateToken } from '../../src/lib/auth.js';
import { getConfig, initializeConfig } from '../../src/config/env.js';

// ── Test suite ────────────────────────────────────────────────────────────────

describe('RBAC Permission Middleware', () => {
  const address = 'GCSXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUV';

  beforeAll(() => {
    // Config must be initialised before generateToken/verifyToken is called.
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'a-very-long-secret-key-for-testing-only-12345';
    initializeConfig();
  });

  it('allows operator (has DLQ_LIST) to access DLQ list', async () => {
    const token = generateToken({ address, role: 'operator' });
    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${token}`);

    // Auth + RBAC allow the request through; the mocked route returns 200.
    expect(res.status).toBe(200);
  });

  it('denies viewer (no DLQ_LIST) from accessing DLQ list', async () => {
    const token = generateToken({ address, role: 'viewer' });
    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('rejects token missing permissions claim during authentication', async () => {
    const { jwtSecret } = getConfig();
    // Sign a token without the `permissions` array — the Zod schema rejects it.
    const raw = jwt.sign({ address, role: 'viewer' } as any, jwtSecret);
    const res = await request(app)
      .get('/api/audit')
      .set('Authorization', `Bearer ${raw}`);

    expect(res.status).toBe(401);
  });
});

describe('Scope Permission Middleware (requireScope)', () => {
  it('returns 401 if authentication is missing entirely', async () => {
    const res = await request(app)
      .get('/api/streams')
      .query({ limit: 10 });

    // requireScope returns 401 when neither JWT user nor API key is present.
    expect(res.status).toBe(401);
  });
});
