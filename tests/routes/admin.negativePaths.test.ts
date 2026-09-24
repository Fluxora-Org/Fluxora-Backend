import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { initializeConfig } from '../../src/config/env.js';

const ADMIN_KEY = 'test-admin-negative-paths';

type Endpoint = {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  body?: Record<string, unknown>;
};

const protectedEndpoints: Endpoint[] = [
  { method: 'get', path: '/api/admin/deprecations' },
  { method: 'get', path: '/api/admin/status' },
  { method: 'get', path: '/api/admin/pause' },
  { method: 'put', path: '/api/admin/pause', body: { streamCreation: true } },
  { method: 'get', path: '/api/admin/reindex' },
  { method: 'post', path: '/api/admin/reindex' },
  { method: 'post', path: '/api/admin/indexer/stall/clear' },
  { method: 'post', path: '/api/admin/ws/disconnect', body: { stream_id: 'stream-1' } },
  { method: 'post', path: '/api/admin/streams/bulk-actions', body: { batch: [] } },
  { method: 'get', path: '/api/admin/api-keys' },
  { method: 'post', path: '/api/admin/api-keys', body: { name: 'service-a' } },
  { method: 'post', path: '/api/admin/api-keys/key-1/rotate' },
  { method: 'delete', path: '/api/admin/api-keys/key-1' },
  { method: 'get', path: '/api/admin/ban-store/status' },
  { method: 'post', path: '/api/admin/restore', body: { backupId: 'backups/db.sql.gz' } },
  { method: 'get', path: '/api/admin/restore/job-1' },
  { method: 'get', path: '/api/admin/restore' },
  { method: 'get', path: '/api/admin/diagnostics' },
  { method: 'post', path: '/api/admin/rate-limits/overrides/', body: { keyId: 'key-1', maxRequests: 1, windowMs: 1000 } },
  { method: 'get', path: '/api/admin/rate-limits/overrides/' },
  { method: 'get', path: '/api/admin/rate-limits/overrides/override-1' },
  { method: 'delete', path: '/api/admin/rate-limits/overrides/override-1' },
];

function send(endpoint: Endpoint) {
  const req = request(app)[endpoint.method](endpoint.path);
  return endpoint.body === undefined ? req : req.send(endpoint.body);
}

function expectAuthError(body: unknown, status: 401 | 403): void {
  expect(status).toBeGreaterThanOrEqual(401);
  expect(body).toEqual(expect.objectContaining({ error: expect.any(String) }));
  expect(body).not.toHaveProperty('success', true);
}

function expectValidationError(body: unknown, code = 'VALIDATION_ERROR'): void {
  expect(body).toEqual(expect.objectContaining({ success: false }));
  expect(body).toEqual(expect.objectContaining({
    error: expect.objectContaining({
      code,
      message: expect.any(String),
    }),
  }));
}

describe('admin endpoint authorization coverage', () => {
  let previousAdminKey: string | undefined;

  beforeEach(() => {
    previousAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    initializeConfig();
  });

  afterEach(() => {
    if (previousAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = previousAdminKey;
  });

  it.each(protectedEndpoints)('$method $path rejects missing credentials', async (endpoint) => {
    const res = await send(endpoint);
    expect(res.status).toBe(401);
    expectAuthError(res.body, 401);
  });

  it.each(protectedEndpoints)('$method $path rejects insufficient credentials', async (endpoint) => {
    const res = await send(endpoint).set('Authorization', 'Bearer not-the-admin-key');
    expect(res.status).toBe(403);
    expectAuthError(res.body, 403);
  });
});

describe('admin endpoint malformed input and parameter boundaries', () => {
  let previousAdminKey: string | undefined;

  beforeEach(() => {
    previousAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    initializeConfig();
  });

  afterEach(() => {
    if (previousAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = previousAdminKey;
  });

  function authed(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
  }

  it.each([
    {},
    { streamCreation: 'true' },
    { ingestion: 1 },
    { streamCreation: null },
  ])('PUT /api/admin/pause rejects malformed body %#', async (body) => {
    const res = await authed(request(app).put('/api/admin/pause').send(body));
    expect(res.status).toBe(400);
    expectValidationError(res.body);
  });

  it.each([
    {},
    { stream_id: null },
    { stream_id: 42 },
    { stream_id: '   ' },
  ])('POST /api/admin/ws/disconnect rejects malformed stream_id %#', async (body) => {
    const res = await authed(request(app).post('/api/admin/ws/disconnect').send(body));
    expect(res.status).toBe(400);
    expectValidationError(res.body);
  });

  it.each([
    {},
    { batch: [] },
    { batch: [{ streamId: 'stream-1' }] },
    { batch: [{ streamId: '', action: 'pause' }] },
    { batch: [{ streamId: 'stream-1', action: 'delete' }] },
    { batch: Array.from({ length: 501 }, () => ({ streamId: 'stream-1', action: 'pause' })) },
  ])('POST /api/admin/streams/bulk-actions rejects malformed or out-of-range batch %#', async (body) => {
    const res = await authed(request(app).post('/api/admin/streams/bulk-actions').send(body));
    expect(res.status).toBe(400);
    expectValidationError(res.body);
  });

  it.each([
    {},
    { name: null },
    { name: 123 },
    { name: '' },
  ])('POST /api/admin/api-keys rejects malformed name %#', async (body) => {
    const res = await authed(request(app).post('/api/admin/api-keys').send(body));
    expect(res.status).toBe(400);
    expectValidationError(res.body);
  });

  it('POST /api/admin/restore rejects the 1,025-character backupId boundary', async () => {
    const res = await authed(
      request(app).post('/api/admin/restore').send({ backupId: 'a'.repeat(1025) }),
    );
    expect(res.status).toBe(400);
    expectValidationError(res.body);
  });

  it('GET /api/admin/restore/:jobId rejects a jobId beyond its 255-character limit', async () => {
    const res = await authed(request(app).get(`/api/admin/restore/${'j'.repeat(256)}`));
    expect(res.status).toBe(400);
    expectValidationError(res.body);
  });

  it.each([
    {},
    { keyId: '', maxRequests: 1, windowMs: 1000 },
    { keyId: 'key-1', maxRequests: 0, windowMs: 1000 },
    { keyId: 'key-1', maxRequests: 10_000_001, windowMs: 1000 },
    { keyId: 'key-1', maxRequests: 1, windowMs: 999 },
  ])('POST /api/admin/rate-limits/overrides rejects malformed or out-of-range values %#', async (body) => {
    const res = await authed(request(app).post('/api/admin/rate-limits/overrides/').send(body));
    expect(res.status).toBe(400);
    expectValidationError(res.body);
  });

  it.each([
    'x'.repeat(129),
    '',
  ])('rate-limit override endpoints reject invalid id boundary %#', async (id) => {
    const encodedId = encodeURIComponent(id);
    const getRes = await authed(request(app).get(`/api/admin/rate-limits/overrides/${encodedId}`));
    expect(getRes.status).toBe(400);
    expectValidationError(getRes.body);

    const deleteRes = await authed(request(app).delete(`/api/admin/rate-limits/overrides/${encodedId}`));
    expect(deleteRes.status).toBe(400);
    expectValidationError(deleteRes.body);
  });
});