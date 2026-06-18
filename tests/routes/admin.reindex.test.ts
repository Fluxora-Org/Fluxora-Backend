import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { _resetForTest } from '../../src/state/adminState.js';

const ADMIN_KEY = 'test-admin-key-for-reindex-routes';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

describe('admin reindex routes', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    _resetForTest();
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  // 1. Unauthorized Request
  it('rejects unauthenticated POST to reindex with 401', async () => {
    const res = await request(app).post('/api/admin/reindex');
    expect(res.status).toBe(401);
  });

  // 2. Forbidden Request
  it('rejects POST to reindex with bad credentials with 403', async () => {
    const res = await request(app)
      .post('/api/admin/reindex')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
  });

  // 3. Successful Reindex Trigger
  it('triggers a reindex operation with 202 when authenticated', async () => {
    const res = await authed(request(app).post('/api/admin/reindex'));
    expect(res.status).toBe(202);
    expect(res.body.message).toBe('Reindex started.');
    expect(res.body.reindex.status).toBe('running');
  });

  // 4. Reindex While Pause Active
  it('allows triggering reindex even when pause flags are active', async () => {
    // Set pause flags first
    await authed(
      request(app)
        .put('/api/admin/pause')
        .send({ streamCreation: true, ingestion: true })
    );

    // Trigger reindex
    const res = await authed(request(app).post('/api/admin/reindex'));
    expect(res.status).toBe(202);
    expect(res.body.reindex.status).toBe('running');
  });
});
