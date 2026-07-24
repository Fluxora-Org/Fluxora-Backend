import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { methodOverrideMiddleware } from '../../src/middleware/methodOverride.js';

vi.mock('../../src/utils/logger.js', () => ({
  info: vi.fn(),
}));

describe('methodOverrideMiddleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = {
      method: 'POST',
      headers: {},
      query: {},
      path: '/api/streams/123',
      id: 'req-123',
    };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    next = vi.fn();
    vi.clearAllMocks();
  });

  it('should ignore non-POST requests', () => {
    req.method = 'GET';
    req.headers = { 'x-http-method-override': 'DELETE', authorization: 'Bearer token' };
    
    methodOverrideMiddleware(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.method).toBe('GET');
  });

  it('should ignore POST requests without override headers/query', () => {
    req.headers = { authorization: 'Bearer token' };
    
    methodOverrideMiddleware(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.method).toBe('POST');
  });

  it('should ignore POST requests without auth headers', () => {
    req.headers = { 'x-http-method-override': 'DELETE' };
    
    methodOverrideMiddleware(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.method).toBe('POST');
  });

  it('should override method when x-http-method-override header is valid and auth is present', () => {
    req.headers = { 'x-http-method-override': 'DELETE', authorization: 'Bearer token' };
    
    methodOverrideMiddleware(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.method).toBe('DELETE');
  });

  it('should override method when _method query is valid and x-api-key is present', () => {
    req.query = { _method: 'patch' };
    req.headers = { 'x-api-key': 'secret-key' };
    
    methodOverrideMiddleware(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.method).toBe('PATCH');
  });

  it('should return 400 for unsupported override methods', () => {
    req.headers = { 'x-http-method-override': 'GET', authorization: 'Bearer token' };
    
    methodOverrideMiddleware(req as Request, res as Response, next);
    
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Unsupported method override',
      }
    });
    expect(req.method).toBe('POST');
  });

  it('should return 400 for completely bogus methods', () => {
    req.query = { _method: 'HACK' };
    req.headers = { authorization: 'Bearer token' };
    
    methodOverrideMiddleware(req as Request, res as Response, next);
    
    expect(res.status).toHaveBeenCalledWith(400);
    expect(req.method).toBe('POST');
  });
});
