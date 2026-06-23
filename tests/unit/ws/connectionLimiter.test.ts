import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { 
  getClientIp, 
  checkLimiter, 
  trackConnection, 
  untrackConnection, 
  _resetLimiter,
  setBanStore,
  getBanStore,
  wireRedisBanStore
} from '../../../src/ws/connectionLimiter.js';
import { InMemoryBanStore, createBanStore } from '../../../src/redis/banStore.js';
import type { RedisClient } from '../../../src/redis/client.js';

describe('connectionLimiter (Redis-backed bans)', () => {
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

    it('allows connections up to the limit', async () => {
      // Limit is 2
      expect((await checkLimiter(ip)).allowed).toBe(true);
      trackConnection(ip);
      expect((await checkLimiter(ip)).allowed).toBe(true);
      trackConnection(ip);
      
      const result = await checkLimiter(ip);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe(4029);
      expect(result.reason).toBe('Too many connections');
    });

    it('works correctly with IPv6 addresses', async () => {
      const ipv6 = '2001:db8::1';
      expect((await checkLimiter(ipv6)).allowed).toBe(true);
      trackConnection(ipv6);
      trackConnection(ipv6);
      expect((await checkLimiter(ipv6)).allowed).toBe(false);
      expect((await checkLimiter(ipv6)).code).toBe(4029);
    });

    it('recovering connection count allows new connections', async () => {
      trackConnection(ip);
      trackConnection(ip);
      expect((await checkLimiter(ip)).allowed).toBe(false);

      untrackConnection(ip);
      expect((await checkLimiter(ip)).allowed).toBe(true);
    });
  });

  describe('abuse banning (Redis-backed)', () => {
    const ip = '2.2.2.2';

    it('bans IP after exceeding abuse threshold rejections', async () => {
      // Limit 2, Abuse threshold 2
      trackConnection(ip);
      trackConnection(ip);

      // Rejection 1
      await checkLimiter(ip); 
      // Rejection 2
      await checkLimiter(ip);
      // Rejection 3 -> Trigger ban
      await checkLimiter(ip);

      const result = await checkLimiter(ip);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP banned due to abuse');
    });

    it('ban expires after TTL (local InMemoryBanStore)', async () => {
        vi.useFakeTimers();
        trackConnection(ip);
        trackConnection(ip);
        
        // Trigger ban
        await checkLimiter(ip);
        await checkLimiter(ip);
        await checkLimiter(ip);
        
        expect((await checkLimiter(ip)).reason).toBe('IP banned due to abuse');
        
        // Fast forward 61 seconds
        vi.advanceTimersByTime(61000);
        
        // Still rejected because of connection limit, but not because of ban
        const result = await checkLimiter(ip);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('Too many connections');
        
        vi.useRealTimers();
    });

    it('supports explicit InMemoryBanStore injection', async () => {
      const memoryStore = new InMemoryBanStore();
      setBanStore(memoryStore);

      trackConnection(ip);
      trackConnection(ip);
      await checkLimiter(ip);
      await checkLimiter(ip);
      await checkLimiter(ip);

      const result = await checkLimiter(ip);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP banned due to abuse');

      // Verify ban persisted in memory store
      const banCheck = await memoryStore.isBanned(ip);
      expect(banCheck.banned).toBe(true);
    });

    it('Redis outage falls back to local enforcement (fail-safe)', async () => {
      // Create a fake Redis client that always throws
      const fakeRedis: RedisClient = {
        async get() { throw new Error('Redis down'); },
        async set() { throw new Error('Redis down'); },
        async setNx() { return false; },
        async del() { throw new Error('Redis down'); },
        async exists() { return false; },
        async close() {},
        multi() { return { zadd() {return this;}, zremrangebyscore(){return this;}, zcard(){return this;}, pexpire(){return this;}, async exec() {return [];} } as any; },
        async zcount() { return 0; }
      };

      const store = createBanStore(fakeRedis);
      setBanStore(store);

      trackConnection(ip);
      trackConnection(ip);

      // Should still be able to ban locally even if Redis throws
      await checkLimiter(ip);
      await checkLimiter(ip);
      await checkLimiter(ip);

      const result = await checkLimiter(ip);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP banned due to abuse');
    });
  });

  describe('multi-instance simulation via shared BanStore', () => {
    it('bans are visible across different limiter instances when using same store', async () => {
      const sharedStore = new InMemoryBanStore();
      setBanStore(sharedStore);

      // Simulate instance A banning
      await sharedStore.ban({ ip: '10.0.0.1', ttlSeconds: 3600 });

      // Instance B (new limiter state) should still see the ban
      _resetLimiter(); // clears local state but keeps shared store
      setBanStore(sharedStore);

      const result = await checkLimiter('10.0.0.1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP banned due to abuse');
    });
  });
});
