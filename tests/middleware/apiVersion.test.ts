import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  apiVersionMiddleware,
  ACCEPT_VERSION_HEADER,
  API_VERSION_RESPONSE_HEADER,
  DEFAULT_API_VERSION,
  SUPPORTED_VERSIONS,
} from '../../src/middleware/apiVersion.js';

function mockRequest(headers: Record<string, string | string[]> = {}): Request {
  return {
    headers,
  } as unknown as Request;
}

function mockResponse() {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  };
  return res as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
  };
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

// ── resolved version is echoed in the response ────────────────────────────────

describe('apiVersionMiddleware — resolved version echo', () => {
  it('echoes the documented default in X-API-Version when the header is omitted', () => {
    const req = mockRequest();
    const res = mockResponse();

    apiVersionMiddleware(req, res, mockNext());

    expect(req.apiVersion).toBe(DEFAULT_API_VERSION);
    expect(res.setHeader).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith(API_VERSION_RESPONSE_HEADER, DEFAULT_API_VERSION);
  });

  it('echoes the documented default when the header is blank', () => {
    const req = mockRequest({ [ACCEPT_VERSION_HEADER]: '   ' });
    const res = mockResponse();

    apiVersionMiddleware(req, res, mockNext());

    expect(res.setHeader).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith(API_VERSION_RESPONSE_HEADER, DEFAULT_API_VERSION);
  });

  it('echoes the resolved version for every supported alias', () => {
    for (const input of ['v1', '1', '1.0', ' V1 ']) {
      const req = mockRequest({ [ACCEPT_VERSION_HEADER]: input });
      const res = mockResponse();

      apiVersionMiddleware(req, res, mockNext());

      expect(res.setHeader).toHaveBeenCalledWith(API_VERSION_RESPONSE_HEADER, 'v1');
    }
  });

  it('does not echo a version when the request is refused', () => {
    const req = mockRequest({ [ACCEPT_VERSION_HEADER]: 'v2' });
    const res = mockResponse();

    apiVersionMiddleware(req, res, mockNext());

    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ── supported versions are documented / exported ──────────────────────────────

describe('apiVersion contract', () => {
  it('exports the supported versions with the default among them', () => {
    expect(SUPPORTED_VERSIONS.length).toBeGreaterThan(0);
    expect(SUPPORTED_VERSIONS).toContain(DEFAULT_API_VERSION);
  });

  it('uses the canonical response header name for the echo', () => {
    expect(API_VERSION_RESPONSE_HEADER).toBe('X-API-Version');
  });
});
