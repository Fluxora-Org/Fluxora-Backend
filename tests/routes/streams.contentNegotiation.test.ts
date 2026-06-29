import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { initializeConfig } from '../../src/config/env.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { requestIdMiddleware } from '../../src/errors.js';

initializeConfig();

const mockFindWithCursor = vi.fn();

vi.mock('../../src/middleware/auth.js', () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  authenticateApiKey: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireScope: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    findWithCursor: (...args: unknown[]) => mockFindWithCursor(...args),
    getById: vi.fn(),
    upsertStream: vi.fn(),
    updateStream: vi.fn(),
    countByStatus: vi.fn().mockResolvedValue({}),
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
}));

import { streamsRouter } from '../../src/routes/streams.js';

function makeApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use('/api/streams', streamsRouter);
  app.use(errorHandler);
  return app;
}

describe('GET /api/streams content negotiation', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
    mockFindWithCursor.mockResolvedValue({ streams: [], hasMore: false });
  });

  it('returns 406 for clients that only accept XML', async () => {
    const res = await request(app).get('/api/streams').set('Accept', 'application/xml').expect(406);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_ACCEPTABLE');
    expect(res.body.error.message).toBe('Accept header must allow application/json');
    expect(JSON.stringify(res.body)).not.toContain('application/xml');
    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });

  it('allows explicit JSON clients', async () => {
    const res = await request(app)
      .get('/api/streams')
      .set('Accept', 'application/json')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.streams).toEqual([]);
    expect(mockFindWithCursor).toHaveBeenCalledTimes(1);
  });

  it('allows wildcard clients', async () => {
    await request(app).get('/api/streams').set('Accept', '*/*').expect(200);

    expect(mockFindWithCursor).toHaveBeenCalledTimes(1);
  });

  it('returns 406 when JSON is explicitly unacceptable', async () => {
    await request(app)
      .get('/api/streams')
      .set('Accept', 'application/json;q=0, application/xml;q=1')
      .expect(406);

    expect(mockFindWithCursor).not.toHaveBeenCalled();
  });
});
