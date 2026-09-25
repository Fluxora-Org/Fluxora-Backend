import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Request, Response, NextFunction } from 'express';
import {
  getClientIp,
  normalizeIp,
  parseTrustedProxies,
  isTrustedProxy,
} from '../../src/lib/ipExtraction.js';
import { extractClientIdentifier, createRateLimiter } from '../../src/middleware/rateLimiter.js';
import { InMemoryStore } from '../../src/redis/rateLimitStore.js';

function mockReq(
  remoteAddress?: string,
  xForwardedFor?: string | string[],
  extraHeaders: Record<string, string> = {}
): IncomingMessage {
  return {
    socket: remoteAddress ? ({ remoteAddress } as Socket) : ({} as Socket),
    headers: {
      ...(xForwardedFor !== undefined ? { 'x-forwarded-for': xForwardedFor } : {}),
      ...extraHeaders,
    },
  } as unknown as IncomingMessage;
}

describe('ipExtraction', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TRUSTED_PROXY_COUNT;
    delete process.env.TRUST_PROXY_HOPS;
    delete process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT;
    delete process.env.TRUSTED_PROXIES;
    delete process.env.WS_TRUSTED_PROXIES;
    delete process.env.RATE_LIMIT_TRUSTED_PROXIES;
    delete process.env.RATE_LIMIT_TRUST_PROXY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('utility functions', () => {
    it('normalizeIp strips ::ffff: prefix and trims', () => {
      expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
      expect(normalizeIp('  ::ffff:192.168.1.1  ')).toBe('192.168.1.1');
      expect(normalizeIp('10.0.0.1')).toBe('10.0.0.1');
      expect(normalizeIp('::1')).toBe('::1');
    });

    it('parseTrustedProxies parses comma-separated string and adds normalized versions', () => {
      const set = parseTrustedProxies('127.0.0.1, 10.0.0.1, ::ffff:192.168.1.1');
      expect(set.has('127.0.0.1')).toBe(true);
      expect(set.has('10.0.0.1')).toBe(true);
      expect(set.has('::ffff:192.168.1.1')).toBe(true);
      expect(set.has('192.168.1.1')).toBe(true);
    });

    it('isTrustedProxy returns true for matching raw or normalized IP', () => {
      const set = parseTrustedProxies('127.0.0.1, ::1');
      expect(isTrustedProxy('127.0.0.1', set)).toBe(true);
      expect(isTrustedProxy('::ffff:127.0.0.1', set)).toBe(true);
      expect(isTrustedProxy('::1', set)).toBe(true);
      expect(isTrustedProxy('8.8.8.8', set)).toBe(false);
    });
  });

  describe('direct connections & unconfigured proxy trust', () => {
    it('returns remoteAddress when no X-Forwarded-For is present', () => {
      const req = mockReq('203.0.113.5');
      expect(getClientIp(req)).toBe('203.0.113.5');
    });

    it('returns unknown when remoteAddress is missing', () => {
      const req = mockReq(undefined);
      expect(getClientIp(req)).toBe('unknown');
    });

    it('ignores X-Forwarded-For when neither trustedProxyCount nor trustedProxies is configured', () => {
      // Default state: no proxy topology configured
      const req = mockReq('203.0.113.5', '1.1.1.1, 2.2.2.2');
      expect(getClientIp(req)).toBe('203.0.113.5');
    });

    it('ignores X-Forwarded-For when trustProxy is explicitly false in options', () => {
      const req = mockReq('127.0.0.1', '1.1.1.1', {});
      expect(getClientIp(req, { trustProxy: false, trustedProxyCount: 1 })).toBe('127.0.0.1');
    });

    it('ignores X-Forwarded-For when RATE_LIMIT_TRUST_PROXY=false in env', () => {
      process.env.RATE_LIMIT_TRUST_PROXY = 'false';
      process.env.TRUSTED_PROXY_COUNT = '1';
      const req = mockReq('127.0.0.1', '1.1.1.1');
      expect(getClientIp(req)).toBe('127.0.0.1');
    });
  });

  describe('hop-count based extraction (trustedProxyCount)', () => {
    it('extracts client IP from 1 trusted reverse proxy hop, ignoring forged client headers', () => {
      // Topology: Client (198.51.100.55) -> Trusted Proxy (127.0.0.1) -> Server
      // Attacker sends forged 'X-Forwarded-For: 8.8.8.8, 9.9.9.9'
      // Trusted proxy appends client IP -> '8.8.8.8, 9.9.9.9, 198.51.100.55'
      const req = mockReq('127.0.0.1', '8.8.8.8, 9.9.9.9, 198.51.100.55');
      const ip = getClientIp(req, { trustedProxyCount: 1 });
      expect(ip).toBe('198.51.100.55');
    });

    it('extracts client IP from 2 trusted proxy hops (e.g. Cloudflare + Nginx)', () => {
      // Topology: Client (198.51.100.55) -> Cloudflare (10.0.0.1) -> Nginx (127.0.0.1) -> Server
      // Attacker sends forged 'X-Forwarded-For: 1.1.1.1'
      // Header becomes: '1.1.1.1, 198.51.100.55, 10.0.0.1'
      const req = mockReq('127.0.0.1', '1.1.1.1, 198.51.100.55, 10.0.0.1');
      const ip = getClientIp(req, { trustedProxyCount: 2 });
      expect(ip).toBe('198.51.100.55');
    });

    it('extracts client IP when configured via TRUSTED_PROXY_COUNT environment variable', () => {
      process.env.TRUSTED_PROXY_COUNT = '1';
      const req = mockReq('127.0.0.1', 'spoofed-address, 198.51.100.77');
      expect(getClientIp(req)).toBe('198.51.100.77');
    });

    it('extracts client IP when configured via TRUST_PROXY_HOPS environment variable', () => {
      process.env.TRUST_PROXY_HOPS = '2';
      const req = mockReq('127.0.0.1', 'forged-1, 198.51.100.88, 10.0.0.2');
      expect(getClientIp(req)).toBe('198.51.100.88');
    });

    it('safely falls back to leftmost available IP if header has fewer hops than trustedProxyCount', () => {
      const req = mockReq('127.0.0.1', '198.51.100.99');
      // Configured for 3 hops, but header only has 1 hop
      expect(getClientIp(req, { trustedProxyCount: 3 })).toBe('198.51.100.99');
    });

    it('rejects forwarding headers when peer is untrusted if trustedProxies list is also specified', () => {
      // Attacker (8.8.8.8) connects directly and claims to be behind 1 proxy
      const req = mockReq('8.8.8.8', '1.1.1.1, 2.2.2.2');
      const ip = getClientIp(req, {
        trustedProxyCount: 1,
        trustedProxies: ['127.0.0.1', '10.0.0.1'],
      });
      expect(ip).toBe('8.8.8.8');
    });
  });

  describe('trusted proxy address list extraction (trustedProxies)', () => {
    it('rejects X-Forwarded-For when immediate peer is not in trustedProxies (spoofing attempt)', () => {
      process.env.TRUSTED_PROXIES = '127.0.0.1, 10.0.0.1';
      const req = mockReq('203.0.113.100', '1.1.1.1');
      expect(getClientIp(req)).toBe('203.0.113.100');
    });

    it('extracts first untrusted IP from the right when immediate peer is a trusted proxy', () => {
      process.env.TRUSTED_PROXIES = '127.0.0.1, 10.0.0.1';
      // Attacker (198.51.100.10) connects to Proxy 1 (10.0.0.1) which connects to Proxy 2 (127.0.0.1)
      // Attacker prepends 'forged-ip-1, forged-ip-2'
      // Header: 'forged-ip-1, forged-ip-2, 198.51.100.10, 10.0.0.1'
      const req = mockReq('127.0.0.1', 'forged-ip-1, forged-ip-2, 198.51.100.10, 10.0.0.1');
      expect(getClientIp(req)).toBe('198.51.100.10');
    });

    it('handles backward-compatible WS_TRUSTED_PROXIES environment variable', () => {
      process.env.WS_TRUSTED_PROXIES = '127.0.0.1, ::1';
      const req = mockReq('127.0.0.1', 'forged-ip, 198.51.100.20');
      expect(getClientIp(req)).toBe('198.51.100.20');
    });

    it('handles IPv4-mapped IPv6 socket address against IPv4 trusted proxy entry', () => {
      const req = mockReq('::ffff:127.0.0.1', 'forged-ip, 198.51.100.30');
      const ip = getClientIp(req, { trustedProxies: ['127.0.0.1'] });
      expect(ip).toBe('198.51.100.30');
    });

    it('handles IPv6 peer and client addresses', () => {
      const req = mockReq('::1', 'forged-ip, 2001:db8:85a3::8a2e:370:7334');
      const ip = getClientIp(req, { trustedProxies: ['::1'] });
      expect(ip).toBe('2001:db8:85a3::8a2e:370:7334');
    });

    it('returns leftmost IP when all hops in X-Forwarded-For are trusted proxies', () => {
      const req = mockReq('127.0.0.1', '10.0.0.2, 10.0.0.1');
      const ip = getClientIp(req, { trustedProxies: ['127.0.0.1', '10.0.0.1', '10.0.0.2'] });
      expect(ip).toBe('10.0.0.2');
    });
  });

  describe('header format handling', () => {
    it('handles array format of x-forwarded-for headers', () => {
      const req = mockReq('127.0.0.1', ['forged-ip', '198.51.100.40']);
      const ip = getClientIp(req, { trustedProxyCount: 1 });
      expect(ip).toBe('198.51.100.40');
    });

    it('handles irregular whitespace and trailing commas in x-forwarded-for', () => {
      const req = mockReq('127.0.0.1', '   forged-ip ,   198.51.100.50 ,  ');
      const ip = getClientIp(req, { trustedProxyCount: 1 });
      expect(ip).toBe('198.51.100.50');
    });

    it('returns remoteAddress if x-forwarded-for contains only whitespace', () => {
      const req = mockReq('127.0.0.1', '   ,   ');
      const ip = getClientIp(req, { trustedProxyCount: 1 });
      expect(ip).toBe('127.0.0.1');
    });
  });

  describe('rate limiting & lockout spoofing assertions', () => {
    it('extractClientIdentifier produces un-spoofable IP matching getClientIp', () => {
      process.env.TRUSTED_PROXY_COUNT = '1';
      const req = mockReq('127.0.0.1', 'fake-victim-ip, 198.51.100.60') as unknown as Request;
      const { identifier, identifierType } = extractClientIdentifier(req);
      expect(identifierType).toBe('ip');
      expect(identifier).toBe('198.51.100.60');
    });

    it('submitting forged forwarding headers cannot evade rate limiting', async () => {
      process.env.TRUSTED_PROXIES = '127.0.0.1';

      const limiter = createRateLimiter(
        {
          RATE_LIMIT_ENABLED: 'true',
          RATE_LIMIT_IP_MAX: '2',
          RATE_LIMIT_IP_WINDOW_MS: '60000',
        },
        new InMemoryStore()
      );

      const invokeMiddleware = async (req: Request, res: any, next: any) => {
        return new Promise<void>((resolve) => {
          const origJson = res.json;
          res.json = vi.fn((...args: any[]) => {
            origJson?.apply(res, args);
            resolve();
          });
          const wrappedNext = vi.fn((...args: any[]) => {
            next(...args);
            resolve();
          });
          limiter(req, res, wrappedNext);
        });
      };

      // Real attacker IP is 198.51.100.70. Attacker attempts to evade limit by changing the forged header
      const makeReq = (spoofed: string) =>
        ({
          headers: { 'x-forwarded-for': `${spoofed}, 198.51.100.70` },
          socket: { remoteAddress: '127.0.0.1' },
          path: '/api/test',
          method: 'GET',
        }) as unknown as Request;

      const res1 = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next1 = vi.fn();
      await invokeMiddleware(makeReq('spoof-1'), res1, next1);
      expect(next1).toHaveBeenCalled();

      const res2 = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next2 = vi.fn();
      await invokeMiddleware(makeReq('spoof-2'), res2, next2);
      expect(next2).toHaveBeenCalled();

      // 3rd request should be blocked even though attacker provided a new spoofed header 'spoof-3'
      const res3 = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next3 = vi.fn();
      await invokeMiddleware(makeReq('spoof-3'), res3, next3);

      expect(next3).not.toHaveBeenCalled();
      expect(res3.status).toHaveBeenCalledWith(429);
      expect(res3.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'RATE_LIMIT_EXCEEDED',
          }),
        })
      );
    });

    it('submitting forged forwarding headers from untrusted socket cannot frame victim IP', async () => {
      // Direct untrusted connection from attacker 8.8.8.8 attempting to frame victim 198.51.100.99
      const req = mockReq('8.8.8.8', '198.51.100.99');
      expect(getClientIp(req, { trustedProxies: ['127.0.0.1'] })).toBe('8.8.8.8');
    });
  });
});
