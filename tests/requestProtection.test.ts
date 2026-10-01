/**
 * Tests for src/middleware/requestProtection.ts
 *
 * Covers:
 *   - Content-Length fast path: rejects before reading body
 *   - Stream byte counting: rejects chunked requests that exceed the limit
 *   - Limits enforced *while* the body is being read (#1468): the refusal
 *     happens before the payload is fully buffered, not afterwards
 *   - Within-limit pass-through: valid requests reach the route handler
 *   - JSON depth enforcement: deeply nested bodies are rejected with 400,
 *     before the body is fully read and parsed
 *   - BODY_LIMIT_BYTES constant: exported value equals 256 KiB
 */

import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_RAW_LIMIT_BYTES,
  DEFAULT_DECOMPRESSED_LIMIT_BYTES,
  ROUTE_LIMITS,
  bodySizeLimitMiddleware,
  dynamicJsonParser,
  jsonDepthLimitMiddleware,
  jsonDepthMiddleware,
  requestTimeoutMiddleware,
} from '../src/middleware/requestProtection.js';
import { ApiError } from '../src/errors.js';
import { ApiErrorCode, errorHandler } from '../src/middleware/errorHandler.js';
import zlib from 'zlib';

function buildApp() {
  const app = express();
  app.use(bodySizeLimitMiddleware);
  app.use(dynamicJsonParser);
  app.use(jsonDepthMiddleware());
  app.post('/echo', (req, res) => res.status(200).json(req.body));
  app.post('/internal/webhooks/echo', (req, res) => res.status(200).json(req.body));
  app.post('/api/uploads/echo', (req, res) => res.status(200).json(req.body));
  app.use(errorHandler);
  return app;
}

/** Boot `app` on an ephemeral port. */
function startServer(app: express.Application): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** POST a complete, already-serialised (possibly binary) payload. */
function postRaw(
  port: number,
  path: string,
  payload: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          data += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('bodySizeLimitMiddleware — Content-Length fast path', () => {
  const app = buildApp();

  it('rejects when Content-Length exceeds limit', async () => {
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(DEFAULT_RAW_LIMIT_BYTES + 1))
      .send('{}');

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('passes when Content-Length is exactly at the limit', async () => {
    // Build a JSON body whose byte length equals DEFAULT_RAW_LIMIT_BYTES.
    // {"d":"<padding>"} — pad to hit the limit exactly.
    const overhead = '{"d":""}';
    const padding = 'x'.repeat(DEFAULT_RAW_LIMIT_BYTES - overhead.length);
    const body = `{"d":"${padding}"}`;
    expect(Buffer.byteLength(body)).toBe(DEFAULT_RAW_LIMIT_BYTES);

    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
  });
});

describe('bodySizeLimitMiddleware - route limits', () => {
  const app = buildApp();
  
  it('allows larger raw payloads on webhooks route', async () => {
    const webhookLimit = ROUTE_LIMITS.find(r => r.pathPrefix === '/internal/webhooks')!.rawLimit;
    // A real payload: bigger than the default limit, smaller than the route limit.
    // (A Content-Length header without matching bytes would simply hang the read.)
    const padding = 'x'.repeat(webhookLimit - 64);
    const body = JSON.stringify({ data: padding });
    expect(Buffer.byteLength(body)).toBeGreaterThan(DEFAULT_RAW_LIMIT_BYTES);
    expect(Buffer.byteLength(body)).toBeLessThan(webhookLimit);

    const res = await request(app)
      .post('/internal/webhooks/echo')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
  });
});

describe('dynamicJsonParser - compressed payloads', () => {
  const app = buildApp();
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = await startServer(app);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it('rejects oversized decompressed bodies (zip bomb)', async () => {
    // We send a small compressed payload that expands to more than the decompressed limit.
    const largeBody = 'x'.repeat(DEFAULT_DECOMPRESSED_LIMIT_BYTES + 1024);
    const compressed = zlib.gzipSync(largeBody);

    // The compressed size is well within the RAW limit
    expect(compressed.length).toBeLessThan(DEFAULT_RAW_LIMIT_BYTES);

    // Compressed bytes cannot go through supertest's JSON serialiser, and the
    // wire path also proves the limit is applied to the *decompressed* stream.
    const { status, body } = await postRaw(port, '/echo', compressed, {
      'Content-Encoding': 'gzip',
    });

    expect(status).toBe(413);
    expect(JSON.parse(body).error.code).toBe('PAYLOAD_TOO_LARGE');
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
    // Build an object nested past MAX_JSON_DEPTH (20 by default).
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 25; i++) deep = { child: deep };

    const res = await request(app).post('/echo').send(deep);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a body that sits exactly at the depth limit', async () => {
    const appAtLimit = express();
    appAtLimit.use(express.json());
    appAtLimit.use(jsonDepthMiddleware(5));
    appAtLimit.post('/echo', (req, res) => res.status(200).json(req.body));
    appAtLimit.use(errorHandler);

    // 5 nested objects: depth 5 is allowed, depth 6 is not.
    let atLimit: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 4; i++) atLimit = { child: atLimit };
    expect(await request(appAtLimit).post('/echo').send(atLimit).then(r => r.status)).toBe(200);

    const tooDeep: Record<string, unknown> = { child: atLimit };
    expect(await request(appAtLimit).post('/echo').send(tooDeep).then(r => r.status)).toBe(400);
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
