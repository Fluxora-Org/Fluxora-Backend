import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ApiError, ApiErrorCode, isApiErrorCode } from '../src/errors.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { QueryTimeoutError } from '../src/db/pool.js';
import { DecimalSerializationError } from '../src/serialization/decimal.js';

function buildApp() {
  const app = express();
  app.get('/exposed', () => {
    throw new ApiError(400, ApiErrorCode.VALIDATION_ERROR, 'Validation failed', { field: 'email' }, true);
  });

  app.get('/hidden', () => {
    throw new ApiError(500, 'DB_ERROR', 'Database connection failed', {}, false);
  });

  app.get('/unknown', () => {
    throw new Error('Unexpected failure at /internal/private/path using pg-driver');
  });

  app.get('/timeout', () => {
    throw new QueryTimeoutError();
  });

  app.get('/decimal', () => {
    throw new DecimalSerializationError('INVALID_FORMAT', 'invalid decimal from /internal/db', 'amount', 'secret-value');
  });

  app.get('/too-large', () => {
    const error = new Error('body contains /internal/private/path and database credentials');
    Object.assign(error, { type: 'entity.too.large' });
    throw error;
  });

  app.get('/malformed-json', () => {
    const error = new SyntaxError('Unexpected token in /internal/private/path');
    Object.assign(error, { status: 400 });
    throw error;
  });

  app.use(errorHandler);
  return app;
}

describe('errorHandler middleware', () => {
  it('returns exposed error details when expose is true', async () => {
    const app = buildApp();
    const res = await request(app).get('/exposed');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toEqual({
      code: ApiErrorCode.VALIDATION_ERROR,
      message: 'Validation failed',
      details: { field: 'email' },
    });
  });

  it('returns generic error message when expose is false', async () => {
    const app = buildApp();
    const res = await request(app).get('/hidden');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toEqual({ code: ApiErrorCode.INTERNAL_ERROR, message: 'Internal server error' });
    expect(res.body).not.toHaveProperty('error.details');
    expect(res.body).not.toHaveProperty('stack');
  });

  it('treats unknown errors as non-exposed and hides internals', async () => {
    const app = buildApp();
    const res = await request(app).get('/unknown');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toEqual({ code: ApiErrorCode.INTERNAL_ERROR, message: 'Internal server error' });
    expect(res.body).not.toHaveProperty('stack');
    expect(JSON.stringify(res.body)).not.toContain('Unexpected');
    expect(JSON.stringify(res.body)).not.toContain('/internal/private/path');
    expect(JSON.stringify(res.body)).not.toContain('pg-driver');
  });

  it.each([
    ['/timeout', 504, 'GATEWAY_TIMEOUT'],
    ['/decimal', 400, 'DECIMAL_ERROR'],
    ['/too-large', 413, 'PAYLOAD_TOO_LARGE'],
    ['/malformed-json', 400, 'VALIDATION_ERROR'],
  ])('returns a safe documented response for %s', async (path, status, code) => {
    const app = buildApp();
    const res = await request(app).get(path);

    expect(res.status).toBe(status);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(code);
    expect(isApiErrorCode(res.body.error.code)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('stack');
    expect(JSON.stringify(res.body)).not.toContain('/internal/private/path');
    expect(JSON.stringify(res.body)).not.toContain('secret-value');
  });
});
