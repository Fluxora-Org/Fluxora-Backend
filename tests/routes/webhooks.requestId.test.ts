import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { webhooksRouter } from '../../src/routes/webhooks.js';

const ADMIN_KEY = 'test-admin-key-requestid-1872';
const BASE = '/internal/webhooks';
const CORR_ID = 'test-correlation-id-1872';

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).correlationId = CORR_ID;
    next();
  });
  app.use(BASE, webhooksRouter);
  return app;
}

const app = buildApp();
const authed = (r: request.Test) => r.set('Authorization', `Bearer ${ADMIN_KEY}`);

describe('webhooks requestId envelopes (#1872)', () => {
  let prevKey: string | undefined;

  beforeEach(() => {
    prevKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevKey;
  });

  it('GET /outbox returns 200 with meta.requestId', async () => {
    const res = await authed(request(app).get(`${BASE}/outbox`));
    expect(res.status).toBe(200);
    expect(res.body.meta?.requestId).toBe(CORR_ID);
  });

  it('GET /dlq returns 200 with meta.requestId', async () => {
    const res = await authed(request(app).get(`${BASE}/dlq`));
    expect(res.status).toBe(200);
    expect(res.body.meta?.requestId).toBe(CORR_ID);
  });

  it('POST /cleanup returns 200 with meta.requestId', async () => {
    const res = await authed(request(app).post(`${BASE}/cleanup`).send({ olderThanDays: 7 }));
    expect(res.status).toBe(200);
    expect(res.body.meta?.requestId).toBe(CORR_ID);
  });

  it('POST /retry error includes the correlation id', async () => {
    const res = await authed(request(app).post(`${BASE}/retry`).send({ secret: 123 }));
    expect(res.status).toBe(400);
    expect(res.body.error?.requestId).toBe('test-correlation-id-1872');
  });
});
