/**
 * Streaming guard tests for src/middleware/requestProtection.ts (#1468).
 *
 * The property under test is temporal: a limit must be enforced *while* the
 * request body is being read, not after it has been buffered. A check that runs
 * after `express.json()` has materialised the payload protects nothing, because
 * the memory has already been spent by the time the refusal happens.
 *
 * Every test here therefore measures two things:
 *   1. the client receives a prompt, well-formed refusal (413 / 400), and
 *   2. the number of body bytes that were actually read by anything downstream
 *      of the guard stays bounded by the limit — i.e. the rest of the payload
 *      is never pulled into memory.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_RAW_LIMIT_BYTES,
  bodySizeLimitMiddleware,
  dynamicJsonParser,
  jsonDepthLimitMiddleware,
  jsonDepthMiddleware,
} from '../src/middleware/requestProtection.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { createApp } from '../src/app.js';
import { requestBodyTooLargeTotal, requestBodyTooDeepTotal } from '../src/metrics/requestProtectionMetrics.js';

const CHUNK_SIZE = 64 * 1024;

interface RawResponse {
  status: number;
  body: string;
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

/**
 * POST a body to `port` **without** a Content-Length, so Node uses chunked
 * transfer encoding: the server has no way to know the size up front and can
 * only rely on counting bytes as they arrive. The body is written in
 * `chunkSize` pieces and writing stops as soon as the server answers, which
 * keeps the client side bounded too.
 */
function postChunked(
  port: number,
  path: string,
  chunk: Buffer,
  chunkCount: number,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = 0;

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          data += c;
        });
        res.on('end', () => {
          settled = true;
          resolve({ status: res.statusCode ?? 0, body: data });
        });
      },
    );

    // The server tears the connection down once the refusal has been flushed,
    // so write errors after the response arrived are expected.
    req.on('error', (err) => {
      if (!settled) reject(err);
    });

    const writeNext = (): void => {
      if (settled || req.writableEnded) return;
      if (sent >= chunkCount) {
        req.end();
        return;
      }
      sent += 1;
      req.write(chunk, () => setImmediate(writeNext));
    };
    writeNext();
  });
}

