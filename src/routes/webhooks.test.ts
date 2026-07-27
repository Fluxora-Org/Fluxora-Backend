import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { webhooksRouter, setInboundWebhookDedupCache, getInboundWebhookDedupCache } from './webhooks.js';
import { InMemoryDedupCache } from '../redis/dedup.js';
import { computeWebhookSignature } from '../webhooks/signature.js';

function makeApp() {
  const app = express();
  app.use('/internal/webhooks', webhooksRouter);
  return app;
}

describe('POST /internal/webhooks/receive dedup', () => {
  beforeEach(() => {
    process.env.FLUXORA_WEBHOOK_SECRET = 'test-secret';
    setInboundWebhookDedupCache(new InMemoryDedupCache());
  });

  it('bounds memory footprint under sustained unique-delivery-id traffic', async () => {
    const app = makeApp();
    const cache = getInboundWebhookDedupCache() as InMemoryDedupCache;
    
    // InMemoryDedupCache caps at 10,000. We insert 10,005 to test eviction.
    
    // To speed up the test without supertest overhead for 10,000 requests, 
    // we populate 9,998 directly, and then send 7 via the endpoint.
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
    
    // Check that the cache hasn't grown beyond 10,000
    const internalMap = (cache as any).seen as Map<string, true>;
    expect(internalMap.size).toBeLessThanOrEqual(10000);
    expect(internalMap.size).toBe(10000); // It should be exactly 10000
    
    // Verify duplicate returns 409
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
});
