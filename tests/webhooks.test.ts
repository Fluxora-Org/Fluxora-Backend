import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebhookService } from '../src/webhooks/service.js';
import { webhookDeliveryStore } from '../src/webhooks/store.js';
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

describe('WebhookService', () => {
  beforeEach(() => {
    global.fetch = mockFetch as any;
    webhookDeliveryStore.clear();
    mockFetchResponses.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('queues a webhook delivery', async () => {
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

    expect(delivery.status).toBe('pending');
    expect(delivery.eventId).toBe(event.id);
    expect(delivery.eventType).toBe(event.type);
    expect(delivery.deliveryId.startsWith('deliv_')).toBe(true);
  });

  it('tracks delivery attempts', async () => {
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

    expect(delivery.attempts.length).toBe(1);
    expect(delivery.attempts[0].attemptNumber).toBe(1);
    expect(delivery.attempts[0].statusCode).toBe(200);
  });

  it('marks delivery as delivered on 2xx response', async () => {
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

    expect(delivery.status).toBe('delivered');
  });

  it('retries on 5xx response', async () => {
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

    expect(delivery.status).toBe('pending');
    expect(delivery.attempts.length).toBe(1);
    expect(delivery.attempts[0].statusCode).toBe(503);
    expect(delivery.attempts[0].nextRetryAt).toBeDefined();
  });

  it('does not retry on 4xx response', async () => {
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

    expect(delivery.status).toBe('permanent_failure');
    expect(delivery.attempts.length).toBe(1);
    expect(delivery.attempts[0].statusCode).toBe(404);
  });

  it('respects max attempts', async () => {
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

    expect(delivery.attempts.length).toBe(1);
    expect(delivery.status).toBe('pending');

    // Simulate retry
    const deliveryId = delivery.deliveryId;
    delivery = webhookDeliveryStore.getByDeliveryId(deliveryId)!;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    await service.attemptDelivery(delivery, 'secret123', timestamp);

    expect(delivery.attempts.length).toBe(2);
    expect(delivery.status).toBe('permanent_failure');
  });

  it('sends correct headers', async () => {
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

      expect(capturedRequest).toBeDefined();
      const headers = capturedRequest!.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['x-fluxora-delivery-id']).toBeDefined();
      expect(headers['x-fluxora-timestamp']).toBeDefined();
      expect(headers['x-fluxora-signature']).toBeDefined();
    } finally {
      global.fetch = originalFetch2;
    }
  });

  it('deduplicates deliveries', async () => {
    const service = new WebhookService();
    const deliveryId = 'test_dedup_id';

    // Initially should not be a duplicate
    expect(service.isDuplicateDelivery(deliveryId)).toBe(false);

    const event: WebhookEvent = {
      id: 'event_dedup',
      type: 'stream.created',
      timestamp: Date.now(),
      data: { streamId: 'stream_dedup' },
    };

    // This stores the delivery
    const delivery1 = await service.queueDelivery(
      event,
      'https://example.com/webhook',
      'secret123',
    );

    // Now it should be detected as duplicate
    expect(service.isDuplicateDelivery(delivery1.deliveryId)).toBe(true);
  });
});
