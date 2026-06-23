import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { _resetForTest } from '../../src/state/adminState.js';

const ADMIN_KEY = 'test-admin-key-for-pause-routes';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

describe('admin pause routes', () => {
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

  // 1. Unauthorized request
  it('rejects unauthenticated requests to pause endpoint with 401', async () => {
    const res = await request(app).get('/api/admin/pause');
    expect(res.status).toBe(401);
  });

  // 2. Forbidden request
  it('rejects bad credentials to pause endpoint with 403', async () => {
    const res = await request(app)
      .get('/api/admin/pause')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
  });

  // 3. Successful GET
  it('allows authenticated GET to pause endpoint with 200 envelope', async () => {
    const res = await authed(request(app).get('/api/admin/pause'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.data).toEqual({ streamCreation: false, ingestion: false });
    expect(res.body.meta).toHaveProperty('timestamp');
  });

  it('allows unauthenticated GET to read-only status endpoint with 200 envelope', async () => {
    const res = await request(app).get('/api/admin/status/read-only');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveProperty('pauseFlags');
  });

  // 4. Successful PUT toggle
  it('allows authenticated PUT to toggle streamCreation with 200 envelope', async () => {
    const res = await authed(
      request(app)
        .put('/api/admin/pause')
        .send({ streamCreation: true })
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body.data.pauseFlags.streamCreation).toBe(true);
    expect(res.body.data.pauseFlags.ingestion).toBe(false);
  });
});
