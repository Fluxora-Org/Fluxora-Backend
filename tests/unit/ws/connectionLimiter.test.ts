import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { 
  getClientIp, 
  checkAndReserve, 
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
      // Limit is 2. checkAndReserve atomically increments.
      expect((await checkAndReserve(ip)).allowed).toBe(true); // count: 0 -> 1
      expect((await checkAndReserve(ip)).allowed).toBe(true); // count: 1 -> 2
      
      const result = await checkAndReserve(ip); // count: 2 (already at limit)
      expect(result.allowed).toBe(false);
      expect(result.code).toBe(4029);
      expect(result.reason).toBe('Too many connections');
    });

    it('works correctly with IPv6 addresses', async () => {
      const ipv6 = '2001:db8::1';
      expect((await checkAndReserve(ipv6)).allowed).toBe(true); // count: 0 -> 1
      expect((await checkAndReserve(ipv6)).allowed).toBe(true); // count: 1 -> 2
      expect((await checkAndReserve(ipv6)).allowed).toBe(false);
      expect((await checkAndReserve(ipv6)).code).toBe(4029);
    });

    it('recovering connection count allows new connections', async () => {
      expect((await checkAndReserve(ip)).allowed).toBe(true); // count: 0 -> 1
      expect((await checkAndReserve(ip)).allowed).toBe(true); // count: 1 -> 2
      expect((await checkAndReserve(ip)).allowed).toBe(false); // count: 2 (at limit)

      untrackConnection(ip); // count: 2 -> 1
      expect((await checkAndReserve(ip)).allowed).toBe(true); // count: 1 -> 2
    });
  });

  describe('abuse banning (Redis-backed)', () => {
    const ip = '2.2.2.2';

    it('bans IP after exceeding abuse threshold rejections', async () => {
      // Limit 2, Abuse threshold 2 (ban after 3 rejections because rejections.length > threshold)
      await checkAndReserve(ip); // count: 0 -> 1
      await checkAndReserve(ip); // count: 1 -> 2 (at limit)

      // Rejection 1 (count = 2, at limit)
      await checkAndReserve(ip); 
      // Rejection 2
      await checkAndReserve(ip);
      // Rejection 3 -> Triggers ban (3 > threshold of 2)
      await checkAndReserve(ip);

      // Clear connection count so next call can check ban (ban should be cached/active now)
      untrackConnection(ip);
      untrackConnection(ip);

      // 4th attempt should see the ban (even though count is now 0, ban should be checked)
      const result = await checkAndReserve(ip);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP banned due to abuse');
    });

    it('ban expires after TTL (local InMemoryBanStore)', async () => {
        vi.useFakeTimers();
        await checkAndReserve(ip); // count: 0 -> 1
        await checkAndReserve(ip); // count: 1 -> 2 (at limit)
        
        // Trigger rejections and ban (3 rejections > threshold of 2)
        await checkAndReserve(ip); // rejection 1
        await checkAndReserve(ip); // rejection 2
        await checkAndReserve(ip); // rejection 3 -> ban triggered
        
        // Clear count and try - ban should be active
        untrackConnection(ip);
        untrackConnection(ip);
        expect((await checkAndReserve(ip)).reason).toBe('IP banned due to abuse');
        
        // Fast forward 61 seconds
        vi.advanceTimersByTime(61000);
        
        // Ban should be expired now, and we should get 'Too many connections' because we're back at limit
        untrackConnection(ip); // clear any count changes
        const result = await checkAndReserve(ip);
        expect(result.allowed).toBe(true); // Ban expired
        
        vi.useRealTimers();
    });

    it('supports explicit InMemoryBanStore injection', async () => {
      const memoryStore = new InMemoryBanStore();
      setBanStore(memoryStore);

      await checkAndReserve(ip); // count: 0 -> 1
      await checkAndReserve(ip); // count: 1 -> 2 (at limit)
      await checkAndReserve(ip); // rejection 1
      await checkAndReserve(ip); // rejection 2
      await checkAndReserve(ip); // rejection 3 -> ban

      // Clear count and verify ban is in store
      untrackConnection(ip);
      untrackConnection(ip);
      
      const result = await checkAndReserve(ip);
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

      await checkAndReserve(ip); // count: 0 -> 1
      await checkAndReserve(ip); // count: 1 -> 2 (at limit)

      // Should still be able to ban locally even if Redis throws
      await checkAndReserve(ip); // rejection 1
      await checkAndReserve(ip); // rejection 2
      await checkAndReserve(ip); // rejection 3 -> ban

      // Clear count and verify ban works despite Redis outage
      untrackConnection(ip);
      untrackConnection(ip);
      
      const result = await checkAndReserve(ip);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP banned due to abuse');
    });
  });

  describe('multi-instance simulation via shared BanStore', () => {
    it('bans created in external store are checked during upgrade', async () => {
      const sharedStore = new InMemoryBanStore();
      setBanStore(sharedStore);

      // Simulate a ban being created externally (e.g., by another instance)
      await sharedStore.ban({ ip: '10.0.0.1', ttlSeconds: 3600 });

      // Verify ban is in store
      const banCheck = await sharedStore.isBanned('10.0.0.1');
      expect(banCheck.banned).toBe(true);

      // Local limiter should respect the ban even without triggering rejections
      const result = await checkAndReserve('10.0.0.1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP banned due to abuse');
    });
  });
});
