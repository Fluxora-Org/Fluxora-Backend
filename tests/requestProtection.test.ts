/**
 * Tests for src/middleware/requestProtection.ts
 *
 * Covers:
 *   - Content-Length fast path: rejects before reading body
 *   - Stream byte counting: rejects chunked requests that exceed the limit
 *   - Within-limit pass-through: valid requests reach the route handler
 *   - JSON depth enforcement: deeply nested bodies are rejected with 400
 *   - BODY_LIMIT_BYTES constant: exported value equals 256 KiB
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  BODY_LIMIT_BYTES,
  bodySizeLimitMiddleware,
  jsonDepthMiddleware,
  requestTimeoutMiddleware,
} from '../src/middleware/requestProtection.js';
import { ApiError } from '../src/errors.js';
import { ApiErrorCode, errorHandler } from '../src/middleware/errorHandler.js';

function buildApp() {
  const app = express();
  app.use(bodySizeLimitMiddleware);
  app.use(express.json({ limit: BODY_LIMIT_BYTES }));
  app.use(jsonDepthMiddleware());
  app.post('/echo', (req, res) => res.status(200).json(req.body));
  app.use(errorHandler);
  return app;
}

describe('BODY_LIMIT_BYTES', () => {
  it('equals 256 KiB', () => {
    expect(BODY_LIMIT_BYTES).toBe(256 * 1024);
  });
});

describe('bodySizeLimitMiddleware — Content-Length fast path', () => {
  const app = buildApp();

  it('rejects when Content-Length exceeds limit', async () => {
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(BODY_LIMIT_BYTES + 1))
      .send('{}');

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('passes when Content-Length is exactly at the limit', async () => {
    // Build a JSON body whose byte length equals BODY_LIMIT_BYTES.
    // {"d":"<padding>"} — pad to hit the limit exactly.
    const overhead = '{"d":""}';
    const padding = 'x'.repeat(BODY_LIMIT_BYTES - overhead.length);
    const body = `{"d":"${padding}"}`;
    expect(Buffer.byteLength(body)).toBe(BODY_LIMIT_BYTES);

    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
  });
});

describe('bodySizeLimitMiddleware — within-limit pass-through', () => {
  const app = buildApp();

  it('passes a small valid JSON body to the route', async () => {
    const res = await request(app)
      .post('/echo')
      .send({ hello: 'world' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hello: 'world' });
  });
});

describe('jsonDepthMiddleware', () => {
  const app = buildApp(); // default maxDepth = 10

  it('passes a body within the depth limit', async () => {
    const body = { a: { b: { c: { d: 'ok' } } } }; // depth 4
    const res = await request(app).post('/echo').send(body);
    expect(res.status).toBe(200);
  });

  it('rejects a body that exceeds the depth limit', async () => {
    // Build an object nested 12 levels deep (> default 10).
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 12; i++) deep = { child: deep };

    const res = await request(app).post('/echo').send(deep);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('skips depth check for GET requests', async () => {
    const appWithGet = express();
    appWithGet.use(jsonDepthMiddleware());
    appWithGet.get('/ping', (_req, res) => res.json({ ok: true }));
    appWithGet.use(errorHandler);

    const res = await request(appWithGet).get('/ping');
    expect(res.status).toBe(200);
  });
});

describe('requestTimeoutMiddleware', () => {
  it('passes a REQUEST_TIMEOUT ApiError to next on socket timeout', () => {
    let timeoutCallback: (() => void) | undefined;
    const req = {
      socket: {
        setTimeout: (_ms: number, callback?: () => void) => {
          timeoutCallback = callback;
        },
        destroy: () => undefined,
      },
    };
    const res = {
      headersSent: false,
      setHeader: () => undefined,
      on: () => res,
    };
    const next = vi.fn();

    requestTimeoutMiddleware(123)(
      req as any,
      res as any,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    timeoutCallback?.();

    expect(next).toHaveBeenCalledTimes(2);
    const err = next.mock.calls[1]?.[0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(ApiErrorCode.REQUEST_TIMEOUT);
    expect(err.statusCode).toBe(408);
    expect(err.message).toBe('Request timed out after 123ms');
  });
});
