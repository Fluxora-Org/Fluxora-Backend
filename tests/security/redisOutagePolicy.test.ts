/**
 * Consistency gate for the documented Redis-outage policy.
 *
 * Governing rule: `docs/security/redis-outage-policy.md`. That document decides
 * which security-critical Redis store fails-closed, fails-open, or fails-loud
 * when Redis is unavailable. These tests drive a throwing Redis client at each
 * store and assert the behaviour matches the documented classification, so the
 * implementation and the written rule cannot drift apart.
 *
 * Coverage:
 *  - JWT revocation → fail-closed on read, fail-loud on write.
 *  - WebSocket abuse ban → fail-closed via local in-memory fallback.
 *  - Webhook pacing + circuit breaker → fail-open (availability-only, rule 2).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The JWT revocation store lazily creates a module-level Redis client via
// createRedisClient(). Mock the factory so the shared client's reads/writes
// throw — a full outage — without touching a real Redis server.
vi.mock('../../src/redis/client.js', () => ({
  createRedisClient: async () => ({
    get: async () => null,
    set: async () => {
      throw new Error('Simulated Redis outage');
    },
    setNx: async () => false,
    del: async () => {},
    exists: async () => {
      throw new Error('Simulated Redis outage');
    },
    close: async () => {},
    multi: () => {
      throw new Error('Simulated Redis outage');
    },
    zcount: async () => 0,
  }),
}));

import {
  isRevoked,
  revoke,
  closeRevocationStore,
  JwtRevocationError,
} from '../../src/redis/jwtRevocationStore.js';
import {
  RedisBanStore,
  InMemoryBanStore,
  HybridBanStore,
} from '../../src/redis/banStore.js';
import { createWebhookRateLimiter } from '../../src/redis/webhookRateLimit.js';
import { RedisWebhookCircuitBreakerStore } from '../../src/redis/webhookCircuitBreakerStore.js';
import { FakeRedisClient } from '../../src/redis/__test__/fakeRedisClient.js';

describe('Redis-outage policy — docs/security/redis-outage-policy.md', () => {
  describe('JWT revocation → FAIL-CLOSED read / FAIL-LOUD write', () => {
    beforeEach(async () => {
      await closeRevocationStore();
    });
    afterEach(async () => {
      await closeRevocationStore();
    });

    it('isRevoked fails closed: an outage must not accept a possibly-revoked token', async () => {
      await expect(isRevoked('not-actually-in-redis')).resolves.toBe(true);
    });

    it('revoke fails loud: an outage must not be reported as a successful revocation', async () => {
      await expect(revoke('some-jti', 600)).rejects.toBeInstanceOf(JwtRevocationError);
    });
  });

  describe('WebSocket abuse ban → FAIL-CLOSED via local fallback', () => {
    it('ban enforcement survives a Redis outage (the banned IP stays banned)', async () => {
      const redis = new FakeRedisClient();
      const hybrid = new HybridBanStore(
        new RedisBanStore(redis),
        new InMemoryBanStore(),
      );

      // Make the primary (Redis) ban write fail; the hybrid must still enforce.
      redis.throwOnNext('set');
      await hybrid.ban({ ip: '203.0.113.9', ttlSeconds: 600 });

      await expect(hybrid.isBanned('203.0.113.9')).resolves.toMatchObject({
        banned: true,
      });
    });
  });

  describe('Webhook pacing + circuit breaker → FAIL-OPEN (availability-only)', () => {
    it('rate limiter lets the attempt through during an outage (rule 2)', async () => {
      const redis = new FakeRedisClient();
      const limiter = createWebhookRateLimiter(redis);
      redis.throwOnNext('exec');
      const result = await limiter.checkLimit('https://consumer.example/webhook', {
        limit: 10,
        windowMs: 1000,
        burst: 0,
      });
      expect(result.canAttempt).toBe(true);
    });

    it('circuit breaker allows the attempt during an outage (rule 2)', async () => {
      const redis = new FakeRedisClient();
      const store = new RedisWebhookCircuitBreakerStore(redis);
      redis.throwOnNext('get');
      const result = await store.checkAndClaimAttempt('https://consumer.example/webhook', {
        circuitBreakerThreshold: 10,
      });
      expect(result.allowed).toBe(true);
    });
  });
});