import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebhookService } from '../src/webhooks/service.js';
import { webhookDeliveryStore } from '../src/webhooks/store.js';
import { webhookDispatcher } from '../src/webhooks/dispatcher.js';
import { 
  calculateNextRetryTime, 
  shouldRetry, 
  isRetryableStatusCode,
  generateRetrySchedule,
  validateRetryPolicy,
  type EnhancedRetryPolicy 
} from '../src/webhooks/retry.js';
import type { WebhookEvent } from '../src/webhooks/types.js';
import {
  computeWebhookSignature,
  verifyWebhookSignature,
} from '../src/webhooks/signature.js';
import { recordAuditEvent, getAuditEntries, _resetAuditLog } from '../src/lib/auditLog.js';

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

describe('Enhanced Webhook Features', () => {
  beforeEach(() => {
    global.fetch = mockFetch as any;
    webhookDeliveryStore.clear();
    mockFetchResponses.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('WebhookDispatcher', () => {
    it('dispatches webhook with proper headers', async () => {
      const payload = JSON.stringify({ test: 'data' });
      
      let capturedRequest: RequestInit | undefined;
      global.fetch = async (url: string, options?: RequestInit) => {
        capturedRequest = options;
        return new Response(null, { status: 200 });
      };

      const result = await webhookDispatcher.dispatch({
        url: 'https://example.com/webhook',
        secret: 'secret123',
        payload,
        deliveryId: 'deliv_123',
        eventType: 'stream.created',
      });

      expect(result.success).toBe(true);
      expect(capturedRequest).toBeDefined();
      const headers = capturedRequest!.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['x-fluxora-delivery-id']).toBe('deliv_123');
      expect(headers['x-fluxora-event']).toBe('stream.created');
      expect(headers['x-fluxora-signature']).toBeDefined();
      expect(headers['x-fluxora-timestamp']).toBeDefined();
    });

    it('handles network errors with retry logic', async () => {
      global.fetch = async () => {
        throw new Error('Network error');
      };

      const result = await webhookDispatcher.dispatch({
        url: 'https://example.com/webhook',
        secret: 'secret123',
        payload: '{"test": "data"}',
        deliveryId: 'deliv_123',
        eventType: 'stream.created',
        attemptNumber: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
      expect(result.shouldRetry).toBe(true);
      expect(result.nextRetryAt).toBeDefined();
    });

    it('marks non-retryable errors as permanent failure', async () => {
      global.fetch = async () => {
        return new Response(null, { status: 404 });
      };

      const result = await webhookDispatcher.dispatch({
        url: 'https://example.com/webhook',
        secret: 'secret123',
        payload: '{"test": "data"}',
        deliveryId: 'deliv_123',
        eventType: 'stream.created',
      });

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false);
      expect(result.statusCode).toBe(404);
    });

    it('validates endpoint before delivery', async () => {
      global.fetch = async (url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return new Response(null, { status: 200 });
        }
        return new Response(null, { status: 200 });
      };

      const isValid = await webhookDispatcher.validateEndpoint('https://example.com/webhook');
      expect(isValid).toBe(true);
    });
  });

  describe('Enhanced Retry Policy', () => {
    const enhancedPolicy: EnhancedRetryPolicy = {
      maxAttempts: 5,
      initialBackoffMs: 1000,
      backoffMultiplier: 2,
      maxBackoffMs: 60000,
      jitterPercent: 10,
      timeoutMs: 30000,
      retryableStatusCodes: [408, 429, 500, 502, 503, 504],
      backoffStrategy: 'exponential',
      jitterAlgorithm: 'full',
      deadLetterAfterMs: 3600000,
      circuitBreakerThreshold: 10,
      circuitBreakerResetMs: 300000,
    };

    it('calculates retry time with exponential backoff', () => {
      const now = Date.now();
      const retryTime = calculateNextRetryTime(1, enhancedPolicy, now);
      
      expect(retryTime).toBeGreaterThan(now);
      expect(retryTime - now).toBeLessThanOrEqual(enhancedPolicy.maxBackoffMs);
    });

    it('generates complete retry schedule', () => {
      const schedule = generateRetrySchedule(enhancedPolicy);
      
      expect(schedule).toHaveLength(enhancedPolicy.maxAttempts);
      expect(schedule[0].attemptNumber).toBe(1);
      expect(schedule[0].delayMs).toBeGreaterThanOrEqual(0);
      expect(schedule[0].retryAt).toBeGreaterThan(Date.now());
    });

    it('validates retry policy configuration', () => {
      const validPolicy = { ...enhancedPolicy };
      expect(validateRetryPolicy(validPolicy)).toHaveLength(0);

      const invalidPolicy = { ...enhancedPolicy, maxAttempts: 0 };
      const errors = validateRetryPolicy(invalidPolicy);
      expect(errors).toContain('maxAttempts must be at least 1');
    });

    it('determines retryable status codes correctly', () => {
      expect(isRetryableStatusCode(500, enhancedPolicy)).toBe(true);
      expect(isRetryableStatusCode(404, enhancedPolicy)).toBe(false);
      expect(isRetryableStatusCode(429, enhancedPolicy)).toBe(true);
      expect(isRetryableStatusCode(undefined, enhancedPolicy)).toBe(true); // Network error
    });

    it('applies different jitter algorithms', () => {
      const baseDelay = 1000;
      
      // Test full jitter
      const fullJitterPolicy = { ...enhancedPolicy, jitterAlgorithm: 'full' as const };
      const fullJitterTime = calculateNextRetryTime(1, fullJitterPolicy);
      
      // Test equal jitter
      const equalJitterPolicy = { ...enhancedPolicy, jitterAlgorithm: 'equal' as const };
      const equalJitterTime = calculateNextRetryTime(1, equalJitterPolicy);
      
      // Test decorrelated jitter
      const decorrelatedPolicy = { ...enhancedPolicy, jitterAlgorithm: 'decorrelated' as const };
      const decorrelatedTime = calculateNextRetryTime(1, decorrelatedPolicy);
      
      expect(fullJitterTime).toBeGreaterThan(0);
      expect(equalJitterTime).toBeGreaterThan(0);
      expect(decorrelatedTime).toBeGreaterThan(0);
    });
  });

  describe('Outbox Pattern', () => {
    it('adds items to outbox with priority', () => {
      const outboxId = webhookDeliveryStore.addToOutbox({
        deliveryId: 'deliv_123',
        eventId: 'event_123',
        eventType: 'stream.created',
        endpointUrl: 'https://example.com/webhook',
        payload: '{"test": "data"}',
        secret: 'secret123',
        priority: 'high',
        createdAt: Date.now(),
        scheduledFor: Date.now(),
        attempts: 0,
        maxAttempts: 5,
      });

      expect(outboxId).toBeDefined();
      expect(outboxId.startsWith('outbox_')).toBe(true);

      const items = webhookDeliveryStore.getAllOutboxItems();
      expect(items).toHaveLength(1);
      expect(items[0].priority).toBe('high');
      expect(items[0].deliveryId).toBe('deliv_123');
    });

    it('gets ready outbox items by priority', () => {
      // Add items with different priorities
      webhookDeliveryStore.addToOutbox({
        deliveryId: 'deliv_low',
        eventId: 'event_low',
        eventType: 'stream.created',
        endpointUrl: 'https://example.com/webhook',
        payload: '{"test": "low"}',
        secret: 'secret123',
        priority: 'low',
        createdAt: Date.now(),
        scheduledFor: Date.now(),
        attempts: 0,
        maxAttempts: 5,
      });

      webhookDeliveryStore.addToOutbox({
        deliveryId: 'deliv_high',
        eventId: 'event_high',
        eventType: 'stream.created',
        endpointUrl: 'https://example.com/webhook',
        payload: '{"test": "high"}',
        secret: 'secret123',
        priority: 'high',
        createdAt: Date.now(),
        scheduledFor: Date.now(),
        attempts: 0,
        maxAttempts: 5,
      });

      const readyItems = webhookDeliveryStore.getReadyOutboxItems();
      expect(readyItems).toHaveLength(2);
      // High priority items should come first
      expect(readyItems[0].priority).toBe('high');
      expect(readyItems[1].priority).toBe('low');
    });

    it('removes items from outbox', () => {
      const outboxId = webhookDeliveryStore.addToOutbox({
        deliveryId: 'deliv_remove',
        eventId: 'event_remove',
        eventType: 'stream.created',
        endpointUrl: 'https://example.com/webhook',
        payload: '{"test": "remove"}',
        secret: 'secret123',
        priority: 'normal',
        createdAt: Date.now(),
        scheduledFor: Date.now(),
        attempts: 0,
        maxAttempts: 5,
      });

      expect(webhookDeliveryStore.getAllOutboxItems()).toHaveLength(1);

      const removed = webhookDeliveryStore.removeFromOutbox(outboxId);
      expect(removed).toBe(true);
      expect(webhookDeliveryStore.getAllOutboxItems()).toHaveLength(0);
    });
  });

  describe('Dead-Letter Queue', () => {
    it('adds failed deliveries to DLQ', () => {
      const delivery = {
        id: 'delivery_123',
        deliveryId: 'deliv_123',
        eventId: 'event_123',
        eventType: 'stream.created',
        endpointUrl: 'https://example.com/webhook',
        status: 'permanent_failure' as const,
        attempts: [
          {
            attemptNumber: 1,
            timestamp: Date.now(),
            statusCode: 500,
            error: 'Server error',
          },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        payload: '{"test": "data"}',
      };

      const dlqId = webhookDeliveryStore.addToDeadLetterQueue(delivery, 'Max attempts exceeded');
      
      expect(dlqId).toBeDefined();
      expect(dlqId.startsWith('dlq_')).toBe(true);

      const dlqItems = webhookDeliveryStore.getDeadLetterQueueItems();
      expect(dlqItems).toHaveLength(1);
      expect(dlqItems[0].deliveryId).toBe('deliv_123');
      expect(dlqItems[0].failureReason).toBe('Max attempts exceeded');
    });

    it('processes DLQ items', () => {
      const delivery = {
        id: 'delivery_456',
        deliveryId: 'deliv_456',
        eventId: 'event_456',
        eventType: 'stream.created',
        endpointUrl: 'https://example.com/webhook',
        status: 'permanent_failure' as const,
        attempts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        payload: '{"test": "data"}',
      };

      const dlqId = webhookDeliveryStore.addToDeadLetterQueue(delivery, 'Permanent failure');
      
      expect(webhookDeliveryStore.getDeadLetterQueueItems()).toHaveLength(1);

      const processed = webhookDeliveryStore.processDeadLetterQueueItem(dlqId);
      expect(processed).toBe(true);
      expect(webhookDeliveryStore.getDeadLetterQueueItems()).toHaveLength(0);
    });
  });

  describe('Circuit Breaker', () => {
    it('tracks circuit breaker state per endpoint', () => {
      const endpoint = 'https://example.com/webhook';
      
      // Initial state should be undefined
      expect(webhookDeliveryStore.getCircuitBreakerState(endpoint)).toBeUndefined();

      // Update with success
      const policy: EnhancedRetryPolicy = {
        maxAttempts: 5,
        initialBackoffMs: 1000,
        backoffMultiplier: 2,
        maxBackoffMs: 60000,
        jitterPercent: 10,
        timeoutMs: 30000,
        retryableStatusCodes: [500, 502, 503, 504],
      };

      const state1 = webhookDeliveryStore.updateCircuitBreakerState(endpoint, true, policy);
      expect(state1.state).toBe('closed');
      expect(state1.failureCount).toBe(0);

      // Update with failure
      const state2 = webhookDeliveryStore.updateCircuitBreakerState(endpoint, false, policy);
      expect(state2.state).toBe('closed');
      expect(state2.failureCount).toBe(1);

      // Check endpoint availability
      expect(webhookDeliveryStore.isEndpointAvailable(endpoint)).toBe(true);
    });

    it('opens circuit breaker after threshold', () => {
      const endpoint = 'https://failing.example.com/webhook';
      const policy: EnhancedRetryPolicy = {
        maxAttempts: 5,
        initialBackoffMs: 1000,
        backoffMultiplier: 2,
        maxBackoffMs: 60000,
        jitterPercent: 10,
        timeoutMs: 30000,
        retryableStatusCodes: [500, 502, 503, 504],
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 60000,
      };

      // Add failures to reach threshold
      for (let i = 0; i < 3; i++) {
        webhookDeliveryStore.updateCircuitBreakerState(endpoint, false, policy);
      }

      const state = webhookDeliveryStore.getCircuitBreakerState(endpoint);
      expect(state?.state).toBe('open');
      expect(webhookDeliveryStore.isEndpointAvailable(endpoint)).toBe(false);
    });
  });

  describe('Metrics and Monitoring', () => {
    it('tracks delivery metrics', () => {
      const metrics = webhookDeliveryStore.getMetrics();
      expect(metrics.totalDeliveries).toBe(0);
      expect(metrics.successfulDeliveries).toBe(0);
      expect(metrics.failedDeliveries).toBe(0);
      expect(metrics.dlqItems).toBe(0);
      expect(metrics.outboxItems).toBe(0);

      // Add some items to test metrics
      webhookDeliveryStore.addToOutbox({
        deliveryId: 'deliv_metrics',
        eventId: 'event_metrics',
        eventType: 'stream.created',
        endpointUrl: 'https://example.com/webhook',
        payload: '{"test": "metrics"}',
        secret: 'secret123',
        priority: 'normal',
        createdAt: Date.now(),
        scheduledFor: Date.now(),
        attempts: 0,
        maxAttempts: 5,
      });

      const updatedMetrics = webhookDeliveryStore.getMetrics();
      expect(updatedMetrics.outboxItems).toBe(1);
    });

    it('cleans up old data', () => {
      const now = Date.now();
      const oldTime = now - (8 * 24 * 60 * 60 * 1000); // 8 days ago

      // Add an old delivery
      const oldDelivery = {
        id: 'delivery_old',
        deliveryId: 'deliv_old',
        eventId: 'event_old',
        eventType: 'stream.created',
        endpointUrl: 'https://example.com/webhook',
        status: 'delivered' as const,
        attempts: [],
        createdAt: oldTime,
        updatedAt: oldTime,
        payload: '{"test": "old"}',
      };

      webhookDeliveryStore.store(oldDelivery);
      expect(webhookDeliveryStore.getAll()).toHaveLength(1);

      // Clean up data older than 7 days
      const result = webhookDeliveryStore.cleanup(7 * 24 * 60 * 60 * 1000);
      expect(result.cleaned).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(webhookDeliveryStore.getAll()).toHaveLength(0);
    });
  });
});
