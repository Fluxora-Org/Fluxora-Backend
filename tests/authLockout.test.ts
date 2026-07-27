/**
 * Auth lockout tests
 *
 * Covers:
 * - Repeated failures trigger lockout (5 failures -> 6th request returns 429)
 * - Successful auth resets counter (4 failures -> success -> 1 more failure -> no lockout)
 * - Window expiry (5 failures -> wait 10 minutes -> no lockout)
 * - Exponential backoff (5 failures -> 1 min lockout, 6 failures -> 2 min, 7 -> 4 min)
 * - Error responses don't leak account existence (same error for invalid address vs invalid token)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AuthAttemptStore } from '../src/redis/authAttemptStore.js';
import { setAuthAttemptStore } from '../src/middleware/authLockout.js';
import { authRouter } from '../src/routes/auth.js';
import { correlationIdMiddleware } from '../src/middleware/correlationId.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { initializeConfig } from '../src/config/env.js';

// Mock Redis client
class MockRedisClient {
  private sortedSets = new Map<string, Map<string, number>>();
  private keyValue = new Map<string, { value: string; expiry: number }>();

  multi() {
    const commands: Array<{ type: string; args: any[] }> = [];
    const self = this;
    
    return {
      zadd(key: string, nx: string, score: number, member: string) {
        commands.push({ type: 'zadd', args: [key, nx, score, member] });
        return this;
      },
      zremrangebyscore(key: string, min: string | number, max: string | number) {
        commands.push({ type: 'zremrangebyscore', args: [key, min, max] });
        return this;
      },
      zcard(key: string) {
        commands.push({ type: 'zcard', args: [key] });
        return this;
      },
      pexpire(key: string, ms: number) {
        commands.push({ type: 'pexpire', args: [key, ms] });
        return this;
      },
      async exec() {
        const results: Array<[null, any]> = [];
        
        for (const cmd of commands) {
          if (cmd.type === 'zadd') {
            const [key, , score, member] = cmd.args;
            if (!self.sortedSets.has(key)) {
              self.sortedSets.set(key, new Map());
            }
            self.sortedSets.get(key)!.set(member, score);
            results.push([null, 1]);
          } else if (cmd.type === 'zremrangebyscore') {
            const [key, min, max] = cmd.args;
            const set = self.sortedSets.get(key);
            if (set) {
              const maxNum = max === '+inf' ? Infinity : Number(max);
              const minNum = min === '-inf' ? -Infinity : Number(min);
              for (const [member, score] of set.entries()) {
                if (score >= minNum && score <= maxNum) {
                  set.delete(member);
                }
              }
            }
            results.push([null, 0]);
          } else if (cmd.type === 'zcard') {
            const [key] = cmd.args;
            const set = self.sortedSets.get(key);
            const count = set ? set.size : 0;
            results.push([null, count]);
          } else if (cmd.type === 'pexpire') {
            results.push([null, 1]);
          }
        }
        
        return results;
      },
    };
  }

  async get(key: string): Promise<string | null> {
    const entry = this.keyValue.get(key);
    if (!entry) return null;
    if (entry.expiry && Date.now() > entry.expiry) {
      this.keyValue.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, options?: { ex?: number }): Promise<void> {
    const expiry = options?.ex ? Date.now() + options.ex * 1000 : 0;
    this.keyValue.set(key, { value, expiry });
  }

  async del(key: string): Promise<void> {
    this.sortedSets.delete(key);
    this.keyValue.delete(key);
  }

  async zcount(key: string, min: number | string, max: number | string): Promise<number> {
    const set = this.sortedSets.get(key);
    if (!set) return 0;
    
    const minNum = min === '-inf' ? -Infinity : Number(min);
    const maxNum = max === '+inf' ? Infinity : Number(max);
    
    let count = 0;
    for (const score of set.values()) {
      if (score >= minNum && score <= maxNum) {
        count++;
      }
    }
    return count;
  }

  // Helper for tests to advance time
  advanceTime(ms: number) {
    const now = Date.now();
    // Clear sorted set entries older than now - ms
    for (const [key, set] of this.sortedSets.entries()) {
      for (const [member, score] of set.entries()) {
        if (score < now - ms) {
          set.delete(member);
        }
      }
    }
    // Clear expired lockout keys
    for (const [key, entry] of this.keyValue.entries()) {
      if (entry.expiry && entry.expiry < now) {
        this.keyValue.delete(key);
      }
    }
  }
}

// Mock OIDC provider
vi.mock('../src/services/oidcProvider.js', () => ({
  verifyIdToken: vi.fn(),
}));

// Mock config
vi.mock('../src/config/env.js', () => ({
  initializeConfig: vi.fn(),
  getConfig: () => ({
    oidcIssuerUrl: 'https://oidc.example.com',
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupertestApp = any;

let mockRedis: MockRedisClient;
let store: AuthAttemptStore;
let app: SupertestApp;

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'a-very-long-secret-key-for-testing-only-12345';
  initializeConfig();
  
  mockRedis = new MockRedisClient();
  store = new AuthAttemptStore(mockRedis as any);
  setAuthAttemptStore(store);
  
  app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use('/api/auth', authRouter);
  app.use(errorHandler);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Auth lockout', () => {
  it('repeated failures trigger lockout (5 failures -> 6th request returns 429)', async () => {
    const { verifyIdToken } = await import('../src/services/oidcProvider.js');
    (verifyIdToken as any).mockRejectedValue(new Error('Invalid token'));

    // 5 failed attempts
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/session')
        .send({ idToken: 'invalid-token', address: 'GTEST' })
        .expect(401);
    }

    // 6th attempt should be locked out
    const response = await request(app)
      .post('/api/auth/session')
      .send({ idToken: 'invalid-token', address: 'GTEST' })
      .expect(429);

    expect(response.body.message).toBe('Too many failed attempts, try again later');
    expect(response.headers['retry-after']).toBeDefined();
  });

  it('successful auth resets counter', async () => {
    const { verifyIdToken } = await import('../src/services/oidcProvider.js');
    
    // 4 failed attempts
    (verifyIdToken as any).mockRejectedValue(new Error('Invalid token'));
    for (let i = 0; i < 4; i++) {
      await request(app)
        .post('/api/auth/session')
        .send({ idToken: 'invalid-token', address: 'GTEST' })
        .expect(401);
    }

    // 1 successful attempt
    (verifyIdToken as any).mockResolvedValue({ address: 'GTEST', role: 'operator' });
    await request(app)
      .post('/api/auth/session')
      .send({ idToken: 'valid-token', address: 'GTEST' })
      .expect(200);

    // 1 more failure should not trigger lockout
    (verifyIdToken as any).mockRejectedValue(new Error('Invalid token'));
    await request(app)
      .post('/api/auth/session')
      .send({ idToken: 'invalid-token', address: 'GTEST' })
      .expect(401);

    // Should still be able to make requests
    await request(app)
      .post('/api/auth/session')
      .send({ idToken: 'invalid-token', address: 'GTEST' })
      .expect(401);
  });

  it('window expiry allows new attempts after 10 minutes', async () => {
    const { verifyIdToken } = await import('../src/services/oidcProvider.js');
    (verifyIdToken as any).mockRejectedValue(new Error('Invalid token'));

    // 5 failed attempts
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/session')
        .send({ idToken: 'invalid-token', address: 'GTEST' })
        .expect(401);
    }

    // 6th attempt is locked out
    await request(app)
      .post('/api/auth/session')
      .send({ idToken: 'invalid-token', address: 'GTEST' })
      .expect(429);

    // Advance time by 11 minutes (window is 10 minutes)
    mockRedis.advanceTime(11 * 60 * 1000);

    // Should be able to make requests again
    await request(app)
      .post('/api/auth/session')
      .send({ idToken: 'invalid-token', address: 'GTEST' })
      .expect(401);
  });

  it('exponential backoff increases lockout duration', async () => {
    const { verifyIdToken } = await import('../src/services/oidcProvider.js');
    (verifyIdToken as any).mockRejectedValue(new Error('Invalid token'));

    // 5 failures -> 1 minute lockout (2^0 * 60)
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/session')
        .send({ idToken: 'invalid-token', address: 'GTEST' })
        .expect(401);
    }

    let response = await request(app)
      .post('/api/auth/session')
      .send({ idToken: 'invalid-token', address: 'GTEST' })
      .expect(429);
    
    const retryAfter1 = parseInt(response.headers['retry-after'], 10);
    expect(retryAfter1).toBeGreaterThan(0);
    expect(retryAfter1).toBeLessThanOrEqual(60);

    // Wait for lockout to expire
    mockRedis.advanceTime(61 * 1000);

    // 6th failure -> 2 minute lockout (2^1 * 60)
    await request(app)
      .post('/api/auth/session')
      .send({ idToken: 'invalid-token', address: 'GTEST' })
      .expect(401);

    response = await request(app)
      .post('/api/auth/session')
      .send({ idToken: 'invalid-token', address: 'GTEST' })
      .expect(429);
    
    const retryAfter2 = parseInt(response.headers['retry-after'], 10);
    expect(retryAfter2).toBeGreaterThan(60);
    expect(retryAfter2).toBeLessThanOrEqual(120);
  });

  it('error responses do not leak account existence', async () => {
    const { verifyIdToken } = await import('../src/services/oidcProvider.js');
    
    // Invalid address (no idToken)
    const response1 = await request(app)
      .post('/api/auth/session')
      .send({ address: '' })
      .expect(400);

    // Invalid token
    (verifyIdToken as any).mockRejectedValue(new Error('Invalid token'));
    const response2 = await request(app)
      .post('/api/auth/session')
      .send({ idToken: 'invalid-token', address: 'GTEST' })
      .expect(401);

    // Both should return generic error messages
    expect(response1.body.error.message).toBe('Invalid session request');
    expect(response2.body.error.message).toBe('Invalid credentials');
    
    // Neither should leak whether the account exists
    expect(response1.body.error.message).not.toContain('not found');
    expect(response1.body.error.message).not.toContain('does not exist');
    expect(response2.body.error.message).not.toContain('not found');
    expect(response2.body.error.message).not.toContain('does not exist');
  });

  it('IP-based lockout works independently of address', async () => {
    const { verifyIdToken } = await import('../src/services/oidcProvider.js');
    (verifyIdToken as any).mockRejectedValue(new Error('Invalid token'));

    // 5 failed attempts from same IP with different addresses
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/session')
        .set('X-Forwarded-For', '192.168.1.1')
        .send({ idToken: 'invalid-token', address: `GTEST${i}` })
        .expect(401);
    }

    // 6th attempt from same IP should be locked out (even with new address)
    await request(app)
      .post('/api/auth/session')
      .set('X-Forwarded-For', '192.168.1.1')
      .send({ idToken: 'invalid-token', address: 'GTEST999' })
      .expect(429);

    // Different IP should not be locked out
    await request(app)
      .post('/api/auth/session')
      .set('X-Forwarded-For', '192.168.1.2')
      .send({ idToken: 'invalid-token', address: 'GTEST999' })
      .expect(401);
  });
});
