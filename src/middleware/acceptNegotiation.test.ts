import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import {
  AcceptNegotiationValidationError,
  MAX_ACCEPT_HEADER_LENGTH,
  requireJsonAccept,
  validateAcceptHeader,
} from './acceptNegotiation.js';
import { errorHandler } from './errorHandler.js';
import { ApiError, ApiErrorCode } from '../errors.js';

function oversizedAcceptHeader(): string {
  return Array.from({ length: 600 }, () => 'application/json').join(',');
}

function captureValidationError(fn: () => unknown): AcceptNegotiationValidationError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AcceptNegotiationValidationError);
  return thrown as AcceptNegotiationValidationError;
}

describe('validateAcceptHeader', () => {
  describe('valid input is unaffected', () => {
    it.each([
      '*/*',
      'application/*',
      'application/json',
      'application/vnd.api+json',
      'application/json\t; charset=utf-8',
      'application/json; charset=utf-8',
      'APPLICATION/JSON',
      'text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8',
      'application/json;q=0',
      'application/json;q=abc',
      'application/json;q=2',
    ])('accepts %s', (header) => {
      expect(validateAcceptHeader(header)).toBe(header);
    });

    it('accepts a header at exactly the maximum length', () => {
      const header = 'application/json'.padEnd(MAX_ACCEPT_HEADER_LENGTH, ' ');

      expect(header).toHaveLength(MAX_ACCEPT_HEADER_LENGTH);
      expect(validateAcceptHeader(header)).toBe(header);
    });
  });

  describe('empty input', () => {
    it.each(['', '   ', '\t'])('rejects %j with reason "empty"', (header) => {
      const error = captureValidationError(() => validateAcceptHeader(header));

      expect(error.reason).toBe('empty');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe(ApiErrorCode.VALIDATION_ERROR);
      expect(error).toBeInstanceOf(ApiError);
    });
  });

  describe('malformed input', () => {
    it.each([
      ['non-string', 42],
      ['null', null],
      ['undefined', undefined],
      ['array', ['application/json']],
      ['only commas', ',,,'],
      ['trailing comma', 'application/json,'],
      ['leading comma', ',application/json'],
      ['missing subtype', 'application'],
      ['missing subtype after slash', 'application/'],
      ['missing type', '/json'],
      ['wildcard type with concrete subtype', '*/json'],
      ['whitespace inside media range', 'application / json'],
      ['empty parameter', 'application/json;'],
      ['parameter without value', 'application/json;q'],
      ['empty parameter between separators', 'application/json;;q=0.9'],
      ['control character', 'application/json\nX-Injected: true'],
      ['null byte', 'application/json\0'],
    ])('rejects %s with reason "malformed"', (_label, header) => {
      const error = captureValidationError(() => validateAcceptHeader(header));

      expect(error.reason).toBe('malformed');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe(ApiErrorCode.VALIDATION_ERROR);
    });
  });

  describe('oversized input', () => {
    it('rejects a header one character over the documented limit', () => {
      const header = 'application/json'.padEnd(MAX_ACCEPT_HEADER_LENGTH + 1, ' ');

      const error = captureValidationError(() => validateAcceptHeader(header));

      expect(error.reason).toBe('oversized');
      expect(error.statusCode).toBe(413);
      expect(error.code).toBe(ApiErrorCode.PAYLOAD_TOO_LARGE);
    });

    it('rejects a large valid-looking media list', () => {
      const header = oversizedAcceptHeader();

      const error = captureValidationError(() => validateAcceptHeader(header));

      expect(header.length).toBeGreaterThan(MAX_ACCEPT_HEADER_LENGTH);
      expect(error.reason).toBe('oversized');
    });
  });
});

describe('requireJsonAccept', () => {
  function runMiddleware(accept: string | undefined) {
    const req = { headers: { accept } } as unknown as Request;
    const res = {
      locals: {},
      status: vi.fn(function (this: Response) {
        return this;
      }),
      json: vi.fn(),
      setHeader: vi.fn(),
    } as unknown as Response & {
      status: ReturnType<typeof vi.fn>;
      json: ReturnType<typeof vi.fn>;
      setHeader: ReturnType<typeof vi.fn>;
    };
    const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;

    requireJsonAccept(req, res, next);

    return { req, res, next };
  }

  it('passes a missing header through unchanged', () => {
    const { res, next } = runMiddleware(undefined);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('passes a valid JSON Accept header through unchanged', () => {
    const { res, next } = runMiddleware('application/json');

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('rejects empty input with a typed error and does not write a response', () => {
    const { res, next } = runMiddleware('');

    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(AcceptNegotiationValidationError);
    expect((error as AcceptNegotiationValidationError).reason).toBe('empty');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('rejects malformed input with a typed error before mutating response state', () => {
    const { res, next } = runMiddleware('application/xml,,');

    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(AcceptNegotiationValidationError);
    expect((error as AcceptNegotiationValidationError).reason).toBe('malformed');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('rejects oversized input with a typed error before mutating response state', () => {
    const { res, next } = runMiddleware('application/json'.padEnd(MAX_ACCEPT_HEADER_LENGTH + 1, ' '));

    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(AcceptNegotiationValidationError);
    expect((error as AcceptNegotiationValidationError).reason).toBe('oversized');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('preserves the 406 behavior for a valid but unsupported Accept header', () => {
    const { res, next } = runMiddleware('application/xml');

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(406);
    expect(res.json).toHaveBeenCalledTimes(1);
  });
});

describe('requireJsonAccept via Express', () => {
  function createTestApp() {
    const app = express();
    const route = vi.fn((_req: Request, res: Response) => res.json({ ok: true }));

    app.use(requireJsonAccept);
    app.get('/read', route);
    app.use(errorHandler);

    return { app, route };
  }

  it('does not invoke the route when empty input is rejected', async () => {
    const { app, route } = createTestApp();

    const res = await request(app).get('/read').set('Accept', '');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: ApiErrorCode.VALIDATION_ERROR, details: { reason: 'empty' } },
    });
    expect(route).not.toHaveBeenCalled();
  });

  it('returns a typed malformed reason through the standard error envelope', async () => {
    const { app, route } = createTestApp();

    const res = await request(app).get('/read').set('Accept', ',,,');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: ApiErrorCode.VALIDATION_ERROR,
        message: 'Accept header contains an empty media range',
        details: { reason: 'malformed' },
      },
    });
    expect(route).not.toHaveBeenCalled();
  });

  it('returns a typed oversized reason through the standard error envelope', async () => {
    const { app, route } = createTestApp();
    const oversized = oversizedAcceptHeader();

    const res = await request(app).get('/read').set('Accept', oversized);

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: ApiErrorCode.PAYLOAD_TOO_LARGE, details: { reason: 'oversized' } },
    });
    expect(route).not.toHaveBeenCalled();
  });

  it('leaves valid requests unaffected', async () => {
    const { app, route } = createTestApp();

    const res = await request(app).get('/read').set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(route).toHaveBeenCalledTimes(1);
  });
});
