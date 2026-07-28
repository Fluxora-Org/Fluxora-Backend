import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { apiVersionMiddleware, ACCEPT_VERSION_HEADER } from '../../src/middleware/apiVersion.js';

function mockRequest(headers: Record<string, string | string[]> = {}): Request {
  return {
    headers,
  } as unknown as Request;
}

function mockResponse() {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

function mockNext(): NextFunction {
  return vi.fn();
}

describe('apiVersionMiddleware', () => {
  it('defaults to "v1" when no Accept-Version header is present', () => {
    const req = mockRequest();
    const res = mockResponse();
    const next = mockNext();

    apiVersionMiddleware(req, res, next);

    expect(req.apiVersion).toBe('v1');
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('defaults to "v1" when Accept-Version header is empty string', () => {
    const req = mockRequest({ [ACCEPT_VERSION_HEADER]: '   ' });
    const res = mockResponse();
    const next = mockNext();

    apiVersionMiddleware(req, res, next);

    expect(req.apiVersion).toBe('v1');
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts valid variations of v1 ("1", "1.0", "v1", " V1 ")', () => {
    const validInputs = ['1', '1.0', 'v1', ' V1 ', ' 1.0 '];

    for (const input of validInputs) {
      const req = mockRequest({ [ACCEPT_VERSION_HEADER]: input });
      const res = mockResponse();
      const next = mockNext();

      apiVersionMiddleware(req, res, next);

      expect(req.apiVersion).toBe('v1');
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('returns 400 with specific JSON for unsupported versions ("v2", "abc")', () => {
    const invalidInputs = ['v2', '2.0', 'abc', 'v1.1'];

    for (const input of invalidInputs) {
      const req = mockRequest({ [ACCEPT_VERSION_HEADER]: input });
      const res = mockResponse();
      const next = mockNext();

      apiVersionMiddleware(req, res, next);

      expect(req.apiVersion).toBeUndefined();
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'unsupported_version',
        supported: ['v1']
      });
    }
  });

  it('handles array headers by taking the first element', () => {
    const req = mockRequest({ [ACCEPT_VERSION_HEADER]: ['1.0', 'v2'] });
    const res = mockResponse();
    const next = mockNext();

    apiVersionMiddleware(req, res, next);

    expect(req.apiVersion).toBe('v1');
    expect(next).toHaveBeenCalledOnce();
  });

  it('handles array headers where the first element is invalid', () => {
    const req = mockRequest({ [ACCEPT_VERSION_HEADER]: ['v2', '1.0'] });
    const res = mockResponse();
    const next = mockNext();

    apiVersionMiddleware(req, res, next);

    expect(req.apiVersion).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
