import { describe, it, expect, vi } from 'vitest';
import { dispatchWebhook } from './dispatcher.js';

describe('Webhook Dispatcher', () => {
  it('includes required headers and signature', async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    global.fetch = mockFetch as unknown as typeof fetch;

    await dispatchWebhook({
      url: 'https://example.com/webhook',
      secret: 'test-secret',
      event: 'stream.created',
      payload: { id: 'stream-1' }
    });

    expect(mockFetch).toHaveBeenCalled();
    const [_, options] = (mockFetch.mock.calls[0] as any);
    expect(options.headers['X-Fluxora-Signature']).toBeDefined();
    expect(options.headers['X-Fluxora-Event']).toBe('stream.created');
  });
});
