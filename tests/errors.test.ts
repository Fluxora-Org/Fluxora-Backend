import { describe, it, expect } from 'vitest';
import { ApiError, serviceUnavailable, unauthorized, ApiErrorCode } from '../src/errors.js';

describe('src/errors.ts', () => {
  describe('ApiError', () => {
    it('constructs with all fields', () => {
      const err = new ApiError(400, 'TEST_CODE', 'test message', { key: 'value' }, true);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('TEST_CODE');
      expect(err.message).toBe('test message');
      expect(err.details).toEqual({ key: 'value' });
      expect(err.expose).toBe(true);
    });

    it('defaults expose to true', () => {
      const err = new ApiError(500, 'INTERNAL', 'oops');
      expect(err.expose).toBe(true);
    });

    it('allows expose=false', () => {
      const err = new ApiError(500, 'INTERNAL', 'oops', undefined, false);
      expect(err.expose).toBe(false);
    });
  });

  describe('serviceUnavailable', () => {
    it('returns a 503 ApiError', () => {
      const err = serviceUnavailable('DB is down');
      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe(ApiErrorCode.SERVICE_UNAVAILABLE);
      expect(err.message).toBe('DB is down');
    });
  });

  describe('unauthorized', () => {
    it('returns a 401 ApiError', () => {
      const err = unauthorized('Invalid token');
      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(401);
      expect(err.code).toBe(ApiErrorCode.UNAUTHORIZED);
      expect(err.message).toBe('Invalid token');
    });
  });
});