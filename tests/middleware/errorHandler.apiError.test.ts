import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ApiError as CanonicalApiError } from '../../src/errors.js';
import { ApiError, ApiErrorCode, errorHandler } from '../../src/middleware/errorHandler.js';

function buildApp(errorFactory: () => Error): express.Application {
  const app = express();
  app.get('/boom', () => {
    throw errorFactory();
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler canonical ApiError handling', () => {
  it('re-exports the canonical ApiError class from middleware/errorHandler', () => {
    const err = new ApiError(ApiErrorCode.VALIDATION_ERROR, 'Invalid payload', 400, {
      field: 'amount',
    });

    expect(err).toBeInstanceOf(CanonicalApiError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe(ApiErrorCode.VALIDATION_ERROR);
    expect(err.details).toEqual({ field: 'amount' });
  });

  it('exposes message and details for public ApiErrors', async () => {
    const app = buildApp(() => new ApiError(ApiErrorCode.CONFLICT, 'Duplicate idempotency key', 409, {
      hint: 'retry original payload',
    }));

    const res = await request(app).get('/boom');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: ApiErrorCode.CONFLICT,
      message: 'Duplicate idempotency key',
      details: { hint: 'retry original payload' },
    });
  });

  it('hides message and details for non-exposed ApiErrors', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = buildApp(() => new CanonicalApiError(
      500,
      ApiErrorCode.INTERNAL_ERROR,
      'database password leaked in stack',
      { secret: 'do-not-return' },
      false,
    ));

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: ApiErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred. Please try again later.',
    });
    expect(JSON.stringify(res.body)).not.toContain('database password');
    expect(JSON.stringify(res.body)).not.toContain('do-not-return');
    logSpy.mockRestore();
  });
});
