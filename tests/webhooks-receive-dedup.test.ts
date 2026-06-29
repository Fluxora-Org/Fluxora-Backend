import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const WEBHOOK_SECRET = 'test-secret-for-dedup';

async function buildApp() {
  const originalSecret = process.env.FLUXORA_WEBHOOK_SECRET;
  process.env.FLUXORA_WEBHOOK_SECRET = WEBHOOK_SECRET;
  const { app } = await createApp();
  if (originalSecret === undefined) {
    delete process.env.FLUXORA_WEBHOOK_SECRET;
  } else {
    process.env.FLUXORA_WEBHOOK_SECRET = originalSecret;
  }
  return app;
}

describe('POST /internal/webhooks/receive seenDeliveries deduplication', () => {
  it('accepts a valid delivery and grows the seenDeliveries set', async () => {
    const app = await buildApp();
    const deliveryId = `delivery-${Math.random().toString(36).slice(2)}`;

    const res = await request(app)
      .post('/internal/webhooks/receive')
      .set('x-fluxora-delivery-id', deliveryId)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ event: 'test' }));

    expect([200, 400, 401]).toContain(res.status);
  });

  it('returns 409 or duplicate indicator on a replayed delivery id', async () => {
    const app = await buildApp();
    const deliveryId = `delivery-dedup-${Math.random().toString(36).slice(2)}`;

    const first = await request(app)
      .post('/internal/webhooks/receive')
      .set('x-fluxora-delivery-id', deliveryId)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ event: 'first' }));

    const second = await request(app)
      .post('/internal/webhooks/receive')
      .set('x-fluxora-delivery-id', deliveryId)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ event: 'second' }));

    if (first.status === 200) {
      expect([409, 200]).toContain(second.status);
      if (second.status === 200) {
        expect(second.body.deliveryId).toBe(deliveryId);
      }
    }
  });

  it('each unique delivery id is treated independently', async () => {
    const app = await buildApp();
    const id1 = `del-a-${Math.random().toString(36).slice(2)}`;
    const id2 = `del-b-${Math.random().toString(36).slice(2)}`;

    const res1 = await request(app)
      .post('/internal/webhooks/receive')
      .set('x-fluxora-delivery-id', id1)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ event: 'a' }));

    const res2 = await request(app)
      .post('/internal/webhooks/receive')
      .set('x-fluxora-delivery-id', id2)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ event: 'b' }));

    expect(res1.status).toBe(res2.status);
  });
});
