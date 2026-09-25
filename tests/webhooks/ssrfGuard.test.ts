import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import dns from 'node:dns';
import https from 'node:https';
import { dispatchWebhook, WebhookDispatcher } from '../../src/webhooks/dispatcher.js';
import { validateWebhookTarget, WebhookTargetValidationError } from '../../src/webhooks/ssrfGuard.js';
import type { WebhookCircuitBreakerStore } from '../../src/redis/webhookCircuitBreakerStore.js';

const privateIPv4Targets = [
  '127.0.0.1',
  '169.254.169.254',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.0.1',
  '0.0.0.0',
];
const privateIPv6Targets = ['::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd00::1'];

function dispatcher(): WebhookDispatcher {
  const breaker = {
    checkAndClaimAttempt: vi.fn().mockResolvedValue({ allowed: true, state: 'closed' }),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue({ consecutiveFailures: 1 }),
    getState: vi.fn().mockResolvedValue(undefined),
  } as unknown as WebhookCircuitBreakerStore;
  return new WebhookDispatcher(undefined, breaker);
}

async function dispatch(url: string) {
  return dispatcher().dispatch({
    url,
    secret: 'test-secret',
    payload: '{}',
    deliveryId: 'delivery-1268',
    eventType: 'test.event',
  });
}

interface MockResponse {
  status: number;
  location?: string;
  statusText?: string;
}

function mockHttpsRequests(...responses: MockResponse[]) {
  return vi.spyOn(https, 'request').mockImplementation(((_url, options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end(body: string): void };
    request.end = () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected HTTPS request');
      (options.lookup as typeof dns.lookup)('webhook.test', {}, (error) => {
        if (error) {
          request.emit('error', error);
          return;
        }
        const incoming = Object.assign(new EventEmitter(), {
          statusCode: response.status,
          statusMessage: response.statusText ?? '',
          headers: response.location ? { location: response.location } : {},
          resume: vi.fn(),
        });
        callback(incoming as never);
      });
    };
    return request as never;
  }) as never);
}

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.spyOn(dns, 'lookup').mockImplementation(((_hostname, _options, callback) => {
    callback(null, '8.8.8.8', 4);
    return undefined as never;
  }) as never);
});

describe('webhook SSRF guard (#1268)', () => {
  it.each(privateIPv4Targets)('rejects private, loopback, link-local, and reserved IPv4 target %s', async (ip) => {
    await expect(validateWebhookTarget(`http://${ip}/`, { requireHttps: false }))
      .rejects.toBeInstanceOf(WebhookTargetValidationError);
  });

  it.each(privateIPv6Targets)('rejects loopback, link-local, and unique-local IPv6 target %s', async (ip) => {
    await expect(validateWebhookTarget(`http://[${ip}]/`, { requireHttps: false }))
      .rejects.toBeInstanceOf(WebhookTargetValidationError);
  });

  it.each(['::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.0.0.1'])
  ('rejects IPv4-mapped IPv6 target %s, including bracketed URL syntax', async (ip) => {
    await expect(validateWebhookTarget(`http://[${ip}]/`, { requireHttps: false }))
      .rejects.toBeInstanceOf(WebhookTargetValidationError);
  });

  it('dispatches a normal public HTTPS endpoint', async () => {
    const request = mockHttpsRequests({ status: 204 });

    await expect(dispatch('https://8.8.8.8/webhook')).resolves.toMatchObject({
      success: true,
      statusCode: 204,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('allows one public redirect hop', async () => {
    const request = mockHttpsRequests(
      { status: 302, location: 'https://1.1.1.1/final' },
      { status: 200 },
    );

    await expect(dispatch('https://8.8.8.8/start')).resolves.toMatchObject({
      success: true,
      statusCode: 200,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect hop to an internal target before that hop is fetched', async () => {
    const request = mockHttpsRequests({
      status: 302,
      location: 'https://169.254.169.254/metadata',
    });

    await expect(dispatch('https://8.8.8.8/start')).resolves.toMatchObject({ success: false, shouldRetry: false });
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects a redirect hop to an IPv4-mapped IPv6 private address', async () => {
    const request = mockHttpsRequests({
      status: 302,
      location: 'https://[::ffff:10.0.0.1]/internal',
    });

    await expect(dispatch('https://8.8.8.8/start')).resolves.toMatchObject({ success: false, shouldRetry: false });
    expect(request).toHaveBeenCalledOnce();
  });

  it('enforces the dispatcher one-hop redirect limit', async () => {
    const request = mockHttpsRequests(
      { status: 302, location: 'https://1.1.1.1/step-2' },
      { status: 302, location: 'https://9.9.9.9/step-3' },
    );

    const result = await dispatch('https://8.8.8.8/start');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Too many redirects');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects an internal redirect before endpoint validation fetches the next hop', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'https://169.254.169.254/metadata' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(dispatcher().validateEndpoint('https://8.8.8.8/health')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects an internal redirect before the convenience dispatch path fetches the next hop', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'https://169.254.169.254/metadata' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(dispatchWebhook({
      url: 'https://8.8.8.8/webhook',
      secret: 'test-secret',
      event: 'test.event',
      payload: {},
    })).rejects.toBeInstanceOf(WebhookTargetValidationError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('blocks DNS rebinding when connect-time lookup changes from public to private', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue({ address: '8.8.8.8', family: 4 });
    vi.spyOn(dns, 'lookup').mockImplementation(((_hostname, _options, callback) => {
      callback(null, '127.0.0.1', 4);
      return undefined as never;
    }) as never);
    const request = mockHttpsRequests({ status: 200 });

    await expect(dispatch('https://rebind.test/webhook')).resolves.toMatchObject({
      success: false,
      shouldRetry: false,
    });
    expect(request).toHaveBeenCalledOnce();
  });
});
