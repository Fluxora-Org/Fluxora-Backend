import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { assessIndexerHealth, clearIndexerStall } from '../../src/indexer/stall.js';

const ADMIN_KEY = 'test-admin-key-for-stall-routes';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

describe('admin stall routes', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    
    // Clear any previous latched state
    assessIndexerHealth({ enabled: false });
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it('rejects unauthenticated POST to clear stall with 401', async () => {
    const res = await request(app).post('/api/admin/indexer/stall/clear');
    expect(res.status).toBe(401);
  });

  it('rejects POST to clear stall with bad credentials with 403', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/stall/clear')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
  });

  it('successfully clears the stall flag and returns 200', async () => {
    // 1. Induce a stall
    assessIndexerHealth({
      enabled: true,
      lastSuccessfulSyncAt: '2026-03-25T20:00:00.000Z',
      now: '2026-03-25T20:06:00.000Z',
      stallThresholdMs: 5 * 60 * 1000,
    });
    let health = assessIndexerHealth({
      enabled: true,
      lastSuccessfulSyncAt: '2026-03-25T20:00:00.000Z',
      now: '2026-03-25T20:02:00.000Z',
      stallThresholdMs: 5 * 60 * 1000,
    });
    expect(health.status).toBe('stalled');

    // 2. Clear via admin endpoint
    const originalNow = Date.now;
    Date.now = () => new Date('2026-03-25T20:02:00.000Z').getTime();
    try {
      const res = await authed(request(app).post('/api/admin/indexer/stall/clear'));
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Indexer stall flag cleared successfully.');
    } finally {
      Date.now = originalNow;
    }

    // 3. Verify it is healthy again
    health = assessIndexerHealth({
      enabled: true,
      lastSuccessfulSyncAt: '2026-03-25T20:00:00.000Z',
      now: '2026-03-25T20:02:00.000Z',
      stallThresholdMs: 5 * 60 * 1000,
    });
    expect(health.status).toBe('healthy');
  });

  it('returns 409 Conflict if the indexer is still actively stalled', async () => {
    // 1. Induce and keep active stall
    const stallInput = {
      enabled: true,
      lastSuccessfulSyncAt: '2026-03-25T20:00:00.000Z',
      now: '2026-03-25T20:06:00.000Z',
      stallThresholdMs: 5 * 60 * 1000,
    };
    assessIndexerHealth(stallInput);

    // 2. Mock Date.now to keep it actively stalled during the API request
    const originalNow = Date.now;
    Date.now = () => new Date('2026-03-25T20:06:00.000Z').getTime();

    try {
      const res = await authed(request(app).post('/api/admin/indexer/stall/clear'));
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Cannot clear stall flag: indexer is still actively stalled.');
    } finally {
      Date.now = originalNow;
    }
  });
});
