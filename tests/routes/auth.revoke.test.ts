import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRevoke = vi.fn();

vi.mock('../../src/redis/jwtRevocationStore.js', () => ({
  revoke: mockRevoke,
}));

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/middleware/auth.js')>(
    '../../src/middleware/auth.js',
  );

  return {
    ...actual,
    requirePermission: () => (req: Request, _res: Response, next: NextFunction) => {
      req.user = { address: 'GADMIN', permissions: [actual.Permission.ADMIN_PAUSE] };
      next();
    },
  };
});

vi.mock('../../src/utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

const { authRouter } = await import('../../src/routes/auth.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const error = err as { status?: number; statusCode?: number; code?: string; message?: string; details?: unknown };
    res.status(error.status ?? error.statusCode ?? 500).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  });
  return app;
}

describe('POST /api/auth/revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevoke.mockResolvedValue({ revoked: true, ttlSeconds: 3600 });
  });

  it('passes jti, exp, and caller ttl to the revocation store', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/auth/revoke')
      .send({
        jti: 'jti-route',
        exp: 1_700_003_600,
        ttl: 60,
      })
      .expect(200);

    expect(mockRevoke).toHaveBeenCalledWith('jti-route', {
      exp: 1_700_003_600,
      ttl: 60,
    });
    expect(response.body).toMatchObject({
      success: true,
      jti: 'jti-route',
      revoked: true,
      ttl: 3600,
    });
  });

  it('rejects revoke requests without an exp claim', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/auth/revoke')
      .send({
        jti: 'jti-route',
        ttl: 60,
      })
      .expect(400);

    expect(mockRevoke).not.toHaveBeenCalled();
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
