import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ApiError } from '../src/errors.js';
import { ApiErrorCode, errorHandler } from '../src/middleware/errorHandler.js';

function buildApp() {
  const app = express();
  app.get('/exposed', () => {
    throw new ApiError(400, ApiErrorCode.VALIDATION_ERROR, 'Validation failed', { field: 'email' }, true);
  });

  app.get('/hidden', () => {
    throw new ApiError(500, 'DB_ERROR', 'Database connection failed', {}, false);
  });

  app.get('/unknown', () => {
    throw new Error('Unexpected failure');
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
      requestId: expect.any(String),
    });
  });

  it('returns generic error message when expose is false', async () => {
    const app = buildApp();
    const res = await request(app).get('/hidden');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Internal server error');
    expect(res.body).not.toHaveProperty('error.details');
    expect(res.body).not.toHaveProperty('stack');
  });

  it('treats unknown errors as non-exposed and hides internals', async () => {
    const app = buildApp();
    const res = await request(app).get('/unknown');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Internal server error');
    expect(res.body).not.toHaveProperty('error');
    expect(res.body).not.toHaveProperty('stack');
    expect(res.body).not.toContain('Unexpected');
  });
});
