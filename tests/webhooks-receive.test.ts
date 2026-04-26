/**
 * Tests for POST /internal/webhooks/receive
 *
 * Covers the six failure modes documented in the webhook verification contract
 * plus the happy path.
 */

import express from 'express';
import request from 'supertest';
import { webhooksRouter } from '../src/routes/webhooks.js';
import { webhookDeliveryStore } from '../src/webhooks/store.js';
import { computeWebhookSignature } from '../src/webhooks/signature.js';

const SECRET = 'test-webhook-secret-abc123';
const ENDPOINT = '/internal/webhooks/receive';

/** Minimal app that only mounts the webhooks router — avoids pulling in
 *  unrelated routes that have pre-existing TypeScript errors. */
function buildApp() {
  const app = express();
  app.use('/internal/webhooks', webhooksRouter);
  return app;
}

function makeHeaders(overrides: Record<string, string> = {}) {
  const now = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ event: 'stream.created', streamId: 'stream-1' });
  const sig = computeWebhookSignature(SECRET, now, body);
  return {
    body,
    headers: {
      'x-fluxora-delivery-id': 'deliv-test-001',
      'x-fluxora-timestamp': now,
      'x-fluxora-signature': sig,
      'x-fluxora-event': 'stream.created',
      ...overrides,
    },
  };
}

describe('POST /internal/webhooks/receive', () => {
  const app = buildApp();

  beforeEach(() => {
    process.env['FLUXORA_WEBHOOK_SECRET'] = SECRET;
    webhookDeliveryStore.clear();
  });

  afterEach(() => {
    delete process.env['FLUXORA_WEBHOOK_SECRET'];
  });

  it('accepts a valid delivery and echoes the event', async () => {
    const { body, headers } = makeHeaders();

    const res = await request(app)
      .post(ENDPOINT)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deliveryId).toBe(headers['x-fluxora-delivery-id']);
    expect(res.body.eventType).toBe('stream.created');
    expect(res.body.event).toMatchObject({ event: 'stream.created' });
  });

  it('rejects when x-fluxora-delivery-id is missing (401)', async () => {
    const { body, headers } = makeHeaders();
    delete (headers as Record<string, string>)['x-fluxora-delivery-id'];

    const res = await request(app)
      .post(ENDPOINT)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_delivery_id');
  });

  it('rejects when x-fluxora-timestamp is missing (401)', async () => {
    const { body, headers } = makeHeaders();
    delete (headers as Record<string, string>)['x-fluxora-timestamp'];

    const res = await request(app)
      .post(ENDPOINT)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_timestamp');
  });

  it('rejects when x-fluxora-signature is missing (401)', async () => {
    const { body, headers } = makeHeaders();
    delete (headers as Record<string, string>)['x-fluxora-signature'];

    const res = await request(app)
      .post(ENDPOINT)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_signature');
  });

  it('rejects a stale timestamp (401)', async () => {
    const staleTs = (Math.floor(Date.now() / 1000) - 400).toString(); // > 300s tolerance
    const body = JSON.stringify({ event: 'stream.created' });
    const sig = computeWebhookSignature(SECRET, staleTs, body);

    const res = await request(app)
      .post(ENDPOINT)
      .set({
        'x-fluxora-delivery-id': 'deliv-stale',
        'x-fluxora-timestamp': staleTs,
        'x-fluxora-signature': sig,
        'x-fluxora-event': 'stream.created',
        'Content-Type': 'application/json',
      })
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('timestamp_outside_tolerance');
  });

  it('rejects a signature mismatch (401)', async () => {
    const { body, headers } = makeHeaders({ 'x-fluxora-signature': 'deadbeef'.repeat(8) });

    const res = await request(app)
      .post(ENDPOINT)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('signature_mismatch');
  });

  it('rejects a duplicate delivery id (409)', async () => {
    const { body, headers } = makeHeaders();

    // First delivery succeeds
    await request(app)
      .post(ENDPOINT)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body);

    // Second delivery with same id is rejected
    const res = await request(app)
      .post(ENDPOINT)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate_delivery');
  });

  it('rejects an oversized payload (413)', async () => {
    const oversizedBody = 'x'.repeat(256 * 1024 + 1);
    const now = Math.floor(Date.now() / 1000).toString();
    const sig = computeWebhookSignature(SECRET, now, oversizedBody);

    const res = await request(app)
      .post(ENDPOINT)
      .set({
        'x-fluxora-delivery-id': 'deliv-big',
        'x-fluxora-timestamp': now,
        'x-fluxora-signature': sig,
        'x-fluxora-event': 'stream.created',
        'Content-Type': 'application/octet-stream',
      })
      .send(oversizedBody);

    expect(res.status).toBe(413);
  });
});
