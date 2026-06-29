/**
 * Tests for the fluxora_request_body_too_large_total metric counter.
 *
 * Verifies that:
 *  - The counter increments exactly once per 413 rejection (Content-Length fast path)
 *  - The counter is NOT incremented for accepted requests
 *  - The path label uses a normalized route, not the raw URL
 *  - Multiple rejections on different paths produce independent label combinations
 */

import express from 'express';
import request from 'supertest';
import {
  bodySizeLimitMiddleware,
  BODY_LIMIT_BYTES,
} from '../../src/middleware/requestProtection.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import {
  requestBodyTooLargeTotal,
  deRegisterRequestProtectionMetrics,
} from '../../src/metrics/requestProtectionMetrics.js';

// Re-create the counter for each test suite run to avoid state leaking across
// files when vitest runs tests in the same process.
beforeEach(() => {
  deRegisterRequestProtectionMetrics();
});

afterEach(() => {
  deRegisterRequestProtectionMetrics();
});

async function getCounterValue(path: string): Promise<number> {
  const values = await requestBodyTooLargeTotal.get();
  const entry = values.values.find((v) => v.labels['path'] === path);
  return entry?.value ?? 0;
}

describe('fluxora_request_body_too_large_total counter', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(bodySizeLimitMiddleware);
    app.use(express.json());
    app.post('/api/streams', (_req, res) => res.status(201).json({ ok: true }));
    app.post('/api/webhooks', (_req, res) => res.status(200).json({ ok: true }));
    app.use(errorHandler);
  });

  describe('counter increments on rejection', () => {
    it('increments once when Content-Length exceeds the limit', async () => {
      const oversizedBody = 'x'.repeat(BODY_LIMIT_BYTES + 1);

      await request(app)
        .post('/api/streams')
        .set('Content-Type', 'application/json')
        .set('Content-Length', String(oversizedBody.length))
        .send(oversizedBody)
        .expect(413);

      const count = await getCounterValue('/api/streams');
      expect(count).toBe(1);
    });

    it('increments only once even for repeated rejections on the same path', async () => {
      const oversizedBody = 'y'.repeat(BODY_LIMIT_BYTES + 100);

      await request(app)
        .post('/api/streams')
        .set('Content-Type', 'application/json')
        .set('Content-Length', String(oversizedBody.length))
        .send(oversizedBody)
        .expect(413);

      await request(app)
        .post('/api/streams')
        .set('Content-Type', 'application/json')
        .set('Content-Length', String(oversizedBody.length))
        .send(oversizedBody)
        .expect(413);

      const count = await getCounterValue('/api/streams');
      expect(count).toBe(2);
    });

    it('tracks different paths independently', async () => {
      const oversizedBody = 'z'.repeat(BODY_LIMIT_BYTES + 1);

      await request(app)
        .post('/api/streams')
        .set('Content-Type', 'application/json')
        .set('Content-Length', String(oversizedBody.length))
        .send(oversizedBody)
        .expect(413);

      await request(app)
        .post('/api/webhooks')
        .set('Content-Type', 'application/json')
        .set('Content-Length', String(oversizedBody.length))
        .send(oversizedBody)
        .expect(413);

      const streamsCount = await getCounterValue('/api/streams');
      const webhooksCount = await getCounterValue('/api/webhooks');

      expect(streamsCount).toBe(1);
      expect(webhooksCount).toBe(1);
    });
  });

  describe('counter does NOT increment for accepted requests', () => {
    it('does not increment when body is within the size limit', async () => {
      const smallBody = JSON.stringify({ data: 'small payload' });

      const res = await request(app)
        .post('/api/streams')
        .set('Content-Type', 'application/json')
        .send(smallBody);

      // 201 from the route handler means the request was accepted
      expect(res.status).toBe(201);

      const count = await getCounterValue('/api/streams');
      expect(count).toBe(0);
    });

    it('does not increment when Content-Length exactly equals the limit', async () => {
      // Content-Length == BODY_LIMIT_BYTES should pass (limit is strict >)
      const exactBody = Buffer.alloc(BODY_LIMIT_BYTES).fill(32).toString();

      await request(app)
        .post('/api/streams')
        .set('Content-Type', 'application/json')
        .set('Content-Length', String(BODY_LIMIT_BYTES))
        .send(exactBody);

      // We don't assert status here because express.json may reject invalid JSON;
      // what matters is the counter stays at zero.
      const count = await getCounterValue('/api/streams');
      expect(count).toBe(0);
    });
  });

  describe('path label normalization', () => {
    it('uses req.path as the label (not raw originalUrl with query string)', async () => {
      const oversizedBody = 'q'.repeat(BODY_LIMIT_BYTES + 1);

      await request(app)
        .post('/api/streams')
        .query({ foo: 'bar' })
        .set('Content-Type', 'application/json')
        .set('Content-Length', String(oversizedBody.length))
        .send(oversizedBody)
        .expect(413);

      // Counter should be keyed on '/api/streams', NOT '/api/streams?foo=bar'
      const countNormalized = await getCounterValue('/api/streams');
      const countWithQuery = await getCounterValue('/api/streams?foo=bar');

      expect(countNormalized).toBe(1);
      expect(countWithQuery).toBe(0);
    });
  });
});
