import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { streamRepository } from '../../src/db/repositories/streamRepository.js';
import { _resetForTest, _setReindexRunnerForTest } from '../../src/state/adminState.js';
import { timedReindexRunner } from '../helpers/fakeReindexRunner.js';
import { _resetAuditLog } from '../../src/lib/auditLog.js';
import { generateToken } from '../../src/lib/auth.js';

const ADMIN_KEY = 'test-admin-key-for-routes';

/**
 * `/api/admin` sits behind protectRouter's JWT `authenticate` step, which runs
 * before `requireAdminAuth`, so requests authenticate with an admin JWT.
 */
function authed(req: request.Test): request.Test {
  const token = generateToken({ address: 'addr-admin', role: 'admin' });
  return req.set('Authorization', `Bearer ${token}`);
}

describe('POST /api/admin/streams/bulk-actions', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    _resetForTest();
    _resetAuditLog();
    vi.restoreAllMocks();
    _setReindexRunnerForTest(timedReindexRunner());
  });

  afterEach(() => {
    _setReindexRunnerForTest(null);
    _resetForTest();
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
    // stream-3's contract is looked up so its events can be replayed.
    vi.spyOn(streamRepository, 'getById').mockImplementation(async (id) =>
      id === 'stream-3' ? ({ id, contract_id: 'CSTREAM3' } as any) : undefined,
    );

    const batch = [
      { streamId: 'stream-1', action: 'pause' },
      { streamId: 'stream-2', action: 'cancel' },
      { streamId: 'stream-3', action: 'reindex', ledger: 4 },
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

  it('requires a ledger for reindex items', async () => {
    const res = await authed(
      request(app)
        .post('/api/admin/streams/bulk-actions')
        .send({ batch: [{ streamId: 'stream-3', action: 'reindex' }] })
    );
    expect(res.status).toBe(400);
  });

  it('reports a reindex item as failed when its stream does not exist', async () => {
    vi.spyOn(streamRepository, 'getById').mockResolvedValue(undefined);
    const res = await authed(
      request(app)
        .post('/api/admin/streams/bulk-actions')
        .send({ batch: [{ streamId: 'ghost', action: 'reindex', ledger: 1 }] })
    );
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      { streamId: 'ghost', action: 'reindex', status: 'failed', error: 'Stream ghost not found' },
    ]);
  });
});
