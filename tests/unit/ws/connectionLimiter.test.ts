import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { 
  getClientIp, 
  checkLimiter, 
  trackConnection, 
  untrackConnection, 
  _resetLimiter 
} from '../../../src/ws/connectionLimiter.js';

describe('connectionLimiter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    _resetLimiter();
    
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