/** POST a complete, already-serialised payload (used for binary bodies). */
function postRaw(
  port: number,
  path: string,
  payload: Buffer,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
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

describe('request protection limits are enforced while the body is read', () => {
  /** Bytes any downstream consumer of the request stream actually observed. */
  let downstreamBytes = 0;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    app.use(bodySizeLimitMiddleware);
    // Everything registered after the guard is, by definition, downstream of
    // the refusal point: if a limit is only applied after the body was read,
    // this counter would reach the full payload size.
    app.use((req, _res, next) => {
      req.on('data', (c: Buffer) => {
        downstreamBytes += c.length;
      });
      next();
    });
    app.use(jsonDepthLimitMiddleware(20));
    app.use(dynamicJsonParser);
    app.use(jsonDepthMiddleware(20));
    app.post('/echo', (_req, res) => res.status(200).json({ ok: true }));
    app.use(errorHandler);

    server = await startServer(app);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await closeServer(server);
  });

  beforeEach(() => {
    downstreamBytes = 0;
    requestBodyTooLargeTotal.reset();
    requestBodyTooDeepTotal.reset();
  });

  it('refuses an oversized chunked body before it is fully buffered', async () => {
    const chunk = Buffer.alloc(CHUNK_SIZE, 0x61); // "a"
    const chunkCount = 64; // 4 MiB, 16x the limit
    const totalBytes = CHUNK_SIZE * chunkCount;

    const startedAt = Date.now();
    const res = await postChunked(port, '/echo', chunk, chunkCount);
    const elapsedMs = Date.now() - startedAt;

    // 1. The refusal is prompt and well formed — the client gets a real
    //    413 response, not a connection reset.
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(elapsedMs).toBeLessThan(5_000);

    // 2. The rest of the payload was never buffered: what got through is
    //    bounded by the limit (plus at most the chunk in flight), not by the
    //    size the client was willing to send.
    expect(downstreamBytes).toBeGreaterThan(0);
    expect(downstreamBytes).toBeLessThanOrEqual(DEFAULT_RAW_LIMIT_BYTES + CHUNK_SIZE);
    expect(downstreamBytes).toBeLessThan(totalBytes);
  });

  it('keeps memory bounded when the body is far above the limit', async () => {
    const chunk = Buffer.alloc(CHUNK_SIZE, 0x62); // "b"
    const chunkCount = 512; // 32 MiB against a 256 KiB limit

    const before = process.memoryUsage().heapUsed;
    const res = await postChunked(port, '/echo', chunk, chunkCount);
    const growth = process.memoryUsage().heapUsed - before;

    expect(res.status).toBe(413);
    // 32 MiB streamed in, at most ~one limit + one chunk retained.
    expect(downstreamBytes).toBeLessThanOrEqual(DEFAULT_RAW_LIMIT_BYTES + CHUNK_SIZE);
    // Generous ceiling: it is here to catch "we buffered the whole upload",
    // not to measure the allocator.
    expect(growth).toBeLessThan(16 * 1024 * 1024);
  });

  it('records the refusal in fluxora_request_body_too_large_total', async () => {
    const chunk = Buffer.alloc(CHUNK_SIZE, 0x63); // "c"
    await postChunked(port, '/echo', chunk, 32);

    const values = await requestBodyTooLargeTotal.get();
    const total = values.values.reduce((acc, v) => acc + v.value, 0);
    expect(total).toBe(1);
  });

  it('refuses deeply nested JSON before the body is fully read', async () => {
    // 30 levels of nesting against a limit of 20, padded out to 2 MiB so a
    // post-parse check would be visibly too late.
    const depth = 30;
    const nested = `{"a":${'{"a":'.repeat(depth)}"leaf"${'}'.repeat(depth)}}`;
    const padding = 'x'.repeat(2 * 1024 * 1024);
    const payload = Buffer.from(`${nested}${' '.repeat(64)}/*${padding}*/`);
    const chunkCount = Math.ceil(payload.length / CHUNK_SIZE);

    const res = await postChunked(port, '/echo', payload, chunkCount);

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    // The guard fired on the first chunk, so almost nothing was read.
    expect(downstreamBytes).toBeLessThanOrEqual(CHUNK_SIZE);
  });

  it('records the depth refusal in fluxora_request_body_too_deep_total', async () => {
    const depth = 30;
    const nested = `{"a":${'{"a":'.repeat(depth)}"leaf"${'}'.repeat(depth)}}`;
    const res = await postChunked(port, '/echo', Buffer.from(nested), 1);

    expect(res.status).toBe(400);
    const values = await requestBodyTooDeepTotal.get();
    const total = values.values.reduce((acc, v) => acc + v.value, 0);
    expect(total).toBe(1);
  });

  it('passes a body that stays within both limits through untouched', async () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const res = await postChunked(port, '/echo', body, 1);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(downstreamBytes).toBe(body.length);
  });
});

describe('request protection is wired into the application', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    // The real app must apply both guards: the size guard and the depth guard
    // in front of express.json(), and the post-parse depth check behind it.
    server = await startServer(createApp());
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it('rejects an oversized body with 413', async () => {
    const res = await postRaw(port, '/api/streams', Buffer.alloc(DEFAULT_RAW_LIMIT_BYTES + 1, 0x64));

    expect(res.status).toBe(413);
  });

  it('rejects a deeply nested body with 400', async () => {
    const depth = 40;
    const nested = `{"child":${'{"child":'.repeat(depth)}"leaf"${'}'.repeat(depth)}}`;

    const res = await postRaw(port, '/api/streams', Buffer.from(nested));

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('VALIDATION_ERROR');
  });
});
