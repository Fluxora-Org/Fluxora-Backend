import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientIp, isTrustedProxy, normalizeIp, parseTrustedProxies } from './ipExtraction';

const runtimeEnvKeys = [
  'RATE_LIMIT_TRUST_PROXY',
  'TRUSTED_PROXIES',
  'WS_TRUSTED_PROXIES',
  'RATE_LIMIT_TRUSTED_PROXIES',
  'TRUSTED_PROXY_COUNT',
  'TRUST_PROXY_HOPS',
  'RATE_LIMIT_TRUSTED_PROXY_COUNT',
] as const;

function makeRequest(
  remoteAddress?: string,
  forwardedFor?: string | string[],
  extras: { ip?: string; app?: { get: (key: string) => unknown } } = {}
): IncomingMessage {
  return {
    socket: { remoteAddress } as IncomingMessage['socket'],
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    ...extras,
  } as IncomingMessage;
}

describe('ipExtraction', () => {
  beforeEach(() => {
    for (const key of runtimeEnvKeys) {
      vi.stubEnv(key, '');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('normalizeIp', () => {
    it('trims whitespace and strips an IPv4-mapped IPv6 prefix', () => {
      expect(normalizeIp('  ::ffff:192.0.2.1  ')).toBe('192.0.2.1');
    });

    it('preserves ordinary IPv4 and IPv6 addresses', () => {
      expect(normalizeIp(' 192.0.2.1 ')).toBe('192.0.2.1');
      expect(normalizeIp(' 2001:db8::1 ')).toBe('2001:db8::1');
    });
  });

  describe('parseTrustedProxies', () => {
    it('returns an empty set for an omitted or empty list', () => {
      expect(parseTrustedProxies()).toEqual(new Set());
      expect(parseTrustedProxies('')).toEqual(new Set());
      expect(parseTrustedProxies(' ,  , ')).toEqual(new Set());
    });

    it('trims entries and includes raw and normalized mapped addresses', () => {
      expect(parseTrustedProxies(' 192.0.2.1, ::ffff:192.0.2.2, , 192.0.2.1 ')).toEqual(
        new Set(['192.0.2.1', '::ffff:192.0.2.2', '192.0.2.2'])
      );
    });
  });

  describe('isTrustedProxy', () => {
    it('does not trust an empty set', () => {
      expect(isTrustedProxy('192.0.2.1', new Set())).toBe(false);
    });

    it('matches exact and IPv4-mapped addresses', () => {
      const trusted = new Set(['192.0.2.1']);
      expect(isTrustedProxy('192.0.2.1', trusted)).toBe(true);
      expect(isTrustedProxy('::ffff:192.0.2.1', trusted)).toBe(true);
      expect(isTrustedProxy('192.0.2.2', trusted)).toBe(false);
    });
  });

  describe('getClientIp', () => {
    it('returns the socket address, then the request IP, then unknown as fallbacks', () => {
      expect(getClientIp(makeRequest('192.0.2.1', '198.51.100.1'))).toBe('192.0.2.1');
      expect(getClientIp(makeRequest(undefined, '198.51.100.1', { ip: '192.0.2.2' }))).toBe(
        '192.0.2.2'
      );
      expect(getClientIp(makeRequest(undefined, '198.51.100.1'))).toBe('unknown');
    });

    it('ignores forwarding headers when proxy trust is disabled', () => {
      expect(
        getClientIp(makeRequest('192.0.2.1', '198.51.100.1'), { trustProxy: false })
      ).toBe('192.0.2.1');

      vi.stubEnv('RATE_LIMIT_TRUST_PROXY', 'false');
      expect(getClientIp(makeRequest('192.0.2.1', '198.51.100.1'), { trustedProxyCount: 1 })).toBe(
        '192.0.2.1'
      );
    });

    it('honors Express trust proxy false unless explicitly overridden', () => {
      const request = makeRequest('192.0.2.1', '198.51.100.1', {
        app: { get: () => false },
      });
      expect(getClientIp(request, { trustedProxyCount: 1 })).toBe('192.0.2.1');
      expect(getClientIp(request, { trustedProxyCount: 1, trustProxy: true })).toBe('198.51.100.1');
    });

    it('ignores missing or empty forwarding headers and unconfigured proxy trust', () => {
      expect(getClientIp(makeRequest('192.0.2.1'))).toBe('192.0.2.1');
      expect(getClientIp(makeRequest('192.0.2.1', ' , , '), { trustedProxyCount: 1 })).toBe(
        '192.0.2.1'
      );
      expect(getClientIp(makeRequest('192.0.2.1', '198.51.100.1'))).toBe('192.0.2.1');
      expect(getClientIp(makeRequest('192.0.2.1', '198.51.100.1'), { trustedProxyCount: 0 })).toBe(
        '192.0.2.1'
      );
    });

    it('uses the configured hop from the right and ignores prepended entries', () => {
      const request = makeRequest('203.0.113.10', '198.51.100.1, 198.51.100.2, 203.0.113.10');
      expect(getClientIp(request, { trustedProxyCount: 1 })).toBe('203.0.113.10');
      expect(getClientIp(request, { trustedProxyCount: 2 })).toBe('198.51.100.2');
      expect(getClientIp(request, { trustedProxyCount: 3 })).toBe('198.51.100.1');
    });

    it('uses the furthest available entry when fewer hops than configured exist', () => {
      expect(
        getClientIp(makeRequest('203.0.113.10', '198.51.100.1'), { trustedProxyCount: 10 })
      ).toBe('198.51.100.1');
      expect(
        getClientIp(makeRequest('203.0.113.10', '198.51.100.1'), {
          trustedProxyCount: Number.MAX_SAFE_INTEGER,
        })
      ).toBe('198.51.100.1');
    });

    it('validates the immediate peer when a proxy list accompanies the hop count', () => {
      const request = makeRequest('203.0.113.10', '198.51.100.1, 203.0.113.10');
      expect(
        getClientIp(request, {
          trustedProxyCount: 1,
          trustedProxies: ['203.0.113.10'],
        })
      ).toBe('203.0.113.10');
      expect(
        getClientIp(request, {
          trustedProxyCount: 1,
          trustedProxies: ['192.0.2.1'],
        })
      ).toBe('203.0.113.10');
    });

    it('traverses trusted proxy addresses from the right to find the client', () => {
      const request = makeRequest(
        '203.0.113.10',
        '198.51.100.1, 203.0.113.9, 203.0.113.10'
      );
      expect(
        getClientIp(request, {
          trustedProxies: ['203.0.113.9', '203.0.113.10'],
        })
      ).toBe('198.51.100.1');
    });

    it('returns the furthest upstream entry when every forwarded address is trusted', () => {
      expect(
        getClientIp(makeRequest('203.0.113.10', '203.0.113.9, 203.0.113.10'), {
          trustedProxies: new Set(['203.0.113.9', '203.0.113.10']),
        })
      ).toBe('203.0.113.9');
    });

    it('does not use proxy headers when the immediate peer is not trusted', () => {
      const request = makeRequest('192.0.2.1', '198.51.100.1, 203.0.113.10');
      expect(
        getClientIp(request, { trustedProxies: ['203.0.113.10'] })
      ).toBe('192.0.2.1');
    });

    it('normalizes mapped addresses when validating the immediate peer', () => {
      expect(
        getClientIp(
          makeRequest('::ffff:203.0.113.10', '198.51.100.1, 203.0.113.10'),
          { trustedProxies: ['203.0.113.10'] }
        )
      ).toBe('198.51.100.1');
    });

    it('uses the first configured runtime proxy list and hop count', () => {
      vi.stubEnv('TRUSTED_PROXIES', '203.0.113.10');
      vi.stubEnv('WS_TRUSTED_PROXIES', '192.0.2.1');
      vi.stubEnv('TRUSTED_PROXY_COUNT', '2');
      vi.stubEnv('TRUST_PROXY_HOPS', '1');

      expect(
        getClientIp(
          makeRequest('203.0.113.10', '198.51.100.1, 203.0.113.11, 203.0.113.10')
        )
      ).toBe('203.0.113.11');
    });

    it('uses Express proxy address and hop settings when runtime settings are absent', () => {
      const forwarded = '198.51.100.1, 203.0.113.10';
      expect(
        getClientIp(
          makeRequest('203.0.113.10', forwarded, {
            app: { get: () => ['203.0.113.10'] },
          })
        )
      ).toBe('198.51.100.1');
      expect(
        getClientIp(
          makeRequest('203.0.113.10', forwarded, {
            app: { get: () => '203.0.113.10' },
          })
        )
      ).toBe('198.51.100.1');
      expect(
        getClientIp(makeRequest('203.0.113.10', forwarded, { app: { get: () => 1 } }))
      ).toBe('203.0.113.10');
      expect(
        getClientIp(makeRequest('203.0.113.10', forwarded, { app: { get: () => true } }))
      ).toBe('203.0.113.10');
      expect(
        getClientIp(makeRequest('203.0.113.10', forwarded, { app: { get: () => '1' } }))
      ).toBe('203.0.113.10');
    });
  });
});
