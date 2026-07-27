/**
 * Tests for pagination validation on webhook management routes.
 *
 * Covers the following acceptance criteria:
 *  - Non-numeric limit/offset values return a clear 400 instead of a
 *    silently empty/wrong page.
 *  - A maximum page size is enforced server-side regardless of caller input.
 *  - Negative values are rejected with a 400.
 *  - Valid values pass through successfully.
 */

import express from 'express';
import request from 'supertest';
import { webhooksRouter } from '../src/routes/webhooks.js';
import { webhookDeliveryStore } from '../src/webhooks/store.js';
import { MAX_PAGE_LIMIT } from '../src/validation/paginationSchema.js';
import type { WebhookDelivery } from '../src/webhooks/types.js';

function buildApp() {
  const app = express();
  app.use('/internal/webhooks', webhooksRouter);
  return app;
}

function createDelivery(overrides?: Partial<WebhookDelivery>): WebhookDelivery {
  const now = Date.now();
  return {
    id: `delivery_${now}_${Math.random().toString(36).substr(2, 9)}`,
    deliveryId: `deliv_${Math.random().toString(36).substr(2, 9)}`,
    eventId: 'event_test',
    eventType: 'stream.created',
    endpointUrl: 'https://example.com/webhook',
    status: 'delivered',
    attempts: [],
    createdAt: now,
    updatedAt: now,
    payload: '{}',
    ...overrides,
  };
}

describe('GET /internal/webhooks/deliveries — pagination validation', () => {
  const app = buildApp();
  const ENDPOINT = '/internal/webhooks/deliveries';

  beforeEach(() => {
    webhookDeliveryStore.clear();
    // Seed some deliveries so we can test slicing
    for (let i = 0; i < 5; i++) {
      webhookDeliveryStore.store(createDelivery());
    }
  });

  it('returns 400 for non-numeric limit', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('returns 400 for non-numeric offset', async () => {
    const res = await request(app).get(ENDPOINT).query({ offset: 'xyz' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('returns 400 for negative limit', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: '-1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('returns 400 for negative offset', async () => {
    const res = await request(app).get(ENDPOINT).query({ offset: '-5' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('returns 400 for limit exceeding MAX_PAGE_LIMIT', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: String(MAX_PAGE_LIMIT + 1) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('returns 400 for zero limit', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: '0' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('returns 400 for non-integer decimal limit', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: '1.5' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('returns 200 for valid limit and offset (both provided)', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: '3', offset: '1' });
    expect(res.status).toBe(200);
    // deliveries.slice(1, 1 + 3) → indices 1..3 → 3 items
    expect(res.body.deliveries).toHaveLength(3);
  });

  it('returns 200 and uses default limit=100 when limit is omitted', async () => {
    const res = await request(app).get(ENDPOINT);
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(5);
    expect(res.body.total).toBe(5);
  });

  it('returns 200 for limit at MAX_PAGE_LIMIT boundary', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: String(MAX_PAGE_LIMIT) });
    expect(res.status).toBe(200);
  });

  it('returns 200 for offset 0', async () => {
    const res = await request(app).get(ENDPOINT).query({ offset: '0' });
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(5);
  });

  it('returns empty deliveries array for offset beyond total', async () => {
    const res = await request(app).get(ENDPOINT).query({ offset: '100' });
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(0);
  });
});

describe('GET /internal/webhooks/dlq — pagination validation', () => {
  const app = buildApp();
  const ENDPOINT = '/internal/webhooks/dlq';

  function addDlqItem() {
    const delivery = createDelivery({ status: 'permanent_failure' });
    webhookDeliveryStore.addToDeadLetterQueue(delivery, 'Test failure');
  }

  beforeEach(() => {
    webhookDeliveryStore.clear();
    // Seed some DLQ items
    for (let i = 0; i < 3; i++) {
      addDlqItem();
    }
  });

  it('returns 400 for non-numeric limit', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('returns 400 for negative limit', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: '-1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('returns 400 for limit exceeding MAX_PAGE_LIMIT', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: String(MAX_PAGE_LIMIT + 1) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('returns 400 for zero limit', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: '0' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('returns 400 for non-integer decimal limit', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: '2.5' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
  });

  it('returns 200 for valid limit', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: '2' });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  it('returns 200 and uses default limit=50 when limit is omitted', async () => {
    const res = await request(app).get(ENDPOINT);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.total).toBe(3);
  });

  it('returns 200 for limit at MAX_PAGE_LIMIT boundary', async () => {
    const res = await request(app).get(ENDPOINT).query({ limit: String(MAX_PAGE_LIMIT) });
    expect(res.status).toBe(200);
  });

  it('accepts offset query param on dlq route (validated but ignored)', async () => {
    const res = await request(app).get(ENDPOINT).query({ offset: '5' });
    // offset is accepted by the schema but ignored by the route handler
    expect(res.status).toBe(200);
  });
});
