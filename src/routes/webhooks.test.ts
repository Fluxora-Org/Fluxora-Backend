import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { webhooksRouter, setInboundWebhookDedupCache, getInboundWebhookDedupCache } from './webhooks.js';
import { InMemoryDedupCache } from '../redis/dedup.js';
import { computeWebhookSignature } from '../webhooks/signature.js';
import { webhookDeliveryStore } from '../webhooks/storeFactory.js';

function makeApp() {
  const app = express();
  app.use('/api/webhooks', webhooksRouter);
  app.use('/internal/webhooks', webhooksRouter);
  return app;
}

const ADMIN_TOKEN = 'test-admin-key';

describe('Webhooks Route Early-Return Safeguards & Error Paths', () => {
  beforeEach(() => {
    process.env.FLUXORA_WEBHOOK_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = ADMIN_TOKEN;
    setInboundWebhookDedupCache(new InMemoryDedupCache());
  });

  describe('POST /internal/webhooks/receive', () => {
    it('bounds memory footprint under sustained unique-delivery-id traffic', async () => {
      const app = makeApp();
      const cache = getInboundWebhookDedupCache() as InMemoryDedupCache;

      for (let i = 0; i < 9998; i++) {
        await cache.add('webhook', `deliv_pre_${i}`);
      }

      for (let i = 0; i < 7; i++) {
        const deliveryId = `deliv_${i}`;
        const payload = '{}';
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = computeWebhookSignature('test-secret', timestamp, payload);

        const res = await request(app)
          .post('/internal/webhooks/receive')
          .set('x-fluxora-delivery-id', deliveryId)
          .set('x-fluxora-timestamp', timestamp)
          .set('x-fluxora-signature', signature)
          .set('x-fluxora-event', 'test.event')
          .set('Content-Type', 'application/json')
          .send(payload);

        expect(res.status).toBe(200);
      }

      const internalMap = (cache as any).seen as Map<string, true>;
      expect(internalMap.size).toBe(10000);

      const payload = '{}';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = computeWebhookSignature('test-secret', timestamp, payload);
      const resDup = await request(app)
        .post('/internal/webhooks/receive')
        .set('x-fluxora-delivery-id', 'deliv_0')
        .set('x-fluxora-timestamp', timestamp)
        .set('x-fluxora-signature', signature)
        .set('x-fluxora-event', 'test.event')
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(resDup.status).toBe(409);
      expect(resDup.body.error).toBe('duplicate_delivery');
    });

    it('returns early on verification failure without adding to dedup cache', async () => {
      const app = makeApp();
      const cache = getInboundWebhookDedupCache();

      const res = await request(app)
        .post('/internal/webhooks/receive')
        .set('x-fluxora-delivery-id', 'deliv_bad')
        .set('x-fluxora-timestamp', '12345')
        .set('x-fluxora-signature', 'invalid-sig')
        .send('{}');

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
      // Verify dedup cache was NOT populated
      const isNew = await cache.add('webhook', 'deliv_bad');
      expect(isNew).toBe(true);
    });
  });

  describe('POST /queue', () => {
    it('returns 400 early on missing required fields and does not add item to outbox', async () => {
      const app = makeApp();
      const initialOutboxLength = webhookDeliveryStore.getAllOutboxItems().length;

      const res = await request(app)
        .post('/api/webhooks/queue')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send({
          event: { id: 'evt_1', type: 'user.created' },
          // endpointUrl missing!
          secret: 'secret',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');

      // Verify no outbox item was created
      const currentOutboxLength = webhookDeliveryStore.getAllOutboxItems().length;
      expect(currentOutboxLength).toBe(initialOutboxLength);
    });
  });

  describe('GET /deliveries/:deliveryId', () => {
    it('returns 404 early on non-existent deliveryId', async () => {
      const app = makeApp();

      const res = await request(app)
        .get('/api/webhooks/deliveries/deliv_non_existent')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('DELIVERY_NOT_FOUND');
    });
  });

  describe('GET /deliveries', () => {
    it('returns 400 early on invalid pagination parameters', async () => {
      const app = makeApp();

      const res = await request(app)
        .get('/api/webhooks/deliveries?limit=-5')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGINATION');
    });
  });

  describe('GET /dlq', () => {
    it('returns 400 early on invalid pagination parameters', async () => {
      const app = makeApp();

      const res = await request(app)
        .get('/api/webhooks/dlq?limit=invalid')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAGINATION');
    });
  });

  describe('POST /dlq/:dlqId/retry', () => {
    it('returns 404 early on non-existent dlqId without modifying outbox', async () => {
      const app = makeApp();
      const initialOutboxLength = webhookDeliveryStore.getAllOutboxItems().length;

      const res = await request(app)
        .post('/api/webhooks/dlq/non_existent_dlq_id/retry')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('DLQ_ITEM_NOT_FOUND');

      const currentOutboxLength = webhookDeliveryStore.getAllOutboxItems().length;
      expect(currentOutboxLength).toBe(initialOutboxLength);
    });
  });

  describe('POST /verify', () => {
    it('returns error response early without sending duplicate headers or crashing with ERR_HTTP_HEADERS_SENT', async () => {
      const app = makeApp();

      const res = await request(app)
        .post('/api/webhooks/verify')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        // Missing secret and signature headers will cause verification failure
        .send({});

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toHaveProperty('code');
    });
  });
});
