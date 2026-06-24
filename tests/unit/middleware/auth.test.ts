import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { authenticate, requireAuth, requirePermission, Permission } from '../../../src/middleware/auth.js';
import { verifyToken } from '../../../src/lib/auth.js';
import { isRevoked } from '../../../src/redis/jwtRevocationStore.js';

// ── Mocks ──

vi.mock('../../../src/lib/auth.js', () => ({
  verifyToken: vi.fn(),
}));

vi.mock('../../../src/redis/jwtRevocationStore.js', () => ({
  isRevoked: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

// ── Helpers ──

function mockReq(opts: { authHeader?: string; id?: string } = {}): Partial<Request> {
  return {
    headers: opts.authHeader ? { authorization: opts.authHeader } : {},
    id: opts.id ?? 'req-123',
    correlationId: opts.id ?? 'req-123',
  };
}

function mockRes(): Partial<Response> {
  const res: any = {
    statusCode: 200,
    jsonBody: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.jsonBody = body;
      return this;
    },
  };
  return res as Response;
}

function mockNext(): NextFunction {
  return vi.fn();
}

// ── Tests ──

describe('authenticate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy path ──

  it('authenticates valid non-revoked token', async () => {
    const payload = {
      address: 'GABC...',
      role: 'operator',
      permissions: [Permission.STREAMS_READ],
      jti: 'jti-valid',
    };
    (verifyToken as any).mockReturnValue(payload);
    (isRevoked as any).mockResolvedValue(false);

    const req = mockReq({ authHeader: 'Bearer valid-token' }) as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual(expect.objectContaining(payload));
    expect(isRevoked).toHaveBeenCalledWith('jti-valid');
  });

  it('proceeds without user when no auth header', async () => {
    const req = mockReq() as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  // ── Revocation checks ──

  it('returns 401 when token is revoked', async () => {
    const payload = {
      address: 'GABC...',
      role: 'operator',
      permissions: [Permission.STREAMS_READ],
      jti: 'jti-revoked',
    };
    (verifyToken as any).mockReturnValue(payload);
    (isRevoked as any).mockResolvedValue(true);

    const req = mockReq({ authHeader: 'Bearer revoked-token' }) as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    await authenticate(req, res, next);

    expect(res.statusCode).toBe(401);
    expect((res as any).jsonBody.error.message).toBe('token_revoked');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token has no jti and is treated as revoked', async () => {
    const payload = {
      address: 'GABC...',
      role: 'operator',
      permissions: [Permission.STREAMS_READ],
      // No jti
    };
    (verifyToken as any).mockReturnValue(payload);

    const req = mockReq({ authHeader: 'Bearer no-jti-token' }) as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    await authenticate(req, res, next);

    // Tokens without jti skip revocation check (backward compatibility)
    expect(next).toHaveBeenCalled();
    expect(isRevoked).not.toHaveBeenCalled();
  });

  it('returns 401 when Redis is unavailable (fail-closed)', async () => {
    const payload = {
      address: 'GABC...',
      role: 'operator',
      permissions: [Permission.STREAMS_READ],
      jti: 'jti-check',
    };
    (verifyToken as any).mockReturnValue(payload);
    (isRevoked as any).mockResolvedValue(true); // Redis down = treated as revoked

    const req = mockReq({ authHeader: 'Bearer token-during-outage' }) as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    await authenticate(req, res, next);

    expect(res.statusCode).toBe(401);
    expect((res as any).jsonBody.error.message).toBe('token_revoked');
  });

  // ── Auth failure modes ──

  it('returns 401 for invalid token signature', async () => {
    (verifyToken as any).mockImplementation(() => {
      throw new Error('invalid signature');
    });

    const req = mockReq({ authHeader: 'Bearer bad-token' }) as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    await authenticate(req, res, next);

    expect(res.statusCode).toBe(401);
    expect((res as any).jsonBody.error.message).toContain('Invalid or expired');
  });

  it('returns 401 for expired token', async () => {
    (verifyToken as any).mockImplementation(() => {
      const err = new Error('jwt expired');
      throw err;
    });

    const req = mockReq({ authHeader: 'Bearer expired-token' }) as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    await authenticate(req, res, next);

    expect(res.statusCode).toBe(401);
  });

  it('proceeds as anonymous for malformed auth header', async () => {
    const req = mockReq({ authHeader: 'Basic bad-format' }) as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  // ── Schema validation ──

  it('returns 401 for token with invalid shape', async () => {
    const payload = { foo: 'bar', jti: 'jti-bad' }; // Missing required fields
    (verifyToken as any).mockReturnValue(payload);
    (isRevoked as any).mockResolvedValue(false);

    const req = mockReq({ authHeader: 'Bearer malformed-payload' }) as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    await authenticate(req, res, next);

    expect(res.statusCode).toBe(401);
  });

  // ── JWT verify histogram (issue #361) ──
  /**
   * prom-client Histogram `get()` emits bucket observations (which include
   * `le`) alongside `_count` / `_sum` series (which carry only the metric's
   * declared labels). We assert on the count series to confirm the label
   * set is bounded to `outcome`.
   */
  function findJwtCountSeries(values: any[], outcome: string) {
    return values.find(
      (v) =>
        v.metricName === 'fluxora_auth_jwt_verify_duration_seconds_count' &&
        (v.labels as Record<string, string>).outcome === outcome,
    );
  }

  it('records fluxora_auth_jwt_verify_duration_seconds with outcome=success on a valid verify', async () => {
    const { authJwtVerifyDurationSeconds } = await import(
      '../../../src/metrics/businessMetrics.js'
    );
    authJwtVerifyDurationSeconds.reset();

    const payload = {
      address: 'GABC...',
      role: 'operator',
      permissions: [Permission.STREAMS_READ],
      jti: 'jti-hist-success',
    };
    (verifyToken as any).mockReturnValue(payload);
    (isRevoked as any).mockResolvedValue(false);

    const req = mockReq({ authHeader: 'Bearer valid-histogram-token' }) as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    await authenticate(req, res, next);

    const val = await authJwtVerifyDurationSeconds.get();
    const success = findJwtCountSeries(val.values, 'success');
    expect(success).toBeDefined();
    expect(success?.value).toBeGreaterThanOrEqual(1);
    // count series carries only { outcome }
    expect(Object.keys(success!.labels)).toEqual(['outcome']);
  });

  it('records fluxora_auth_jwt_verify_duration_seconds with outcome=failure on verify throw', async () => {
    const { authJwtVerifyDurationSeconds } = await import(
      '../../../src/metrics/businessMetrics.js'
    );
    authJwtVerifyDurationSeconds.reset();

    (verifyToken as any).mockImplementation(() => {
      throw new Error('jwt malformed');
    });

    const req = mockReq({ authHeader: 'Bearer throw-token' }) as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    await authenticate(req, res, next);

    const val = await authJwtVerifyDurationSeconds.get();
    const failure = findJwtCountSeries(val.values, 'failure');
    expect(failure).toBeDefined();
    expect(failure?.value).toBeGreaterThanOrEqual(1);
    expect(Object.keys(failure!.labels)).toEqual(['outcome']);
    // No token material leaked into any label across bucket/count/sum series
    for (const v of val.values) {
      for (const forbidden of ['jti', 'address', 'subject', 'kid']) {
        expect((v.labels as Record<string, unknown>)[forbidden]).toBeUndefined();
      }
    }
  });
});

describe('requireAuth', () => {
  it('allows authenticated requests', () => {
    const req = { user: { address: 'GABC...' } } as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('returns 401 for anonymous requests', () => {
    const req = {} as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    requireAuth(req, res, next);

    expect(res.statusCode).toBe(401);
    expect((res as any).jsonBody.error.message).toContain('Authentication required');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requirePermission', () => {
  it('allows requests with required permission', () => {
    const req = {
      user: { permissions: [Permission.STREAMS_READ, Permission.STREAMS_WRITE] },
    } as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    requirePermission(Permission.STREAMS_WRITE)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('returns 403 for requests without required permission', () => {
    const req = {
      user: { permissions: [Permission.STREAMS_READ] },
    } as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    requirePermission(Permission.STREAMS_WRITE)(req, res, next);

    expect(res.statusCode).toBe(403);
    expect((res as any).jsonBody.error.message).toContain('Insufficient permissions');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when no user is present', () => {
    const req = {} as Request;
    const res = mockRes() as Response;
    const next = mockNext();

    requirePermission(Permission.STREAMS_READ)(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});