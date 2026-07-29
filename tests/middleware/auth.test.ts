/**
 * Auth middleware unit tests
 *
 * Covers edge cases for:
 * - authenticateApiKey (revoked keys, database errors)
 * - authenticate (non-Bearer schemes, empty tokens, missing jti)
 * - requirePermission (non-array permissions)
 * - requireScope (both API key and JWT auth)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import {
  authenticateApiKey,
  authenticate,
  requireAuth,
  requirePermission,
  requireScope,
  Permission,
} from '../../src/middleware/auth.js';
import { ApiErrorCode } from '../../src/middleware/errorHandler.js';

// Mock dependencies
vi.mock('../../src/lib/apiKey.js', () => ({
  getApiKeyFromRequest: vi.fn(),
  findRecordByRawKey: vi.fn(),
}));

vi.mock('../../src/lib/auth.js', () => ({
  verifyToken: vi.fn(),
}));

vi.mock('../../src/redis/jwtRevocationStore.js', () => ({
  isRevoked: vi.fn(),
}));

vi.mock('../../src/metrics/businessMetrics.js', () => ({
  authJwtVerifyDurationSeconds: {
    startTimer: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/logger.js', async () => {
  const actual = await vi.importActual('../../src/utils/logger.js');
  return { ...(actual as object), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
});

describe('authenticateApiKey', () => {
  let getApiKeyFromRequest: any, findRecordByRawKey: any;
  let warn: any, info: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const apiKeyModule = await import('../../src/lib/apiKey.js');
    getApiKeyFromRequest = apiKeyModule.getApiKeyFromRequest;
    findRecordByRawKey = apiKeyModule.findRecordByRawKey;
    const loggerModule = await import('../../src/utils/logger.js');
    warn = loggerModule.warn;
    info = loggerModule.info;
  });

  it('proceeds without setting keyScopes when no API key is present', async () => {
    (getApiKeyFromRequest as any).mockReturnValue(null);

    const req = {} as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).keyScopes).toBeUndefined();
    expect((req as any).keyId).toBeUndefined();
  });

  it('attaches keyScopes and keyId when API key is valid and active', async () => {
    (getApiKeyFromRequest as any).mockReturnValue('flx_valid_key');
    (findRecordByRawKey as any).mockResolvedValue({
      id: 'key_123',
      active: true,
      scopes: ['streams:read', 'streams:write'],
    });

    const req = {} as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).keyScopes).toEqual(['streams:read', 'streams:write']);
    expect((req as any).keyId).toBe('key_123');
    expect(info).toHaveBeenCalledWith('API key authenticated', { keyId: 'key_123', requestId: undefined });
  });

  it('returns 401 when API key is not found', async () => {
    (getApiKeyFromRequest as any).mockReturnValue('flx_invalid_key');
    (findRecordByRawKey as any).mockResolvedValue(null);

    const req = {} as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ApiErrorCode.UNAUTHORIZED,
        message: 'Invalid API key',
        requestId: undefined,
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('API key authentication failed — key not found', { requestId: undefined });
  });

  it('returns 401 when API key is revoked', async () => {
    (getApiKeyFromRequest as any).mockReturnValue('flx_revoked_key');
    (findRecordByRawKey as any).mockResolvedValue({
      id: 'key_456',
      active: false,
      scopes: ['streams:read'],
    });

    const req = {} as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ApiErrorCode.UNAUTHORIZED,
        message: 'API key has been revoked',
        requestId: undefined,
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('API key authentication failed — key is revoked', { keyId: 'key_456', requestId: undefined });
  });

  it('returns 401 with generic message on database error', async () => {
    (getApiKeyFromRequest as any).mockReturnValue('flx_error_key');
    (findRecordByRawKey as any).mockRejectedValue(new Error('Database connection failed'));

    const req = {} as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ApiErrorCode.UNAUTHORIZED,
        message: 'Authentication failed',
        requestId: undefined,
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'API key authentication error',
      expect.objectContaining({
        error: 'Database connection failed',
      }),
    );
  });
});

describe('authenticate', () => {
  let verifyToken: any, isRevoked: any;
  let warn: any, info: any, debug: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const authModule = await import('../../src/lib/auth.js');
    verifyToken = authModule.verifyToken;
    const revocationModule = await import('../../src/redis/jwtRevocationStore.js');
    isRevoked = revocationModule.isRevoked;
    const loggerModule = await import('../../src/utils/logger.js');
    warn = loggerModule.warn;
    info = loggerModule.info;
    debug = loggerModule.debug;
  });

  it('proceeds without req.user when no Authorization header is present', async () => {
    const req = { headers: {} } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(debug).toHaveBeenCalledWith('Authentication middleware triggered', { hasAuthHeader: false, requestId: undefined });
  });

  it('proceeds without req.user for non-Bearer Authorization scheme', async () => {
    const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Invalid Authorization header format — non-Bearer scheme', { scheme: 'Basic', requestId: undefined });
  });

  it('proceeds without req.user for empty Bearer token', async () => {
    const req = { headers: { authorization: 'Bearer ' } } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Invalid Authorization header format — empty Bearer token', { requestId: undefined });
  });

  it('proceeds without req.user for whitespace-only Bearer token', async () => {
    const req = { headers: { authorization: 'Bearer    ' } } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Invalid Authorization header format — empty Bearer token', { requestId: undefined });
  });

  it('attaches req.user when JWT is valid and not revoked', async () => {
    (verifyToken as any).mockReturnValue({
      address: 'GTEST',
      role: 'operator',
      permissions: [Permission.STREAMS_READ],
      jti: 'token_123',
    });
    (isRevoked as any).mockResolvedValue(false);

    const req = { headers: { authorization: 'Bearer valid.jwt.token' } } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({
      address: 'GTEST',
      role: 'operator',
      permissions: [Permission.STREAMS_READ],
      jti: 'token_123',
    });
    expect(info).toHaveBeenCalledWith('User authenticated via JWT', { address: 'GTEST', requestId: undefined });
  });

  it('returns 401 when JWT is revoked', async () => {
    (verifyToken as any).mockReturnValue({
      address: 'GTEST',
      role: 'operator',
      permissions: [Permission.STREAMS_READ],
      jti: 'token_123',
    });
    (isRevoked as any).mockResolvedValue(true);

    const req = { headers: { authorization: 'Bearer revoked.jwt.token' } } as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ApiErrorCode.UNAUTHORIZED,
        message: 'token_revoked',
        requestId: undefined,
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('JWT rejected — token revoked', { jti: 'token_123', requestId: undefined });
  });

  it('skips revocation check when JWT has no jti claim', async () => {
    (verifyToken as any).mockReturnValue({
      address: 'GTEST',
      role: 'operator',
      permissions: [Permission.STREAMS_READ],
      // no jti
    });

    const req = { headers: { authorization: 'Bearer valid.jwt.token' } } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticate(req, res, next);

    expect(isRevoked).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
  });

  it('returns 401 when JWT verification fails', async () => {
    (verifyToken as any).mockImplementation(() => {
      throw new Error('Invalid signature');
    });

    const req = { headers: { authorization: 'Bearer invalid.jwt.token' } } as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ApiErrorCode.UNAUTHORIZED,
        message: 'Invalid or expired authentication token',
        requestId: undefined,
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('JWT authentication failed', expect.objectContaining({ error: 'Invalid signature' }));
  });
});

describe('requireAuth', () => {
  let warn: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const loggerModule = await import('../../src/utils/logger.js');
    warn = loggerModule.warn;
  });

  it('proceeds when req.user is set', () => {
    const req = { user: { address: 'GTEST' } } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when req.user is not set', () => {
    const req = { user: undefined, path: '/api/streams' } as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ApiErrorCode.UNAUTHORIZED,
        message: 'Authentication required to access this resource',
        requestId: undefined,
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Anonymous access denied to protected route', { path: '/api/streams', requestId: undefined });
  });
});

describe('requirePermission', () => {
  let warn: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const loggerModule = await import('../../src/utils/logger.js');
    warn = loggerModule.warn;
  });

  it('proceeds when user has the required permission', () => {
    const req = {
      user: { permissions: [Permission.STREAMS_READ, Permission.STREAMS_WRITE] },
      path: '/api/streams',
    } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    const middleware = requirePermission(Permission.STREAMS_READ);
    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when req.user is not set', () => {
    const req = { user: undefined, path: '/api/streams' } as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    const middleware = requirePermission(Permission.STREAMS_READ);
    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Permission check failed: no authenticated user', { path: '/api/streams', requestId: undefined });
  });

  it('returns 403 when permissions is not an array', () => {
    const req = {
      user: { permissions: 'not-an-array' },
      path: '/api/streams',
    } as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    const middleware = requirePermission(Permission.STREAMS_READ);
    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ApiErrorCode.FORBIDDEN,
        message: 'Insufficient permissions to access this resource',
        requestId: undefined,
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Permission check failed: non-array permissions on principal', { path: '/api/streams', requestId: undefined });
  });

  it('returns 403 when user does not have the required permission', () => {
    const req = {
      user: { permissions: [Permission.STREAMS_READ] },
      path: '/api/streams',
    } as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    const middleware = requirePermission(Permission.STREAMS_WRITE);
    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ApiErrorCode.FORBIDDEN,
        message: 'Insufficient permissions to access this resource',
        requestId: undefined,
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Insufficient permissions', { required: Permission.STREAMS_WRITE, have: [Permission.STREAMS_READ], path: '/api/streams', requestId: undefined });
  });
});

describe('requireScope', () => {
  let warn: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const loggerModule = await import('../../src/utils/logger.js');
    warn = loggerModule.warn;
  });

  it('proceeds when API key has one of the required scopes', () => {
    const req = {
      keyId: 'key_123',
      keyScopes: ['streams:read', 'streams:write'],
      path: '/api/streams',
    } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    const middleware = requireScope('streams:read', 'admin:pause');
    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('proceeds when JWT has one of the required scopes', () => {
    const req = {
      user: { permissions: ['streams:read', 'streams:write'] },
      path: '/api/streams',
    } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    const middleware = requireScope('streams:read', 'admin:pause');
    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when neither API key nor JWT auth is present', () => {
    const req = { path: '/api/streams' } as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    const middleware = requireScope('streams:read');
    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ApiErrorCode.UNAUTHORIZED,
        message: 'Authentication required to access this resource',
        requestId: undefined,
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Scope check failed: no authenticated principal', { path: '/api/streams', requestId: undefined });
  });

  it('returns 403 when scopes array is empty', () => {
    const req = {
      keyId: 'key_123',
      keyScopes: [],
      path: '/api/streams',
    } as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    const middleware = requireScope('streams:read');
    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ApiErrorCode.FORBIDDEN,
        message: 'Principal does not have required scopes',
        requestId: undefined,
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Scope check failed: no scopes found on principal', { path: '/api/streams', requestId: undefined });
  });

  it('returns 403 when scopes is not an array', () => {
    const req = {
      user: { permissions: 'not-an-array' },
      path: '/api/streams',
    } as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    const middleware = requireScope('streams:read');
    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ApiErrorCode.FORBIDDEN,
        message: 'Principal does not have required scopes',
        requestId: undefined,
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Scope check failed: no scopes found on principal', { path: '/api/streams', requestId: undefined });
  });

  it('returns 403 when none of the required scopes are present', () => {
    const req = {
      keyId: 'key_123',
      keyScopes: ['streams:read'],
      path: '/api/streams',
    } as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    const middleware = requireScope('admin:pause', 'dlq:delete');
    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ApiErrorCode.FORBIDDEN,
        message: 'Insufficient scopes. Required: admin:pause or dlq:delete',
        requestId: undefined,
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Insufficient scopes', { required: ['admin:pause', 'dlq:delete'], have: ['streams:read'], path: '/api/streams', requestId: undefined });
  });

  it('prefers API key scopes over JWT permissions when both are present', () => {
    const req = {
      keyId: 'key_123',
      keyScopes: ['streams:read'],
      user: { permissions: ['admin:pause'] },
      path: '/api/streams',
    } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    const middleware = requireScope('streams:read');
    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
