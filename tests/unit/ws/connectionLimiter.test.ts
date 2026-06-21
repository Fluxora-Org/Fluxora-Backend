import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { 
  getClientIp, 
  checkLimiter, 
  checkLimiterForConnection,
  setWebSocketBanRedisClient,
  trackConnection, 
  untrackConnection, 
  _resetLimiter 
} from '../../../src/ws/connectionLimiter.js';
import { FakeRedisClient } from '../../../src/redis/__test__/fakeRedisClient.js';
import { getAuditEntries, _resetAuditLog } from '../../../src/lib/auditLog.js';
import { StreamHub } from '../../../src/ws/hub.js';
import http from 'node:http';

describe('connectionLimiter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    _resetLimiter();
    _resetAuditLog();
    
    process.env.WS_MAX_CONNECTIONS_PER_IP = '2';
    process.env.WS_ABUSE_THRESHOLD = '2';
    process.env.WS_BAN_TTL_S = '60';
    process.env.WS_TRUSTED_PROXIES = '127.0.0.1,::1';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function mockRequest(remoteAddress: string, xForwardedFor?: string): IncomingMessage {
    const req = {
      socket: { remoteAddress } as Socket,
      headers: xForwardedFor ? { 'x-forwarded-for': xForwardedFor } : {},
    } as unknown as IncomingMessage;
    return req;
  }

  describe('getClientIp', () => {
    it('returns remoteAddress when no X-Forwarded-For header is present', () => {
      const req = mockRequest('1.2.3.4');
      expect(getClientIp(req)).toBe('1.2.3.4');
    });

    it('trusts X-Forwarded-For from trusted proxy (IPv4)', () => {
      const req = mockRequest('127.0.0.1', '1.2.3.4');
      expect(getClientIp(req)).toBe('1.2.3.4');
    });

    it('trusts X-Forwarded-For from trusted proxy (IPv6)', () => {
      const req = mockRequest('::1', '2001:db8::1');
      expect(getClientIp(req)).toBe('2001:db8::1');
    });

    it('rejects X-Forwarded-For from untrusted IP (spoofing attempt)', () => {
      const req = mockRequest('8.8.8.8', '1.2.3.4');
      expect(getClientIp(req)).toBe('8.8.8.8');
    });

    it('handles multiple IPs in X-Forwarded-For', () => {
      const req = mockRequest('127.0.0.1', '1.2.3.4, 5.6.7.8');
      expect(getClientIp(req)).toBe('1.2.3.4');
    });
  });

  describe('connection limiting', () => {
    const ip = '1.1.1.1';

    it('allows connections up to the limit', () => {
      // Limit is 2
      expect(checkLimiter(ip).allowed).toBe(true);
      trackConnection(ip);
      expect(checkLimiter(ip).allowed).toBe(true);
      trackConnection(ip);
      
      const result = checkLimiter(ip);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe(4029);
      expect(result.reason).toBe('Too many connections');
    });

    it('works correctly with IPv6 addresses', () => {
      const ipv6 = '2001:db8::1';
      expect(checkLimiter(ipv6).allowed).toBe(true);
      trackConnection(ipv6);
      trackConnection(ipv6);
      expect(checkLimiter(ipv6).allowed).toBe(false);
      expect(checkLimiter(ipv6).code).toBe(4029);
    });

    it('recovering connection count allows new connections', () => {
      trackConnection(ip);
      trackConnection(ip);
      expect(checkLimiter(ip).allowed).toBe(false);

      untrackConnection(ip);
      expect(checkLimiter(ip).allowed).toBe(true);
    });
  });

  describe('abuse banning', () => {
    const ip = '2.2.2.2';

    it('bans IP after exceeding abuse threshold rejections', () => {
      // Limit 2, Abuse threshold 2
      trackConnection(ip);
      trackConnection(ip);

      // Rejection 1
      checkLimiter(ip); 
      // Rejection 2
      checkLimiter(ip);
      // Rejection 3 -> Trigger ban
      checkLimiter(ip);

      const result = checkLimiter(ip);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP banned due to abuse');
    });

    it('persists abuse bans in Redis and reloads them after local state reset', async () => {
      const redis = new FakeRedisClient();
      setWebSocketBanRedisClient(redis);

      trackConnection(ip);
      trackConnection(ip);

      await checkLimiterForConnection(ip);
      await checkLimiterForConnection(ip);
      await checkLimiterForConnection(ip);

      expect((await checkLimiterForConnection(ip)).reason).toBe('IP banned due to abuse');

      _resetLimiter({ keepBanStore: true });

      const result = await checkLimiterForConnection(ip);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP banned due to abuse');
    });

    it('accepts a Redis ban client through StreamHub options', async () => {
      const redis = new FakeRedisClient();
      const server = http.createServer();
      const hub = new StreamHub(server, { banRedisClient: redis });

      trackConnection(ip);
      trackConnection(ip);

      await checkLimiterForConnection(ip);
      await checkLimiterForConnection(ip);
      await checkLimiterForConnection(ip);

      _resetLimiter({ keepBanStore: true });
      const result = await checkLimiterForConnection(ip);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP banned due to abuse');

      await new Promise<void>((resolve) => hub.close(() => resolve()));
    });

    it('falls back to the local ban cache when Redis is unavailable', async () => {
      const redis = new FakeRedisClient();
      setWebSocketBanRedisClient(redis);

      trackConnection(ip);
      trackConnection(ip);

      redis.throwOnNext('set');
      await checkLimiterForConnection(ip);
      await checkLimiterForConnection(ip);
      await checkLimiterForConnection(ip);

      redis.throwOnNext('get');
      const result = await checkLimiterForConnection(ip);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP banned due to abuse');
    });

    it('records audit entries for ban creation and expiry', async () => {
      vi.useFakeTimers();
      process.env.WS_BAN_TTL_S = '1';

      trackConnection(ip);
      trackConnection(ip);

      await checkLimiterForConnection(ip);
      await checkLimiterForConnection(ip);
      await checkLimiterForConnection(ip);

      expect(getAuditEntries().some((entry) => entry.action === 'WS_ABUSE_BAN_CREATED')).toBe(true);

      await vi.advanceTimersByTimeAsync(1100);

      expect(getAuditEntries().some((entry) => entry.action === 'WS_ABUSE_BAN_EXPIRED')).toBe(true);
      vi.useRealTimers();
    });

    it('ban expires after TTL', () => {
        vi.useFakeTimers();
        trackConnection(ip);
        trackConnection(ip);
        
        // Trigger ban
        checkLimiter(ip);
        checkLimiter(ip);
        checkLimiter(ip);
        
        expect(checkLimiter(ip).reason).toBe('IP banned due to abuse');
        
        // Fast forward 61 seconds
        vi.advanceTimersByTime(61000);
        
        // Still rejected because of connection limit, but not because of ban
        const result = checkLimiter(ip);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('Too many connections');
        
        vi.useRealTimers();
    });
  });
});
