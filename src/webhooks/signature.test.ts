import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_WEBHOOK_BODY_BYTES,
  buildWebhookSigningPayload,
  computeWebhookSignature,
  verifyWebhookSignature,
} from './signature.js';

test('buildWebhookSigningPayload preserves the exact raw body', () => {
  const payload = buildWebhookSigningPayload('1710000000', '{"ok":true}\n');
  assert.equal(payload.toString('utf8'), '1710000000.{"ok":true}\n');
});

test('computeWebhookSignature returns a stable HMAC-SHA256 digest', () => {
  const digest = computeWebhookSignature('topsecret', '1710000000', '{"event":"stream.updated"}');
  assert.equal(digest, '925006549b879c8d9e91c10a153254fb4b6e2241820a1b072e28aa2fa8caeb79');
});

test('verifyWebhookSignature accepts a valid signed payload', () => {
  const rawBody = '{"event":"stream.updated"}';
  const timestamp = '1710000000';
  const deliveryId = 'deliv_123';
  const signature = computeWebhookSignature('topsecret', timestamp, rawBody);

  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId,
    timestamp,
    signature,
    rawBody,
    now: 1710000000,
  });

  assert.deepEqual(result, {
    ok: true,
    status: 200,
    code: 'ok',
    message: 'Webhook signature verified',
  });
});

test('verifyWebhookSignature rejects oversized payloads', () => {
  const rawBody = 'a'.repeat(DEFAULT_MAX_WEBHOOK_BODY_BYTES + 1);
  const timestamp = '1710000000';
  const signature = computeWebhookSignature('topsecret', timestamp, rawBody);

  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_oversized',
    timestamp,
    signature,
    rawBody,
    now: 1710000000,
  });

  assert.equal(result.code, 'payload_too_large');
  assert.equal(result.status, 413);
});

test('verifyWebhookSignature rejects stale timestamps', () => {
  const rawBody = '{"event":"stream.updated"}';
  const timestamp = '1710000000';
  const signature = computeWebhookSignature('topsecret', timestamp, rawBody);

  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_stale',
    timestamp,
    signature,
    rawBody,
    now: 1710000601,
    toleranceSeconds: 300,
  });

  assert.equal(result.code, 'timestamp_outside_tolerance');
  assert.equal(result.status, 401);
});

test('verifyWebhookSignature rejects signature mismatches', () => {
  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_bad_sig',
    timestamp: '1710000000',
    signature: 'deadbeef',
    rawBody: '{"event":"stream.updated"}',
    now: 1710000000,
  });

  assert.equal(result.code, 'signature_mismatch');
  assert.equal(result.status, 401);
});

test('verifyWebhookSignature surfaces duplicate deliveries', () => {
  const rawBody = '{"event":"stream.updated"}';
  const timestamp = '1710000000';
  const signature = computeWebhookSignature('topsecret', timestamp, rawBody);

  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_dup',
    timestamp,
    signature,
    rawBody,
    now: 1710000000,
    isDuplicateDelivery: (deliveryId) => deliveryId === 'deliv_dup',
  });

  assert.equal(result.code, 'duplicate_delivery');
  assert.equal(result.status, 409);
});
