import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { webhooksRouter } from '../../src/routes/webhooks.js';
import {
  computeWebhookSignature,
} from '../../src/webhooks/signature.js';
import { webhookDeliveryStore } from '../../src/webhooks/storeFactory.js';
import { DEFAULT_WEBHOOK_SECRET_ID } from '../../src/db/repositories/webhookSecretRepository.js';

const mockQuery = vi.fn();
vi.mock('../../src/db/pool.js', () => ({
  getPool: vi.fn(() => ({})),
  query: (...args: unknown[]) => mockQuery(...args),
}));

const BASE = '/internal/webhooks';
const OLD_SECRET = 'old-webhook-secret';
const NEW_SECRET = 'new-webhook-secret';
const ENV_SECRET = 'env-webhook-secret';
const ROTATED_AT = 1_710_000_000;
const EXPIRES_AT = ROTATED_AT + 600;
const BODY = JSON.stringify({ event: 'stream.created', streamId: 'rotation-test' });

const app = express();
app.use(BASE, webhooksRouter);

function makeRequest(secret: string, timestamp: number, deliveryId: string) {
  const timestampHeader = timestamp.toString();
  return request(app)
    .post(`${BASE}/receive`)
    .set('Content-Type', 'application/json')
    .set('x-fluxora-delivery-id', deliveryId)
    .set('x-fluxora-timestamp', timestampHeader)
    .set('x-fluxora-signature', computeWebhookSignature(secret, timestampHeader, BODY))
    .set('x-fluxora-event', 'stream.created')
    .send(BODY);
}

function rotationState() {
  return {
    id: DEFAULT_WEBHOOK_SECRET_ID,
    current_secret: NEW_SECRET,
    previous_secret: OLD_SECRET,
    previous_secret_rotated_at: ROTATED_AT,
    previous_secret_expires_at: EXPIRES_AT,
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    updated_at: new Date('2024-01-01T00:00:00.000Z'),
  };
}

describe('POST /internal/webhooks/receive with rotated secrets', () => {
  const originalSecret = process.env.FLUXORA_WEBHOOK_SECRET;
  const originalPrevious = process.env.FLUXORA_WEBHOOK_SECRET_PREVIOUS;
  const originalNow = Date.now;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FLUXORA_WEBHOOK_SECRET = ENV_SECRET;
    delete process.env.FLUXORA_WEBHOOK_SECRET_PREVIOUS;
    webhookDeliveryStore.clear();
    Date.now = vi.fn(() => (ROTATED_AT + 300) * 1000);
  });

  afterEach(() => {
    Date.now = originalNow;
    if (originalSecret === undefined) delete process.env.FLUXORA_WEBHOOK_SECRET;
    else process.env.FLUXORA_WEBHOOK_SECRET = originalSecret;
    if (originalPrevious === undefined) delete process.env.FLUXORA_WEBHOOK_SECRET_PREVIOUS;
    else process.env.FLUXORA_WEBHOOK_SECRET_PREVIOUS = originalPrevious;
  });

  it('accepts old and new signatures during the configured overlap window', async () => {
    mockQuery.mockResolvedValue({ rows: [rotationState()] });

    const oldResponse = await makeRequest(OLD_SECRET, ROTATED_AT + 300, 'rotation-old');
    const newResponse = await makeRequest(NEW_SECRET, ROTATED_AT + 300, 'rotation-new');

    expect(oldResponse.status).toBe(200);
    expect(newResponse.status).toBe(200);
  });

  it('rejects the old signature after expiry while accepting the new signature', async () => {
    mockQuery.mockResolvedValue({ rows: [rotationState()] });
    const AFTER_EXPIRY = EXPIRES_AT + 1;
    Date.now = vi.fn(() => AFTER_EXPIRY * 1000);

    const oldResponse = await makeRequest(OLD_SECRET, AFTER_EXPIRY, 'expired-old');
    const newResponse = await makeRequest(NEW_SECRET, AFTER_EXPIRY, 'expired-new');

    expect(oldResponse.status).toBe(401);
    expect(oldResponse.body.error).toBe('previous_secret_expired');
    expect(newResponse.status).toBe(200);
  });

  it('falls back to the environment secret when no rotation row exists', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const response = await makeRequest(ENV_SECRET, ROTATED_AT + 300, 'env-fallback');

    expect(response.status).toBe(200);
  });

  it('falls back to the environment secret when the repository lookup fails', async () => {
    mockQuery.mockRejectedValue(new Error('relation webhook_secrets does not exist'));

    const response = await makeRequest(ENV_SECRET, ROTATED_AT + 300, 'error-fallback');

    expect(response.status).toBe(200);
  });

  it('uses the repository overlap duration instead of the verifier default', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          ...rotationState(),
          previous_secret_expires_at: ROTATED_AT + 1,
        },
      ],
    });
    Date.now = vi.fn(() => (ROTATED_AT + 2) * 1000);

    const response = await makeRequest(OLD_SECRET, ROTATED_AT + 2, 'custom-window-expired');

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('previous_secret_expired');
  });
});
