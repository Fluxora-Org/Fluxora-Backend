import assert from 'node:assert/strict';
import test from 'node:test';
import { WebhookService } from '../src/webhooks/service.js';
import { webhookDeliveryStore } from '../src/webhooks/store.js';
import { computeWebhookSignature } from '../src/webhooks/signature.js';
import type { WebhookEvent } from '../src/webhooks/types.js';

// Mock fetch for testing
const originalFetch = global.fetch;
let mockFetchResponses: Map<string, Response> = new Map();

function mockFetch(url: string, options?: RequestInit): Promise<Response> {
  const response = mockFetchResponses.get(url);
  if (response) {
    return Promise.resolve(response.clone());
  }
  return Promise.reject(new Error(`No mock response for ${url}`));
}

test.before(() => {
  global.fetch = mockFetch as any;
});

test.after(() => {
  global.fetch = originalFetch;
});

test('WebhookService: queues a webhook delivery', async () => {
  webhookDeliveryStore.clear();
  const service = new WebhookService();

  const event: WebhookEvent = {
    id: 'event_123',
    type: 'stream.created',
    timestamp: Date.now(),
    data: { streamId: 'stream_123' },
  };

  const delivery = await service.queueDelivery(
    event,
    'https://example.com/webhook',
    'secret123',
  );

  assert.equal(delivery.status, 'pending');
  assert.equal(delivery.eventId, event.id);
  assert.equal(delivery.eventType, event.type);
  assert.ok(delivery.deliveryId.startsWith('deliv_'));
});

test('WebhookService: tracks delivery attempts', async () => {
  webhookDeliveryStore.clear();
  const service = new WebhookService();

  mockFetchResponses.set('https://example.com/webhook', new Response(null, { status: 200 }));

  const event: WebhookEvent = {
    id: 'event_456',
    type: 'stream.updated',
    timestamp: Date.now(),
    data: { streamId: 'stream_456' },
  };

  const delivery = await service.queueDelivery(
    event,
    'https://example.com/webhook',
    'secret123',
  );

  assert.equal(delivery.attempts.length, 1);
  assert.equal(delivery.attempts[0].attemptNumber, 1);
  assert.equal(delivery.attempts[0].statusCode, 200);
});

test('WebhookService: marks delivery as delivered on 2xx response', async () => {
  webhookDeliveryStore.clear();
  const service = new WebhookService();

  mockFetchResponses.set('https://example.com/webhook', new Response(null, { status: 200 }));

  const event: WebhookEvent = {
    id: 'event_789',
    type: 'stream.created',
    timestamp: Date.now(),
    data: { streamId: 'stream_789' },
  };

  const delivery = await service.queueDelivery(
    event,
    'https://example.com/webhook',
    'secret123',
  );

  assert.equal(delivery.status, 'delivered');
});

test('WebhookService: retries on 5xx response', async () => {
  webhookDeliveryStore.clear();
  const service = new WebhookService();

  mockFetchResponses.set('https://example.com/webhook', new Response(null, { status: 503 }));

  const event: WebhookEvent = {
    id: 'event_retry',
    type: 'stream.created',
    timestamp: Date.now(),
    data: { streamId: 'stream_retry' },
  };

  const delivery = await service.queueDelivery(
    event,
    'https://example.com/webhook',
    'secret123',
  );

  assert.equal(delivery.status, 'pending');
  assert.equal(delivery.attempts.length, 1);
  assert.equal(delivery.attempts[0].statusCode, 503);
  assert.ok(delivery.attempts[0].nextRetryAt);
});

test('WebhookService: does not retry on 4xx response', async () => {
  webhookDeliveryStore.clear();
  const service = new WebhookService();

  mockFetchResponses.set('https://example.com/webhook', new Response(null, { status: 404 }));

  const event: WebhookEvent = {
    id: 'event_404',
    type: 'stream.created',
    timestamp: Date.now(),
    data: { streamId: 'stream_404' },
  };

  const delivery = await service.queueDelivery(
    event,
    'https://example.com/webhook',
    'secret123',
  );

  assert.equal(delivery.status, 'permanent_failure');
  assert.equal(delivery.attempts.length, 1);
  assert.equal(delivery.attempts[0].statusCode, 404);
});

test('WebhookService: respects max attempts', async () => {
  webhookDeliveryStore.clear();
  const policy = {
    maxAttempts: 2,
    initialBackoffMs: 100,
    backoffMultiplier: 2,
    maxBackoffMs: 1000,
    jitterPercent: 0,
    timeoutMs: 5000,
    retryableStatusCodes: [500, 502, 503, 504, 408, 429],
  };
  const service = new WebhookService(policy);

  mockFetchResponses.set('https://example.com/webhook', new Response(null, { status: 503 }));

  const event: WebhookEvent = {
    id: 'event_max_attempts',
    type: 'stream.created',
    timestamp: Date.now(),
    data: { streamId: 'stream_max' },
  };

  let delivery = await service.queueDelivery(
    event,
    'https://example.com/webhook',
    'secret123',
  );

  assert.equal(delivery.attempts.length, 1);
  assert.equal(delivery.status, 'pending');

  // Simulate retry
  const deliveryId = delivery.deliveryId;
  delivery = webhookDeliveryStore.getByDeliveryId(deliveryId)!;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  await service.attemptDelivery(delivery, 'secret123', timestamp);

  assert.equal(delivery.attempts.length, 2);
  assert.equal(delivery.status, 'permanent_failure');
});

test('WebhookService: sends correct headers', async () => {
  webhookDeliveryStore.clear();
  const service = new WebhookService();

  let capturedRequest: RequestInit | undefined;
  const originalFetch2 = global.fetch;
  global.fetch = async (url: string, options?: RequestInit) => {
    capturedRequest = options;
    return new Response(null, { status: 200 });
  };

  try {
    const event: WebhookEvent = {
      id: 'event_headers',
      type: 'stream.created',
      timestamp: Date.now(),
      data: { streamId: 'stream_headers' },
    };

    await service.queueDelivery(
      event,
      'https://example.com/webhook',
      'secret123',
    );

    assert.ok(capturedRequest);
    const headers = capturedRequest!.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    assert.ok(headers['x-fluxora-delivery-id']);
    assert.ok(headers['x-fluxora-timestamp']);
    assert.ok(headers['x-fluxora-signature']);
  } finally {
    global.fetch = originalFetch2;
  }
});

test('WebhookService: deduplicates deliveries', async () => {
  webhookDeliveryStore.clear();
  const service = new WebhookService();

  const event: WebhookEvent = {
    id: 'event_dedup',
    type: 'stream.created',
    timestamp: Date.now(),
    data: { streamId: 'stream_dedup' },
  };

  const delivery1 = await service.queueDelivery(
    event,
    'https://example.com/webhook',
    'secret123',
  );

  assert.ok(!service.isDuplicateDelivery(delivery1.deliveryId));

  // After storing, it should be detected as duplicate
  assert.ok(service.isDuplicateDelivery(delivery1.deliveryId));
});
