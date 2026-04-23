import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_WEBHOOK_BODY_BYTES,
  FLUXORA_WEBHOOK_HEADERS,
  buildWebhookSigningPayload,
  computeWebhookSignature,
  verifyWebhookSignature,
} from './signature.js';

// ── signing payload ───────────────────────────────────────────────────────────

test('buildWebhookSigningPayload preserves the exact raw body', () => {
  const payload = buildWebhookSigningPayload('1710000000', '{"ok":true}\n');
  assert.equal(payload.toString('utf8'), '1710000000.{"ok":true}\n');
});

test('buildWebhookSigningPayload works with a Buffer body', () => {
  const body = Buffer.from('hello', 'utf8');
  const payload = buildWebhookSigningPayload('1710000000', body);
  assert.equal(payload.toString('utf8'), '1710000000.hello');
});

// ── HMAC digest ───────────────────────────────────────────────────────────────

test('computeWebhookSignature returns a stable HMAC-SHA256 digest', () => {
  const digest = computeWebhookSignature('topsecret', '1710000000', '{"event":"stream.updated"}');
  assert.equal(digest, '925006549b879c8d9e91c10a153254fb4b6e2241820a1b072e28aa2fa8caeb79');
});

test('computeWebhookSignature output is lowercase hex', () => {
  const digest = computeWebhookSignature('s', '1', 'b');
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test('computeWebhookSignature differs when secret changes', () => {
  const a = computeWebhookSignature('secret-a', '1710000000', 'body');
  const b = computeWebhookSignature('secret-b', '1710000000', 'body');
  assert.notEqual(a, b);
});

test('computeWebhookSignature differs when body changes', () => {
  const a = computeWebhookSignature('secret', '1710000000', 'body-a');
  const b = computeWebhookSignature('secret', '1710000000', 'body-b');
  assert.notEqual(a, b);
});

// ── happy path ────────────────────────────────────────────────────────────────

test('verifyWebhookSignature accepts a valid signed payload', () => {
  const rawBody = '{"event":"stream.updated"}';
  const timestamp = '1710000000';
  const signature = computeWebhookSignature('topsecret', timestamp, rawBody);

  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_123',
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

test('verifyWebhookSignature accepts signature with leading/trailing whitespace', () => {
  const rawBody = '{"event":"stream.updated"}';
  const timestamp = '1710000000';
  const signature = '  ' + computeWebhookSignature('topsecret', timestamp, rawBody) + '  ';

  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_ws',
    timestamp,
    signature,
    rawBody,
    now: 1710000000,
  });

  assert.equal(result.ok, true);
});

test('verifyWebhookSignature accepts signature in uppercase', () => {
  const rawBody = '{"event":"stream.updated"}';
  const timestamp = '1710000000';
  const signature = computeWebhookSignature('topsecret', timestamp, rawBody).toUpperCase();

  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_upper',
    timestamp,
    signature,
    rawBody,
    now: 1710000000,
  });

  assert.equal(result.ok, true);
});

test('verifyWebhookSignature accepts a Buffer rawBody', () => {
  const rawBody = Buffer.from('{"event":"stream.updated"}', 'utf8');
  const timestamp = '1710000000';
  const signature = computeWebhookSignature('topsecret', timestamp, rawBody);

  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_buf',
    timestamp,
    signature,
    rawBody,
    now: 1710000000,
  });

  assert.equal(result.ok, true);
});

test('verifyWebhookSignature accepts timestamp at exact tolerance boundary', () => {
  const rawBody = '{}';
  const timestamp = '1710000000';
  const signature = computeWebhookSignature('s', timestamp, rawBody);

  // exactly at the boundary — should still pass
  const result = verifyWebhookSignature({
    secret: 's',
    deliveryId: 'deliv_boundary',
    timestamp,
    signature,
    rawBody,
    now: 1710000300,
    toleranceSeconds: 300,
  });

  assert.equal(result.ok, true);
});

// ── missing header validation ─────────────────────────────────────────────────

test('verifyWebhookSignature rejects missing secret', () => {
  const result = verifyWebhookSignature({
    deliveryId: 'deliv_1',
    timestamp: '1710000000',
    signature: 'abc',
    rawBody: '{}',
    now: 1710000000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_secret');
  assert.equal(result.status, 401);
});

test('verifyWebhookSignature rejects empty string secret', () => {
  const result = verifyWebhookSignature({
    secret: '',
    deliveryId: 'deliv_1',
    timestamp: '1710000000',
    signature: 'abc',
    rawBody: '{}',
    now: 1710000000,
  });
  assert.equal(result.code, 'missing_secret');
});

test('verifyWebhookSignature rejects missing delivery id', () => {
  const result = verifyWebhookSignature({
    secret: 'topsecret',
    timestamp: '1710000000',
    signature: 'abc',
    rawBody: '{}',
    now: 1710000000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_delivery_id');
  assert.equal(result.status, 401);
  assert.ok(result.message.includes(FLUXORA_WEBHOOK_HEADERS.deliveryId));
});

test('verifyWebhookSignature rejects missing timestamp', () => {
  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_1',
    signature: 'abc',
    rawBody: '{}',
    now: 1710000000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_timestamp');
  assert.equal(result.status, 401);
  assert.ok(result.message.includes(FLUXORA_WEBHOOK_HEADERS.timestamp));
});

test('verifyWebhookSignature rejects missing signature', () => {
  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_1',
    timestamp: '1710000000',
    rawBody: '{}',
    now: 1710000000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_signature');
  assert.equal(result.status, 401);
  assert.ok(result.message.includes(FLUXORA_WEBHOOK_HEADERS.signature));
});

// ── timestamp validation ──────────────────────────────────────────────────────

test('verifyWebhookSignature rejects zero timestamp', () => {
  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_1',
    timestamp: '0',
    signature: 'abc',
    rawBody: '{}',
    now: 1710000000,
  });
  assert.equal(result.code, 'invalid_timestamp');
  assert.equal(result.status, 400);
});

test('verifyWebhookSignature rejects negative timestamp', () => {
  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_1',
    timestamp: '-1',
    signature: 'abc',
    rawBody: '{}',
    now: 1710000000,
  });
  assert.equal(result.code, 'invalid_timestamp');
});

