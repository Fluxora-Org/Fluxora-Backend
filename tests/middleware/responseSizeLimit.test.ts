/**
 * Response size bounds (#1555).
 *
 * Covers:
 *  - getResponseLimit / bodyByteLength helpers
 *  - responseSizeLimitMiddleware: under-limit bodies pass, over-limit bodies are
 *    replaced with a 500 RESPONSE_TOO_LARGE envelope (JSON, text and Buffer)
 *  - limits resolve from the full path even inside mounted routers
 *  - the largest-response endpoint (GET /internal/webhooks/outbox, unbounded
 *    before #1555) is now paginated and its response stays within the bound
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import {
  DEFAULT_RESPONSE_LIMIT_BYTES,
  RESPONSE_ROUTE_LIMITS,
  bodyByteLength,
  getResponseLimit,
  responseSizeLimitMiddleware,
  responseTooLargeTotal,
} from '../../src/middleware/responseSizeLimit.js';
import { webhooksRouter } from '../../src/routes/webhooks.js';
import { webhookDeliveryStore } from '../../src/webhooks/storeFactory.js';

const OVER_DEFAULT = DEFAULT_RESPONSE_LIMIT_BYTES + 1;

function makeApp() {
  const app = express();
  app.use(responseSizeLimitMiddleware);

  app.get('/small', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  // Large bodies that are allowed through are sent as binary: supertest
  // decodes big text bodies very slowly, which is unrelated to the guard.
  app.get('/exact', (_req: Request, res: Response) => {
    res.type('application/octet-stream').send(Buffer.alloc(DEFAULT_RESPONSE_LIMIT_BYTES, 1));
  });
  app.get('/big-json', (_req: Request, res: Response) => {
    res.json({ items: Array.from({ length: 20_000 }, (_, i) => ({ id: i, pad: 'x'.repeat(64) })) });
  });
  app.get('/big-text', (_req: Request, res: Response) => {
    res.type('text/plain').send('a'.repeat(OVER_DEFAULT));
  });
  app.get('/big-buffer', (_req: Request, res: Response) => {
    res.send(Buffer.alloc(OVER_DEFAULT, 1));
  });
  app.get('/big-multibyte', (_req: Request, res: Response) => {
    // 'é' is 2 bytes in UTF-8: under the limit in characters, over it in bytes.
    res.type('text/plain').send('é'.repeat(DEFAULT_RESPONSE_LIMIT_BYTES / 2 + 1));
  });
  app.get('/streamed', (_req: Request, res: Response) => {
    // res.write() is not buffered through res.send — bounded by the route itself.
    res.write('a'.repeat(OVER_DEFAULT));
    res.end();
  });

  // Mounted router: inside it req.path is "/", but the limit must come from
  // the full "/metrics" path (8 MiB), not the 1 MiB default.
  const metrics = express.Router();
  metrics.get('/', (_req: Request, res: Response) => {
    res.type('application/octet-stream').send(Buffer.alloc(2 * 1024 * 1024, 1));
  });
  app.use('/metrics', metrics);

  const api = express.Router();
  api.get('/', (_req: Request, res: Response) => {
    res.type('text/plain').send('m'.repeat(2 * 1024 * 1024));
  });
  app.use('/api/thing', api);
  return app;
}

async function counterValue(route: string): Promise<number> {
  const metric = await responseTooLargeTotal.get();
  return metric.values.find((v) => v.labels.route === route)?.value ?? 0;
}

describe('response size helpers', () => {
  it('uses the 1 MiB default for ordinary paths', () => {
    expect(DEFAULT_RESPONSE_LIMIT_BYTES).toBe(1024 * 1024);
    expect(getResponseLimit('/api/streams')).toBe(DEFAULT_RESPONSE_LIMIT_BYTES);
    expect(getResponseLimit('/internal/webhooks/metrics')).toBe(DEFAULT_RESPONSE_LIMIT_BYTES);
  });

  it('applies documented per-endpoint overrides to the path and its sub-paths only', () => {
    for (const route of RESPONSE_ROUTE_LIMITS) {
      expect(getResponseLimit(route.pathPrefix)).toBe(route.maxBytes);
      expect(route.reason.length).toBeGreaterThan(0);
    }
    expect(getResponseLimit('/metrics/extra')).toBe(8 * 1024 * 1024);
    expect(getResponseLimit('/metricsXYZ')).toBe(DEFAULT_RESPONSE_LIMIT_BYTES);
    expect(getResponseLimit('/openapi.json')).toBe(2 * 1024 * 1024);
  });

  it('measures strings in UTF-8 bytes and defers unserialised values', () => {
    expect(bodyByteLength('abc')).toBe(3);
    expect(bodyByteLength('é')).toBe(2);
    expect(bodyByteLength(Buffer.alloc(10))).toBe(10);
    expect(bodyByteLength(undefined)).toBe(0);
    expect(bodyByteLength(null)).toBe(0);
    expect(bodyByteLength({ a: 1 })).toBeNull();
    expect(bodyByteLength([1, 2])).toBeNull();
  });
});

describe('responseSizeLimitMiddleware', () => {
  const app = makeApp();

  it('passes small responses through untouched', async () => {
    const res = await request(app).get('/small');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  // Allowed multi-MiB bodies are checked with HEAD: the handler still passes
  // the full body to res.send (so the guard measures it and Express sets
  // Content-Length), but no bytes cross the socket. Downloading MiBs through
  // supertest is slow and flaky on some machines and adds nothing here.

  it('allows a body of exactly the limit (boundary)', async () => {
    const res = await request(app).head('/exact');
    expect(res.status).toBe(200);
    expect(Number(res.headers['content-length'])).toBe(DEFAULT_RESPONSE_LIMIT_BYTES);
  });

  it.each(['/big-json', '/big-text', '/big-buffer', '/big-multibyte'])(
    'replaces an over-limit body on %s with a 500 RESPONSE_TOO_LARGE envelope',
    async (path) => {
      const before = await counterValue(path);
      const res = await request(app).get(path);
      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: `Response exceeded the ${DEFAULT_RESPONSE_LIMIT_BYTES}-byte limit for this endpoint`,
          details: { reason: 'RESPONSE_TOO_LARGE', limitBytes: DEFAULT_RESPONSE_LIMIT_BYTES },
        },
      });
      expect(Buffer.byteLength(res.text)).toBeLessThan(1024);
      expect(await counterValue(path)).toBe(before + 1);
    },
  );

  it('resolves the limit from the full path inside a mounted router', async () => {
    const allowed = await request(app).head('/metrics');
    expect(allowed.status).toBe(200);
    expect(Number(allowed.headers['content-length'])).toBe(2 * 1024 * 1024);

    const blocked = await request(app).get('/api/thing');
    expect(blocked.status).toBe(500);
    expect(blocked.body.error.details.reason).toBe('RESPONSE_TOO_LARGE');
  });

  it('does not interfere with streamed (res.write) responses', async () => {
    const res = await request(app).head('/streamed');
    expect(res.status).toBe(200);
  });

  it('still blocks an over-limit body on HEAD (same guard, no body sent)', async () => {
    const res = await request(app).head('/big-buffer');
    expect(res.status).toBe(500);
  });
});

describe('largest-response endpoint: GET /internal/webhooks/outbox', () => {
  const ADMIN_TOKEN = 'test-admin-key-1555';
  const ITEMS = 250;
  let previousAdminKey: string | undefined;

  function makeOutboxApp() {
    const app = express();
    app.use(responseSizeLimitMiddleware);
    app.use('/internal/webhooks', webhooksRouter);
    return app;
  }

  beforeEach(() => {
    previousAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_TOKEN;
    webhookDeliveryStore.clear();
    const now = Date.now();
    for (let i = 0; i < ITEMS; i++) {
      webhookDeliveryStore.addToOutbox({
        deliveryId: `deliv_${i}`,
        eventId: `evt_${i}`,
        eventType: 'stream.created',
        endpointUrl: `https://example.com/hooks/${i}`,
        payload: JSON.stringify({ i, pad: 'p'.repeat(512) }),
        secret: 'whsec_test',
        priority: 'normal',
        createdAt: now - 1000,
        scheduledFor: now - 1000,
        attempts: 0,
        maxAttempts: 5,
      });
    }
  });

  afterEach(() => {
    webhookDeliveryStore.clear();
    if (previousAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = previousAdminKey;
  });

  const get = (query = '') =>
    request(makeOutboxApp())
      .get(`/internal/webhooks/outbox${query}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

  it('returns at most 100 items by default, with the true total', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(ITEMS);
    expect(res.body.items).toHaveLength(100);
    expect(res.body).toMatchObject({ limit: 100, offset: 0, has_more: true });
  });

  it('keeps the response body within the endpoint byte bound', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(Buffer.byteLength(res.text)).toBeLessThanOrEqual(getResponseLimit('/internal/webhooks/outbox'));
  });

  it('pages through the rest with offset', async () => {
    const res = await get('?limit=100&offset=200');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(50);
    expect(res.body.has_more).toBe(false);
  });

  it('rejects a limit above 100 instead of returning more', async () => {
    const res = await get('?limit=101');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('rejects a non-numeric limit', async () => {
    const res = await get('?limit=all');
    expect(res.status).toBe(400);
  });
});
