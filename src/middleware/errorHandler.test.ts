import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
  ApiError,
  ApiErrorCode,
  errorHandler,
  asyncHandler,
  notFound,
  validationError,
  conflictError,
  serviceUnavailable,
} from './errorHandler.js';
import { correlationIdMiddleware } from './correlationId.js';
import { DecimalSerializationError, DecimalErrorCode } from '../serialization/decimal.js';

function buildApp(throwFn: (req: express.Request) => void) {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.get('/test', asyncHandler(async (req) => { throwFn(req); }));
  app.use(errorHandler);
  return app;
}

describe('ApiError', () => {
  it('constructs with code, message, statusCode', () => {
    const e = new ApiError(ApiErrorCode.NOT_FOUND, 'not found', 404);
    expect(e.code).toBe(ApiErrorCode.NOT_FOUND);
    expect(e.message).toBe('not found');
    expect(e.statusCode).toBe(404);
    expect(e.name).toBe('ApiError');
  });

  it('includes details when provided', () => {
    const e = new ApiError(ApiErrorCode.VALIDATION_ERROR, 'bad', 400, { field: 'x' });
    expect(e.details).toEqual({ field: 'x' });
  });
});

describe('error factory helpers', () => {
  it('notFound creates 404 ApiError with id', () => {
    const e = notFound('Stream', 'abc');
    expect(e.statusCode).toBe(404);
    expect(e.code).toBe(ApiErrorCode.NOT_FOUND);
    expect(e.message).toContain('abc');
  });

  it('notFound without id', () => {
    const e = notFound('Stream');
    expect(e.statusCode).toBe(404);
  });

  it('validationError creates 400', () => {
    const e = validationError('bad input', { field: 'x' });
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe(ApiErrorCode.VALIDATION_ERROR);
  });

  it('conflictError creates 409', () => {
    const e = conflictError('duplicate');
    expect(e.statusCode).toBe(409);
    expect(e.code).toBe(ApiErrorCode.CONFLICT);
  });

  it('serviceUnavailable creates 503', () => {
    const e = serviceUnavailable('down');
    expect(e.statusCode).toBe(503);
    expect(e.code).toBe(ApiErrorCode.SERVICE_UNAVAILABLE);
  });
});

describe('errorHandler middleware', () => {
  it('handles ApiError', async () => {
    const app = buildApp(() => { throw new ApiError(ApiErrorCode.NOT_FOUND, 'not found', 404); });
    const res = await request(app).get('/test').expect(404);
    expect(res.body.error.code).toBe(ApiErrorCode.NOT_FOUND);
  });

  it('handles DecimalSerializationError', async () => {
    const app = buildApp(() => {
      throw new DecimalSerializationError(DecimalErrorCode.INVALID_TYPE, 'bad type', 'depositAmount', 100);
    });
    const res = await request(app).get('/test').expect(400);
    expect(res.body.error.code).toBe(ApiErrorCode.DECIMAL_ERROR);
    expect(res.body.error.details.decimalErrorCode).toBe(DecimalErrorCode.INVALID_TYPE);
  });

  it('handles unexpected errors as 500', async () => {
    const app = buildApp(() => { throw new Error('boom'); });
    const res = await request(app).get('/test').expect(500);
    expect(res.body.error.code).toBe(ApiErrorCode.INTERNAL_ERROR);
  });

  it('handles non-Error throws as 500', async () => {
    const app = buildApp(() => { throw 'string error'; });
    const res = await request(app).get('/test').expect(500);
    expect(res.body.error.code).toBe(ApiErrorCode.INTERNAL_ERROR);
  });

  it('includes requestId from correlationId', async () => {
    const app = buildApp(() => { throw new ApiError(ApiErrorCode.NOT_FOUND, 'nope', 404); });
    const res = await request(app).get('/test').set('x-correlation-id', 'req-abc').expect(404);
    expect(res.body.error.requestId).toBe('req-abc');
  });
});

describe('asyncHandler', () => {
  it('passes async errors to next', async () => {
    const app = express();
    app.use(correlationIdMiddleware);
    app.get('/async', asyncHandler(async () => {
      await Promise.resolve();
      throw new ApiError(ApiErrorCode.CONFLICT, 'conflict', 409);
    }));
    app.use(errorHandler);
    const res = await request(app).get('/async').expect(409);
    expect(res.body.error.code).toBe(ApiErrorCode.CONFLICT);
  });
});

describe('error factory helpers — details branch', () => {
  it('conflictError with details', () => {
    const e = conflictError('dup', { id: '123' });
    expect(e.details).toEqual({ id: '123' });
    expect(e.statusCode).toBe(409);
  });

  it('validationError without details', () => {
    const e = validationError('bad');
    expect(e.details).toBeUndefined();
  });

  it('DecimalSerializationError without field', async () => {
    const app = buildApp(() => {
      throw new DecimalSerializationError(DecimalErrorCode.INVALID_FORMAT, 'bad format');
    });
    const res = await request(app).get('/test').expect(400);
    expect(res.body.error.code).toBe(ApiErrorCode.DECIMAL_ERROR);
    expect(res.body.error.details.field).toBeUndefined();
  });
});
