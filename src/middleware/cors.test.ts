import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  corsAllowlistMiddleware,
  isOriginAllowed,
  validateOrigin,
  validateRequestHeaders,
  validateRequestMethod,
  CorsValidationError,
  MAX_ORIGIN_LENGTH,
  MAX_REQUEST_HEADERS_LENGTH,
  MAX_REQUEST_METHOD_LENGTH,
  CorsRequest,
  CorsResponse,
} from './cors.js';
import { errorHandler } from './errorHandler.js';
import { ApiError, ApiErrorCode } from '../errors.js';

describe('CORS Input Validation and Middleware', () => {
  describe('CorsValidationError typed error', () => {
    it('is an instance of Error, ApiError, and CorsValidationError', () => {
      const err = new CorsValidationError('Origin cannot be empty', 'empty');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toBeInstanceOf(CorsValidationError);
      expect(err.name).toBe('CorsValidationError');
      expect(err.reason).toBe('empty');
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe(ApiErrorCode.VALIDATION_ERROR);
    });

    it('sets statusCode 413 and code PAYLOAD_TOO_LARGE for oversized inputs', () => {
      const err = new CorsValidationError('Oversized origin', 'oversized');
      expect(err.reason).toBe('oversized');
      expect(err.statusCode).toBe(413);
      expect(err.code).toBe(ApiErrorCode.PAYLOAD_TOO_LARGE);
    });
  });

  describe('validateOrigin', () => {
    it('accepts valid https and http origins', () => {
      expect(validateOrigin('https://example.com')).toBe('https://example.com');
      expect(validateOrigin('https://sub.domain.org:8443')).toBe('https://sub.domain.org:8443');
      expect(validateOrigin('http://localhost:3000')).toBe('http://localhost:3000');
      expect(validateOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    });

    it('accepts opaque origin null per RFC 6454', () => {
      expect(validateOrigin('null')).toBe('null');
    });

    it('rejects non-string inputs with malformed reason', () => {
      expect(() => validateOrigin(12345 as any)).toThrow(CorsValidationError);
      try {
        validateOrigin(null as any);
      } catch (e: any) {
        expect(e).toBeInstanceOf(CorsValidationError);
        expect(e.reason).toBe('malformed');
      }
    });

    it('rejects empty and whitespace-only origins with empty reason', () => {
      expect(() => validateOrigin('')).toThrow(CorsValidationError);
      try {
        validateOrigin('');
      } catch (e: any) {
        expect(e.reason).toBe('empty');
      }

      try {
        validateOrigin('   ');
      } catch (e: any) {
        expect(e.reason).toBe('empty');
      }
    });

    it('rejects oversized origins with oversized reason', () => {
      const oversized = 'https://' + 'a'.repeat(MAX_ORIGIN_LENGTH + 10) + '.com';
      try {
        validateOrigin(oversized);
      } catch (e: any) {
        expect(e).toBeInstanceOf(CorsValidationError);
        expect(e.reason).toBe('oversized');
        expect(e.statusCode).toBe(413);
      }
    });

    it('rejects origins with control characters and CRLF injection', () => {
      const originsWithInjection = [
        'https://example.com\r\nX-Injected: true',
        'https://example.com\nEvil: true',
        'https://example.com\0',
      ];
      for (const origin of originsWithInjection) {
        try {
          validateOrigin(origin);
          expect.fail('Should have thrown for ' + origin);
        } catch (e: any) {
          expect(e).toBeInstanceOf(CorsValidationError);
          expect(e.reason).toBe('malformed');
        }
      }
    });

    it('rejects origins with paths, query params, fragments, or userinfo', () => {
      const malformedOrigins = [
        'https://example.com/path',
        'https://example.com/',
        'https://example.com?query=1',
        'https://example.com#fragment',
        'https://user:pass@example.com',
        'ftp://example.com',
        'javascript:alert(1)',
        'not a url',
        'https://',
      ];
      for (const origin of malformedOrigins) {
        try {
          validateOrigin(origin);
          expect.fail('Should have thrown for ' + origin);
        } catch (e: any) {
          expect(e).toBeInstanceOf(CorsValidationError);
          expect(e.reason).toBe('malformed');
        }
      }
    });
  });

  describe('validateRequestHeaders', () => {
    it('returns undefined when header is not supplied', () => {
      expect(validateRequestHeaders(undefined)).toBeUndefined();
    });

    it('accepts valid RFC 7230 header tokens', () => {
      expect(validateRequestHeaders('Content-Type, Authorization, X-Requested-With')).toBe(
        'Content-Type, Authorization, X-Requested-With'
      );
    });

    it('rejects empty header value with empty reason', () => {
      try {
        validateRequestHeaders('   ');
      } catch (e: any) {
        expect(e).toBeInstanceOf(CorsValidationError);
        expect(e.reason).toBe('empty');
      }
    });

    it('rejects oversized header value with oversized reason', () => {
      const oversized = 'X-Custom-Header,'.repeat(200);
      try {
        validateRequestHeaders(oversized);
      } catch (e: any) {
        expect(e).toBeInstanceOf(CorsValidationError);
        expect(e.reason).toBe('oversized');
      }
    });

    it('rejects control characters and malformed tokens', () => {
      try {
        validateRequestHeaders('Content-Type\r\nInjected: true');
      } catch (e: any) {
        expect(e).toBeInstanceOf(CorsValidationError);
        expect(e.reason).toBe('malformed');
      }

      try {
        validateRequestHeaders('Content-Type, Inva lid Header');
      } catch (e: any) {
        expect(e).toBeInstanceOf(CorsValidationError);
        expect(e.reason).toBe('malformed');
      }
    });
  });

  describe('validateRequestMethod', () => {
    it('returns undefined when method is not supplied', () => {
      expect(validateRequestMethod(undefined)).toBeUndefined();
    });

    it('accepts valid method tokens', () => {
      expect(validateRequestMethod('POST')).toBe('POST');
      expect(validateRequestMethod('GET')).toBe('GET');
      expect(validateRequestMethod('DELETE')).toBe('DELETE');
    });

    it('rejects empty method with empty reason', () => {
      try {
        validateRequestMethod('');
      } catch (e: any) {
        expect(e).toBeInstanceOf(CorsValidationError);
        expect(e.reason).toBe('empty');
      }
    });

    it('rejects oversized method with oversized reason', () => {
      try {
        validateRequestMethod('A'.repeat(MAX_REQUEST_METHOD_LENGTH + 1));
      } catch (e: any) {
        expect(e).toBeInstanceOf(CorsValidationError);
        expect(e.reason).toBe('oversized');
      }
    });

    it('rejects malformed method with malformed reason', () => {
      try {
        validateRequestMethod('GET\r\n');
      } catch (e: any) {
        expect(e).toBeInstanceOf(CorsValidationError);
        expect(e.reason).toBe('malformed');
      }
    });
  });

  describe('isOriginAllowed', () => {
    it('validates input and checks against allowedOrigins Set', () => {
      const allowed = new Set(['https://app.fluxora.io', 'https://staging.fluxora.io']);
      expect(isOriginAllowed('https://app.fluxora.io', allowed)).toBe(true);
      expect(isOriginAllowed('https://evil.com', allowed)).toBe(false);
      expect(isOriginAllowed('null', allowed)).toBe(false);
    });

    it('throws CorsValidationError for malformed origin passed to isOriginAllowed', () => {
      const allowed = new Set(['https://app.fluxora.io']);
      expect(() => isOriginAllowed('malformed-origin', allowed)).toThrow(CorsValidationError);
    });
  });

  describe('corsAllowlistMiddleware state safety', () => {
    it('rejection happens before any response state or headers are written', () => {
      const setHeader = vi.fn();
      const removeHeader = vi.fn();
      const sendStatus = vi.fn();
      const status = vi.fn().mockReturnValue({ json: vi.fn() });

      const req: CorsRequest = {
        method: 'GET',
        header: (name: string) => (name.toLowerCase() === 'origin' ? 'invalid-origin' : undefined),
      };
      const res: CorsResponse = { setHeader, removeHeader, sendStatus, status };
      let passedError: any = null;
      const next = vi.fn((err?: unknown) => {
        passedError = err;
      });

      corsAllowlistMiddleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(passedError).toBeInstanceOf(CorsValidationError);
      expect(passedError.reason).toBe('malformed');

      expect(setHeader).not.toHaveBeenCalled();
      expect(removeHeader).not.toHaveBeenCalled();
      expect(sendStatus).not.toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
    });

    it('rejects empty Origin header before setting any response headers', () => {
      const setHeader = vi.fn();
      const removeHeader = vi.fn();
      const sendStatus = vi.fn();
      const status = vi.fn().mockReturnValue({ json: vi.fn() });

      const req: CorsRequest = {
        method: 'POST',
        header: (name: string) => (name.toLowerCase() === 'origin' ? '   ' : undefined),
      };
      const res: CorsResponse = { setHeader, removeHeader, sendStatus, status };
      let passedError: any = null;
      const next = vi.fn((err?: unknown) => {
        passedError = err;
      });

      corsAllowlistMiddleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(passedError).toBeInstanceOf(CorsValidationError);
      expect(passedError.reason).toBe('empty');
      expect(setHeader).not.toHaveBeenCalled();
      expect(removeHeader).not.toHaveBeenCalled();
    });

    it('rejects oversized Origin header before setting any response headers', () => {
      const setHeader = vi.fn();
      const removeHeader = vi.fn();
      const sendStatus = vi.fn();
      const status = vi.fn().mockReturnValue({ json: vi.fn() });

      const req: CorsRequest = {
        method: 'POST',
        header: (name: string) =>
          name.toLowerCase() === 'origin' ? 'https://' + 'b'.repeat(3000) + '.com' : undefined,
      };
      const res: CorsResponse = { setHeader, removeHeader, sendStatus, status };
      let passedError: any = null;
      const next = vi.fn((err?: unknown) => {
        passedError = err;
      });

      corsAllowlistMiddleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(passedError).toBeInstanceOf(CorsValidationError);
      expect(passedError.reason).toBe('oversized');
      expect(passedError.statusCode).toBe(413);
      expect(setHeader).not.toHaveBeenCalled();
      expect(removeHeader).not.toHaveBeenCalled();
    });
  });

  describe('Express integration with errorHandler', () => {
    let app: express.Application;

    beforeEach(() => {
      app = express();
      app.use(corsAllowlistMiddleware as any);
      app.get('/api/test', (req, res) => res.json({ ok: true }));
      app.options('/api/test', (req, res) => res.sendStatus(204));
      app.use(errorHandler);
    });

    it('handles requests without Origin (same-origin / non-browser) cleanly', async () => {
      const res = await request(app).get('/api/test').expect(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('returns structured 400 validation error for malformed origin', async () => {
      const res = await request(app)
        .get('/api/test')
        .set('Origin', 'not-a-valid-origin')
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('Origin header is malformed');
    });

    it('returns structured 413 error for oversized origin', async () => {
      const res = await request(app)
        .get('/api/test')
        .set('Origin', 'https://' + 'x'.repeat(2500) + '.org')
        .expect(413);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('returns structured 400 error for empty origin', async () => {
      const res = await request(app)
        .get('/api/test')
        .set('Origin', '   ')
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('cannot be empty');
    });

    it('allows valid requests and echoes CORS headers', async () => {
      const res = await request(app)
        .get('/api/test')
        .set('Origin', 'https://app.fluxora.io')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBeDefined();
      expect(res.body).toEqual({ ok: true });
    });
  });
});
