import { describe, it, expect, beforeEach, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { _resetDlq, enqueueDeadLetter } from '../../src/routes/dlq.js';
import { generateToken } from '../../src/lib/auth.js';
import { initializeConfig } from '../../src/config/env.js';

let operatorToken: string;
let viewerToken: string;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'a-very-long-secret-key-for-testing-only-12345';
  initializeConfig();
  operatorToken = generateToken({ address: 'GOPERATOR', role: 'operator' });
  viewerToken = generateToken({ address: 'GVIEWER', role: 'viewer' });
});

describe('admin DLQ routes', () => {
  beforeEach(() => {
    _resetDlq();
  });

  afterEach(() => {
    _resetDlq();
  });

  // 1. Unauthorized Access
  it('rejects unauthenticated GET to DLQ list with 401', async () => {
    const res = await request(app).get('/admin/dlq');
    expect(res.status).toBe(401);
  });

  // 2. Invalid Credentials
  it('rejects GET with viewer role to DLQ list with 403', async () => {
    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  // 3. DLQ List Endpoint
  it('allows authenticated GET to DLQ list with 200 and valid shape', async () => {
    // Seed one entry
    enqueueDeadLetter({
      topic: 'stream.created',
      payload: { id: 'test-stream' },
      error: 'timeout error',
      attempts: 1,
    });

    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('entries');
    expect(Array.isArray(res.body.data.entries)).toBe(true);
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0].topic).toBe('stream.created');
  });

  // 4. Delete Existing DLQ Entry
  it('allows authenticated operator to delete DLQ entry with 200', async () => {
    const entry = enqueueDeadLetter({
      topic: 'stream.created',
      payload: {},
      error: 'some error',
      attempts: 2,
    });

    const res = await request(app)
      .delete(`/admin/dlq/${entry.id}`)
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(entry.id);
  });

  // 5. Delete Non-Existent DLQ Entry
  it('returns 404 when deleting a non-existent DLQ entry', async () => {
    const res = await request(app)
      .delete('/admin/dlq/non-existent-id')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
