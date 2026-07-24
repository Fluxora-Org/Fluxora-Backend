import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { streamRepository } from '../../src/db/repositories/streamRepository.js';
import { _resetForTest } from '../../src/state/adminState.js';
import { _resetAuditLog } from '../../src/lib/auditLog.js';

const ADMIN_KEY = 'test-admin-key-for-routes';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

describe('POST /api/admin/streams/bulk-actions', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    _resetForTest();
    _resetAuditLog();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post('/api/admin/streams/bulk-actions').send({ batch: [] });
    expect(res.status).toBe(401);
  });

  it('validates request payload structure', async () => {
    const res = await authed(
      request(app).post('/api/admin/streams/bulk-actions').send({ batch: [{ action: 'pause' }] }) // missing streamId
    );
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toMatch(/validation/i);
  });

  it('validates max batch size', async () => {
    const batch = Array(501).fill({ streamId: 's', action: 'pause' });
    const res = await authed(
      request(app).post('/api/admin/streams/bulk-actions').send({ batch })
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/validation/i);
  });

  it('applies batch operations and reports partial failures', async () => {
    // Mock the streamRepository.updateStream method
    const mockUpdateStream = vi.spyOn(streamRepository, 'updateStream');
    
    // Setup mock so it succeeds for 'stream-1' and fails for 'stream-2'
    mockUpdateStream.mockImplementation(async (id, input) => {
      if (id === 'stream-2') {
        throw new Error('Stream not found');
      }
      return {} as any;
    });

    const batch = [
      { streamId: 'stream-1', action: 'pause' },
      { streamId: 'stream-2', action: 'cancel' },
      { streamId: 'stream-3', action: 'reindex' },
    ];

    const res = await authed(
      request(app).post('/api/admin/streams/bulk-actions').send({ batch })
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.successCount).toBe(2);
    expect(res.body.data.failureCount).toBe(1);
    
    expect(res.body.data.results).toEqual([
      { streamId: 'stream-1', action: 'pause', status: 'success' },
      { streamId: 'stream-2', action: 'cancel', status: 'failed', error: 'Stream not found' },
      { streamId: 'stream-3', action: 'reindex', status: 'success' },
    ]);

    expect(mockUpdateStream).toHaveBeenCalledWith('stream-1', { status: 'paused' }, expect.any(String));
    expect(mockUpdateStream).toHaveBeenCalledWith('stream-2', { status: 'cancelled' }, expect.any(String));
  });
});
