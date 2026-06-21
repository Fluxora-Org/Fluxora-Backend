import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../lib/logger.js';
import { WebhookDispatcher, type WebhookDispatchOptions } from './dispatcher.js';
import { DEFAULT_RETRY_POLICY } from './types.js';

const originalFetch = global.fetch;

const retryPolicy = {
  ...DEFAULT_RETRY_POLICY,
  maxAttempts: 3,
  initialBackoffMs: 1000,
  backoffMultiplier: 1,
  maxBackoffMs: 1000,
  jitterPercent: 0,
  timeoutMs: 1000,
  retryableStatusCodes: [500],
};

function createOptions(overrides: Partial<WebhookDispatchOptions> = {}): WebhookDispatchOptions {
  return {
    url: 'https://example.com/webhook',
    secret: 'secret123',
    payload: JSON.stringify({ test: 'data' }),
    deliveryId: 'deliv_test',
    eventType: 'stream.created',
    ...overrides,
  };
}

function expectNoSensitiveLogData(
  spies: Array<{ mock: { calls: unknown[][] } }>,
  ...forbiddenValues: string[]
): void {
  const serialized = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));

  for (const forbiddenValue of forbiddenValues) {
    expect(serialized).not.toContain(forbiddenValue);
  }
}

describe('Webhook Dispatcher', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('includes required headers and signature', async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    global.fetch = mockFetch as unknown as typeof fetch;

    await new WebhookDispatcher().dispatch(createOptions());

    expect(mockFetch).toHaveBeenCalled();
    const fetchCall = mockFetch.mock.calls[0] as [string, RequestInit] | undefined;
    const headers = fetchCall?.[1].headers as Record<string, string> | undefined;
    expect(headers?.['x-fluxora-signature']).toBeDefined();
    expect(headers?.['x-fluxora-signature']).not.toBe('secret123');
    expect(headers?.['x-fluxora-event']).toBe('stream.created');
  });

  it('dispatches a webhook without throwing and logs the success path', async () => {
    const payload = JSON.stringify({ test: 'data' });
    const infoSpy = vi.spyOn(logger, 'info');
    global.fetch = vi.fn(async () => new Response(null, { status: 200, statusText: 'OK' })) as unknown as typeof fetch;

    const result = await new WebhookDispatcher(retryPolicy).dispatch(createOptions({
      deliveryId: 'deliv_success',
      payload,
    }));

    expect(result).toMatchObject({
      success: true,
      statusCode: 200,
      shouldRetry: false,
    });
    expect(infoSpy).toHaveBeenNthCalledWith(
      2,
      'Webhook delivered successfully',
      undefined,
      expect.objectContaining({
        deliveryId: 'deliv_success',
        eventType: 'stream.created',
        statusCode: 200,
        attemptNumber: 1,
      }),
    );
    expectNoSensitiveLogData([infoSpy], 'secret123', payload, 'https://example.com/webhook');
  });

  it('returns retryable failure details and logs a safe 500 warning', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    global.fetch = vi.fn(async () => new Response(null, { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;

    const result = await new WebhookDispatcher(retryPolicy).dispatch(createOptions({
      deliveryId: 'deliv_retry_status',
    }));

    expect(result).toMatchObject({
      success: false,
      statusCode: 500,
      shouldRetry: true,
    });
    expect(result.nextRetryAt).toBeGreaterThan(Date.now());
    expect(warnSpy).toHaveBeenCalledWith(
      'Webhook delivery failed, will retry',
      undefined,
      expect.objectContaining({
        deliveryId: 'deliv_retry_status',
        eventType: 'stream.created',
        statusCode: 500,
        attemptNumber: 1,
      }),
    );
    expectNoSensitiveLogData([warnSpy], 'secret123', JSON.stringify({ test: 'data' }), 'https://example.com/webhook');
  });

  it('returns permanent failure details and logs a safe non-retryable status error', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    global.fetch = vi.fn(async () => new Response(null, { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;

    const result = await new WebhookDispatcher(retryPolicy).dispatch(createOptions({
      deliveryId: 'deliv_permanent_status',
    }));

    expect(result).toMatchObject({
      success: false,
      statusCode: 404,
      shouldRetry: false,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      'Webhook delivery failed permanently',
      undefined,
      expect.objectContaining({
        deliveryId: 'deliv_permanent_status',
        eventType: 'stream.created',
        statusCode: 404,
        attemptNumber: 1,
      }),
    );
    expectNoSensitiveLogData([errorSpy], 'secret123', JSON.stringify({ test: 'data' }), 'https://example.com/webhook');
  });

  it('returns retryable failure details and logs a safe network error warning', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const sensitiveNetworkMessage = 'Network error https://secret123:payload@example.com/webhook';
    global.fetch = vi.fn(async () => {
      throw new Error(sensitiveNetworkMessage);
    }) as unknown as typeof fetch;

    const result = await new WebhookDispatcher(retryPolicy).dispatch(createOptions({
      deliveryId: 'deliv_retry_network',
    }));

    expect(result).toMatchObject({
      success: false,
      shouldRetry: true,
    });
    expect(result.error).toBe(sensitiveNetworkMessage);
    expect(result.nextRetryAt).toBeGreaterThan(Date.now());
    expect(warnSpy).toHaveBeenCalledWith(
      'Webhook delivery failed with error, will retry',
      undefined,
      expect.objectContaining({
        deliveryId: 'deliv_retry_network',
        eventType: 'stream.created',
        attemptNumber: 1,
      }),
    );
    expectNoSensitiveLogData([warnSpy], 'secret123', 'payload', sensitiveNetworkMessage);
  });

  it('returns permanent failure details and logs a safe exhausted network error', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    global.fetch = vi.fn(async () => {
      throw new Error('Network error https://secret123:payload@example.com/webhook');
    }) as unknown as typeof fetch;

    const result = await new WebhookDispatcher({
      ...retryPolicy,
      maxAttempts: 1,
    }).dispatch(createOptions({
      deliveryId: 'deliv_permanent_network',
    }));

    expect(result).toMatchObject({
      success: false,
      shouldRetry: false,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      'Webhook delivery failed permanently with error',
      undefined,
      expect.objectContaining({
        deliveryId: 'deliv_permanent_network',
        eventType: 'stream.created',
        attemptNumber: 1,
      }),
    );
    expectNoSensitiveLogData([errorSpy], 'secret123', 'payload', 'https://secret123:payload@example.com/webhook');
  });

  it('validates endpoint failures without logging the target URL', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    global.fetch = vi.fn(async () => {
      throw new Error('Network error https://secret123:payload@example.com/webhook');
    }) as unknown as typeof fetch;

    const isValid = await new WebhookDispatcher(retryPolicy).validateEndpoint('https://example.com/webhook');

    expect(isValid).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith('Webhook endpoint validation failed');
    expectNoSensitiveLogData([warnSpy], 'secret123', 'payload', 'https://example.com/webhook');
  });
});