test('verifyWebhookSignature rejects non-numeric timestamp', () => {
  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_1',
    timestamp: 'not-a-number',
    signature: 'abc',
    rawBody: '{}',
    now: 1710000000,
  });
  assert.equal(result.code, 'invalid_timestamp');
});

test('verifyWebhookSignature rejects float timestamp', () => {
  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_1',
    timestamp: '1710000000.5',
    signature: 'abc',
    rawBody: '{}',
    now: 1710000000,
  });
  assert.equal(result.code, 'invalid_timestamp');
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

test('verifyWebhookSignature rejects future timestamps outside tolerance', () => {
  const rawBody = '{}';
  const timestamp = '1710001000';
  const signature = computeWebhookSignature('s', timestamp, rawBody);

  const result = verifyWebhookSignature({
    secret: 's',
    deliveryId: 'deliv_future',
    timestamp,
    signature,
    rawBody,
    now: 1710000000,
    toleranceSeconds: 300,
  });

  assert.equal(result.code, 'timestamp_outside_tolerance');
});

test('verifyWebhookSignature accepts a Date object for now', () => {
  const rawBody = '{}';
  const timestamp = '1710000000';
  const signature = computeWebhookSignature('s', timestamp, rawBody);

  const result = verifyWebhookSignature({
    secret: 's',
    deliveryId: 'deliv_date',
    timestamp,
    signature,
    rawBody,
    now: new Date(1710000000 * 1000),
  });

  assert.equal(result.ok, true);
});

// ── payload size ──────────────────────────────────────────────────────────────

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

test('verifyWebhookSignature accepts payload at exact size limit', () => {
  const rawBody = 'a'.repeat(DEFAULT_MAX_WEBHOOK_BODY_BYTES);
  const timestamp = '1710000000';
  const signature = computeWebhookSignature('topsecret', timestamp, rawBody);

  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_exact',
    timestamp,
    signature,
    rawBody,
    now: 1710000000,
  });

  // size check passes; may fail on sig but not payload_too_large
  assert.notEqual(result.code, 'payload_too_large');
});

test('verifyWebhookSignature respects custom maxBodyBytes', () => {
  const rawBody = 'hello';
  const timestamp = '1710000000';
  const signature = computeWebhookSignature('s', timestamp, rawBody);

  const result = verifyWebhookSignature({
    secret: 's',
    deliveryId: 'deliv_custom',
    timestamp,
    signature,
    rawBody,
    now: 1710000000,
    maxBodyBytes: 4, // 'hello' is 5 bytes
  });

  assert.equal(result.code, 'payload_too_large');
});

// ── constant-time signature compare ──────────────────────────────────────────

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

test('verifyWebhookSignature rejects a signature that is one char off', () => {
  const rawBody = '{}';
  const timestamp = '1710000000';
  const good = computeWebhookSignature('topsecret', timestamp, rawBody);
  // flip the last character
  const bad = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');

  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_oneoff',
    timestamp,
    signature: bad,
    rawBody,
    now: 1710000000,
  });

  assert.equal(result.code, 'signature_mismatch');
});

test('verifyWebhookSignature rejects wrong-length signature without crashing', () => {
  const result = verifyWebhookSignature({
    secret: 'topsecret',
    deliveryId: 'deliv_short',
    timestamp: '1710000000',
    signature: 'abc',
    rawBody: '{}',
    now: 1710000000,
  });

  assert.equal(result.code, 'signature_mismatch');
});

// ── duplicate delivery ────────────────────────────────────────────────────────

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

test('verifyWebhookSignature does not flag non-duplicate deliveries', () => {
  const rawBody = '{}';
  const timestamp = '1710000000';
  const signature = computeWebhookSignature('s', timestamp, rawBody);

  const result = verifyWebhookSignature({
    secret: 's',
    deliveryId: 'deliv_new',
    timestamp,
    signature,
    rawBody,
    now: 1710000000,
    isDuplicateDelivery: () => false,
  });

  assert.equal(result.ok, true);
});
