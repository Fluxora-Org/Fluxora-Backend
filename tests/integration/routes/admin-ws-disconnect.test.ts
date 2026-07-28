import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  getStreamHub: vi.fn(),
  getPool: vi.fn(() => ({})),
  query: vi.fn().mockResolvedValue({ rowCount: 1 }),
}));

vi.mock('../../../src/ws/hub.js', () => ({
  getStreamHub: (...args: unknown[]) => mocks.getStreamHub(...args),
}));

vi.mock('../../../src/db/pool.js', () => ({
  getPool: (...args: unknown[]) => mocks.getPool(...args),
  query: (...args: unknown[]) => mocks.query(...args),
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor() {
      super('pool exhausted');
      this.name = 'PoolExhaustedError';
    }
  },
  DuplicateEntryError: class DuplicateEntryError extends Error {
    constructor(detail?: string) {
      super(detail ?? 'duplicate');
      this.name = 'DuplicateEntryError';
    }
  },
}));

import { adminRouter } from '../../../src/routes/admin.js';
import { correlationIdMiddleware } from '../../../src/middleware/correlationId.js';
import { errorHandler } from '../../../src/middleware/errorHandler.js';
import { _resetAuditLog } from '../../../src/lib/auditLog.js';

const ADMIN_KEY = 'test-admin-key-for-ws-disconnect-routes';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

function createTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

function createHub(initialCount = 1): { disconnectByStreamId: ReturnType<typeof vi.fn> } {
  const activeStreams = new Map<string, number>([['stream-1', initialCount]]);

  return {
    disconnectByStreamId: vi.fn((streamId: string) => {
      const current = activeStreams.get(streamId) ?? 0;
      if (current === 0) {
        return 0;
      }

      activeStreams.delete(streamId);
      return current;
    }),
  };
}

describe('admin websocket disconnect route', () => {
  let originalKey: string | undefined;
  let app: express.Express;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    app = createTestApp();
    mocks.getStreamHub.mockReset();
    mocks.getPool.mockClear();
    mocks.query.mockClear();
    _resetAuditLog();
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post('/api/admin/ws/disconnect').send({ stream_id: 'stream-1' });
    expect(res.status).toBe(401);
  });

  it('rejects bad credentials with 403', async () => {
    const res = await request(app)
      .post('/api/admin/ws/disconnect')
      .set('Authorization', 'Bearer wrong-key')
      .send({ stream_id: 'stream-1' });

    expect(res.status).toBe(403);
  });

  it('rejects missing stream_id with 400', async () => {
    mocks.getStreamHub.mockReturnValue(createHub());

    const res = await authed(request(app).post('/api/admin/ws/disconnect').send({}));
    expect(res.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('disconnects active subscribers and writes an audit log row', async () => {
    const hub = createHub(2);
    mocks.getStreamHub.mockReturnValue(hub);

    const res = await authed(
      request(app).post('/api/admin/ws/disconnect').send({ stream_id: 'stream-1' })
    );

    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe('stream-1');
    expect(res.body.disconnectedCount).toBe(2);
    expect(hub.disconnectByStreamId).toHaveBeenCalledWith('stream-1');
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0]?.[1]).toContain('INSERT INTO audit_logs');
    expect(mocks.query.mock.calls[0]?.[2]).toEqual(
      expect.arrayContaining([
        expect.any(Number),
        expect.any(String),
        'ADMIN_WS_DISCONNECT',
        'stream',
        'stream-1',
        expect.stringMatching(/^[0-9a-f-]{36}$/),
        expect.stringContaining('disconnectedCount'),
      ])
    );
  });

  it('returns 200 with zero disconnected sockets when no subscribers remain', async () => {
    const hub = createHub(0);
    mocks.getStreamHub.mockReturnValue(hub);

    const res = await authed(
      request(app).post('/api/admin/ws/disconnect').send({ stream_id: 'stream-1' })
    );

    expect(res.status).toBe(200);
    expect(res.body.disconnectedCount).toBe(0);
    expect(hub.disconnectByStreamId).toHaveBeenCalledWith('stream-1');
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('handles concurrent disconnect requests safely', async () => {
    const hub = createHub(1);
    mocks.getStreamHub.mockReturnValue(hub);

    const [first, second] = await Promise.all([
      authed(request(app).post('/api/admin/ws/disconnect').send({ stream_id: 'stream-1' })),
      authed(request(app).post('/api/admin/ws/disconnect').send({ stream_id: 'stream-1' })),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 200]);
    expect([first.body.disconnectedCount, second.body.disconnectedCount].sort()).toEqual([0, 1]);
    expect(hub.disconnectByStreamId).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('returns 503 when the websocket hub has not been initialized', async () => {
    mocks.getStreamHub.mockReturnValue(null);

    const res = await authed(
      request(app).post('/api/admin/ws/disconnect').send({ stream_id: 'stream-1' })
    );

    expect(res.status).toBe(503);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
