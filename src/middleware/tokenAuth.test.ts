import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBearerTokenAuth } from './tokenAuth.js';
import { verifyIdToken } from '../services/oidcProvider.js';
import { isRevoked } from '../redis/jwtRevocationStore.js';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../services/oidcProvider.js', () => ({
  verifyIdToken: vi.fn(),
}));

vi.mock('../redis/jwtRevocationStore.js', () => ({
  isRevoked: vi.fn(),
}));

describe('createBearerTokenAuth', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    vi.resetAllMocks();
    req = {
      header: vi.fn().mockImplementation((name: string) => {
        if (name.toLowerCase() === 'authorization') {
          return 'Bearer test_token';
        }
        return undefined;
      }),
    };
    res = {};
    next = vi.fn();
  });

  it('refuses wrong-audience tokens', async () => {
    const middleware = createBearerTokenAuth({ role: 'partner', required: true });
    vi.mocked(verifyIdToken).mockRejectedValue(new Error('Token aud claim does not include configured client_id'));
    
    await middleware(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Invalid partner bearer token',
      status: 401
    }));
  });

  it('refuses wrong-issuer tokens', async () => {
    const middleware = createBearerTokenAuth({ role: 'partner', required: true });
    vi.mocked(verifyIdToken).mockRejectedValue(new Error('jwt issuer invalid'));
    
    await middleware(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Invalid partner bearer token',
      status: 401
    }));
  });

  it('refuses expired tokens', async () => {
    const middleware = createBearerTokenAuth({ role: 'partner', required: true });
    vi.mocked(verifyIdToken).mockRejectedValue(new Error('jwt expired'));
    
    await middleware(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Invalid partner bearer token',
      status: 401
    }));
  });

  it('refuses revoked tokens even when otherwise valid', async () => {
    const middleware = createBearerTokenAuth({ role: 'partner', required: true });
    vi.mocked(verifyIdToken).mockResolvedValue({
      address: '0x123',
      role: 'operator',
      sub: 'sub',
      claims: { jti: 'revoked-id' },
    });
    vi.mocked(isRevoked).mockResolvedValue(true);
    
    await middleware(req as Request, res as Response, next);
    
    expect(isRevoked).toHaveBeenCalledWith('revoked-id');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Token revoked',
      status: 401
    }));
  });

  it('accepts valid and unrevoked tokens', async () => {
    const middleware = createBearerTokenAuth({ role: 'partner', required: true });
    vi.mocked(verifyIdToken).mockResolvedValue({
      address: '0x123',
      role: 'operator',
      sub: 'sub',
      claims: { jti: 'valid-id' },
    });
    vi.mocked(isRevoked).mockResolvedValue(false);
    
    await middleware(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalledWith(); // Called with no arguments (success)
  });
});
