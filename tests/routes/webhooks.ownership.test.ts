import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { webhooksRouter } from '../../src/routes/webhooks.js';
import { webhookDeliveryStore } from '../../src/webhooks/storeFactory.js';
import { MAX_PAGE_LIMIT } from '../../src/validation/paginationSchema.js';

const ADMIN_KEY = 'test-admin-key-webhook-ownership-1542';
const BASE = '/internal/webhooks';

function buildApp() {
  const app = express();
  app.use(BASE, webhooksRouter);
  return app;
}

function withAdmin(req: request.Test) {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

const app = buildApp();

beforeEach(() => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  webhookDeliveryStore.clear();
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

describe('webhook management ownership guard', () => {
  const protectedRoutes = [
    ['get', '/deliveries'],
    ['get', '/deliveries/missing'],
    ['get', '/outbox'],
    ['get', '/dlq'],
    ['get', '/circuit-breakers'],
    ['get', '/metrics'],
    ['post', '/queue'],
    ['post', '/dlq/missing/retry'],
    ['post', '/circuit-breakers/https%3A%2F%2Fexample.com/reset'],
    ['post', '/verify'],
    ['post', '/process-outbox'],
    ['post', '/retry'],
    ['post', '/cleanup'],
  ] as const;

  it.each(protectedRoutes)(
    '%s %s rejects missing credentials with the auth error shape',
    async (method, path) => {
      const res = await request(app)
        [method](`${BASE}${path}`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: expect.any(String) });
    }
  );

  it.each(protectedRoutes)(
    '%s %s rejects another account credential with the auth error shape',
    async (method, path) => {
      const res = await request(app)
        [method](`${BASE}${path}`)
        .set('Authorization', 'Bearer another-account-key')
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Invalid admin credentials.' });
    }
  );
});

describe('webhook management input contracts', () => {
  it('rejects malformed queue payloads', async () => {
    const res = await withAdmin(request(app).post(`${BASE}/queue`))
      .set('Content-Type', 'application/json')
      .send({ event: {}, endpointUrl: 'https://example.com', secret: 'secret' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Missing required fields: event, endpointUrl, secret',
      },
    });
  });

  it('rejects invalid outbox filters', async () => {
    const res = await withAdmin(request(app).get(`${BASE}/outbox`)).query({ status: 'unknown' });

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'INVALID_OUTBOX_FILTER',
      message: 'priority or status filter is invalid',
    });
  });

  it('accepts the maximum delivery page size and rejects the next value', async () => {
    const valid = await withAdmin(request(app).get(`${BASE}/deliveries`)).query({
      limit: String(MAX_PAGE_LIMIT),
      offset: '0',
    });
    const invalid = await withAdmin(request(app).get(`${BASE}/deliveries`)).query({
      limit: String(MAX_PAGE_LIMIT + 1),
    });

    expect(valid.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('applies the DLQ offset boundary', async () => {
    const res = await withAdmin(request(app).get(`${BASE}/dlq`)).query({ limit: '1', offset: '1' });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('rejects a non-string DLQ retry secret', async () => {
    const res = await withAdmin(request(app).post(`${BASE}/dlq/missing/retry`))
      .set('Content-Type', 'application/json')
      .send({ secret: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RETRY_REQUEST');
  });

  it('rejects malformed circuit-breaker endpoint input', async () => {
    const query = await withAdmin(request(app).get(`${BASE}/circuit-breakers`)).query({
      'endpointUrl[]': 'https://example.com',
    });
    const reset = await withAdmin(request(app).post(`${BASE}/circuit-breakers/not-a-url/reset`));

    expect(query.status).toBe(400);
    expect(query.body.error.code).toBe('INVALID_ENDPOINT_URL');
    expect(reset.status).toBe(400);
    expect(reset.body.error.code).toBe('INVALID_ENDPOINT_URL');
  });

  it('rejects malformed retry and cleanup payloads', async () => {
    const retry = await withAdmin(request(app).post(`${BASE}/retry`))
      .set('Content-Type', 'application/json')
      .send({ secret: 123 });
    const cleanup = await withAdmin(request(app).post(`${BASE}/cleanup`))
      .set('Content-Type', 'application/json')
      .send({ olderThanDays: 1.5 });

    expect(retry.status).toBe(400);
    expect(retry.body.error.code).toBe('INVALID_RETRY_REQUEST');
    expect(cleanup.status).toBe(400);
    expect(cleanup.body.error.code).toBe('INVALID_CLEANUP_REQUEST');
  });
});
