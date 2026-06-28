import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../../src/app.js';
import { initializeConfig, resetConfig } from '../../src/config/env.js';
import {
  setRedisClientFactory,
  DefaultRedisClientFactory,
  type RedisClient,
  type RedisClientFactory,
} from '../../src/redis/client.js';
import {
  verifyIdToken,
  getJwks,
  _resetOidcProviderForTest,
  stopReplayCacheSweepTimer,
} from '../../src/services/oidcProvider.js';

// Helper to generate RSA Key pair
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const kid1 = 'key-id-1';
const kid2 = 'key-id-2';
const issuer = 'https://issuer.example.com';
const audience = 'my-audience';

const jwk1 = {
  kid: kid1,
  kty: 'RSA',
  alg: 'RS256',
  use: 'sig',
  ...publicKey.export({ format: 'jwk' }),
};

// Mock Redis client setup
const mockClient: RedisClient = {
  get: vi.fn(),
  set: vi.fn(),
  exists: vi.fn(),
  close: vi.fn(),
};

const mockFactory: RedisClientFactory = {
  createClient: async () => mockClient,
};

describe('OIDC Provider Service & Routes', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: Record<string, string | undefined>;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    setRedisClientFactory(mockFactory);
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    setRedisClientFactory(new DefaultRedisClientFactory());
    process.env = originalEnv;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Setup env vars
    process.env.OIDC_ISSUER_URL = issuer;
    process.env.OIDC_AUDIENCE = audience;
    process.env.REDIS_ENABLED = 'true';
    process.env.JWT_SECRET = 'a-very-long-secret-key-for-testing-only-12345';
    process.env.NODE_ENV = 'test';
    
    resetConfig();
    initializeConfig();
    await _resetOidcProviderForTest();

    // Reset Redis mock implementation
    vi.mocked(mockClient.get).mockResolvedValue(null);
    vi.mocked(mockClient.set).mockResolvedValue(undefined);
    vi.mocked(mockClient.exists).mockResolvedValue(false);
  });

  afterEach(async () => {
    await _resetOidcProviderForTest();
  });

  // ── JWKS Retrieval & Cache Tests ───────────────────────────────────────────

  describe('getJwks', () => {
    it('should fetch JWKS from HTTP when not cached', async () => {
      const mockResponse = { keys: [jwk1] };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const keys = await getJwks(issuer);

      expect(globalThis.fetch).toHaveBeenCalledWith(`${issuer}/.well-known/jwks.json`);
      expect(keys).toEqual(mockResponse);
      expect(mockClient.set).toHaveBeenCalled();
    });

    it('should return cached JWKS from Redis if available', async () => {
      const mockResponse = { keys: [jwk1] };
      vi.mocked(mockClient.get).mockResolvedValue(JSON.stringify(mockResponse));
      globalThis.fetch = vi.fn();

      const keys = await getJwks(issuer);

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(keys).toEqual(mockResponse);
    });

    it('should bypass cache and force refetch when requested', async () => {
      const mockResponse = { keys: [jwk1] };
      vi.mocked(mockClient.get).mockResolvedValue(JSON.stringify({ keys: [] }));
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const keys = await getJwks(issuer, { forceRefresh: true });

      expect(globalThis.fetch).toHaveBeenCalled();
      expect(keys).toEqual(mockResponse);
    });

    it('should throw error when fetch fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
      await expect(getJwks(issuer)).rejects.toThrow('JWKS fetch request failed');
    });

    it('should throw error when response status is not ok', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);
      await expect(getJwks(issuer)).rejects.toThrow('JWKS fetch failed with HTTP status 404');
    });

    it('should fall back to HTTP fetch when Redis read fails', async () => {
      vi.mocked(mockClient.get).mockRejectedValue(new Error('Redis read timeout'));
      const mockResponse = { keys: [jwk1] };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const keys = await getJwks(issuer);
      expect(globalThis.fetch).toHaveBeenCalled();
      expect(keys).toEqual(mockResponse);
    });
  });

  // ── ID Token Signature & Claims Verification Tests ─────────────────────────

  describe('verifyIdToken', () => {
    it('should verify valid RS256 token and extract claims', async () => {
      const token = jwt.sign(
        {
          iss: issuer,
          aud: audience,
          sub: 'user123',
          email: 'user@example.com',
          stellar_address: 'GCSX22222222222222222222222222222222222222222222222222UV',
          role: 'operator',
        },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '10m' }
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ keys: [jwk1] }),
      } as Response);

      const result = await verifyIdToken(token);
      expect(result.address).toBe('GCSX22222222222222222222222222222222222222222222222222UV');
      expect(result.role).toBe('operator');
      expect(result.sub).toBe('user123');
      expect(result.email).toBe('user@example.com');
    });

    it('should fall back to sub claim when address/stellar_address are missing', async () => {
      const token = jwt.sign(
        {
          iss: issuer,
          aud: audience,
          sub: 'GB345...',
          role: 'viewer',
        },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '10m' }
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ keys: [jwk1] }),
      } as Response);

      const result = await verifyIdToken(token);
      expect(result.address).toBe('GB345...');
      expect(result.role).toBe('viewer');
    });

    it('should throw if issuer does not match config', async () => {
      const token = jwt.sign(
        {
          iss: 'https://bad-issuer.com',
          aud: audience,
          sub: 'user123',
        },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '1h' }
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ keys: [jwk1] }),
      } as Response);

      await expect(verifyIdToken(token)).rejects.toThrow('jwt issuer invalid');
    });

    it('should throw if audience does not match config', async () => {
      const token = jwt.sign(
        {
          iss: issuer,
          aud: 'wrong-audience',
          sub: 'user123',
        },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '1h' }
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ keys: [jwk1] }),
      } as Response);

      await expect(verifyIdToken(token)).rejects.toThrow('jwt audience invalid');
    });

    it('should throw if token is expired', async () => {
      const token = jwt.sign(
        {
          iss: issuer,
          aud: audience,
          sub: 'user123',
          exp: Math.floor(Date.now() / 1000) - 1000,
        },
        privateKey,
        { algorithm: 'RS256', keyid: kid1 }
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ keys: [jwk1] }),
      } as Response);

      await expect(verifyIdToken(token)).rejects.toThrow('jwt expired');
    });

    it('should force-refresh JWKS if kid is missing initially', async () => {
      const token = jwt.sign(
        {
          iss: issuer,
          aud: audience,
          sub: 'user123',
        },
        privateKey,
        { algorithm: 'RS256', keyid: kid2, expiresIn: '1h' }
      );

      const jwk2 = {
        kid: kid2,
        kty: 'RSA',
        alg: 'RS256',
        use: 'sig',
        ...publicKey.export({ format: 'jwk' }),
      };

      // Mock first call returning key-id-1, second call returning key-id-2
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ keys: [jwk1] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ keys: [jwk1, jwk2] }),
        } as Response);

      const result = await verifyIdToken(token);
      expect(result.sub).toBe('user123');
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should prevent token replay', async () => {
      const token = jwt.sign(
        {
          iss: issuer,
          aud: audience,
          sub: 'user123',
        },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '5m' }
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ keys: [jwk1] }),
      } as Response);

      // First validation: should pass
      await expect(verifyIdToken(token)).resolves.toBeDefined();

      // Mock Redis client exists check for second validation
      vi.mocked(mockClient.exists).mockResolvedValue(true);

      // Second validation: should throw replay error
      await expect(verifyIdToken(token)).rejects.toThrow('Token replay detected');
    });
  });


  // ── Replay Cache Eviction Tests ─────────────────────────────────────────────

  describe('replay cache eviction', () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ keys: [jwk1] }),
      } as Response);
    });

    afterEach(async () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await _resetOidcProviderForTest();
    });

    it('should evict expired replay entries on periodic timer sweep', async () => {
      const token = jwt.sign(
        { iss: issuer, aud: audience, sub: 'user1' },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '5s' }
      );

      await expect(verifyIdToken(token)).resolves.toBeDefined();

      vi.advanceTimersByTime(70000);

      const token2 = jwt.sign(
        { iss: issuer, aud: audience, sub: 'user2' },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '1h' }
      );
      await expect(verifyIdToken(token2)).resolves.toBeDefined();
    });

    it('should not evict unexpired entries during sweep', async () => {
      const token = jwt.sign(
        { iss: issuer, aud: audience, sub: 'user1' },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '1h' }
      );
      await expect(verifyIdToken(token)).resolves.toBeDefined();

      vi.mocked(mockClient.exists).mockResolvedValue(true);
      await expect(verifyIdToken(token)).rejects.toThrow('Token replay detected');
    });

    it('should enforce size cap by evicting oldest entry', async () => {
      vi.mocked(mockClient.exists).mockResolvedValue(false);
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ keys: [jwk1] }),
      } as Response);

      const tokens = [];
      for (let i = 0; i < 10001; i++) {
        tokens.push(jwt.sign(
          { iss: issuer, aud: audience, sub: 'user' + i },
          privateKey,
          { algorithm: 'RS256', keyid: kid1, expiresIn: '5s' }
        ));
      }

      for (let i = 0; i < 10000; i++) {
        await expect(verifyIdToken(tokens[i])).resolves.toBeDefined();
      }

      await expect(verifyIdToken(tokens[10000])).resolves.toBeDefined();

      vi.mocked(mockClient.exists).mockResolvedValue(true);
      await expect(verifyIdToken(tokens[0])).rejects.toThrow('Token replay detected');
    });


    it('should stop sweep timer on cache reset', async () => {
      const token = jwt.sign(
        { iss: issuer, aud: audience, sub: 'user1' },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '1h' }
      );
      await expect(verifyIdToken(token)).resolves.toBeDefined();

      await _resetOidcProviderForTest();

      vi.advanceTimersByTime(120000);

      const token2 = jwt.sign(
        { iss: issuer, aud: audience, sub: 'user2' },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '1h' }
      );
      await expect(verifyIdToken(token2)).resolves.toBeDefined();
    });

    it('should evict only expired entries during sweep, preserving valid ones', async () => {
      const token1 = jwt.sign(
        { iss: issuer, aud: audience, sub: 'user1' },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '5s' }
      );
      const token2 = jwt.sign(
        { iss: issuer, aud: audience, sub: 'user2' },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '1h' }
      );

      await expect(verifyIdToken(token1)).resolves.toBeDefined();
      await expect(verifyIdToken(token2)).resolves.toBeDefined();

      vi.advanceTimersByTime(7000);

      const token3 = jwt.sign(
        { iss: issuer, aud: audience, sub: 'user3' },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '1h' }
      );
      await expect(verifyIdToken(token3)).resolves.toBeDefined();

      vi.mocked(mockClient.exists).mockResolvedValue(true);
      // Redis catches both replays regardless of memory state
      await expect(verifyIdToken(token1)).rejects.toThrow('Token replay detected');
      await expect(verifyIdToken(token2)).rejects.toThrow('Token replay detected');
    });
  });


  // ── Route Endpoint Integration Tests ──────────────────────────────────────

  describe('POST /api/auth/session', () => {
    it('should fall back to shared-secret path if idToken is absent', async () => {
      const address = 'GCSX22222222222222222222222222222222222222222222222222UV';
      const res = await request(app)
        .post('/api/auth/session')
        .send({ address, role: 'operator' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.address).toBe(address);
    });

    it('should return 400 if both address and idToken are absent', async () => {
      const res = await request(app)
        .post('/api/auth/session')
        .send({ role: 'operator' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 if OIDC is not configured on server but client sends idToken', async () => {
      // Disable OIDC
      delete process.env.OIDC_ISSUER_URL;
      resetConfig();
      initializeConfig();

      const res = await request(app)
        .post('/api/auth/session')
        .send({ idToken: 'some-token' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('OIDC authentication is not configured');
    });

    it('should authenticate and issue session JWT when valid idToken is provided', async () => {
      const idToken = jwt.sign(
        {
          iss: issuer,
          aud: audience,
          sub: 'user123',
          stellar_address: 'GCSX22222222222222222222222222222222222222222222222222UV',
          role: 'operator',
        },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '5m' }
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ keys: [jwk1] }),
      } as Response);

      const res = await request(app)
        .post('/api/auth/session')
        .send({ idToken });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.address).toBe('GCSX22222222222222222222222222222222222222222222222222UV');
      expect(res.body.user.role).toBe('operator');
    });

    it('should return 401 when idToken validation fails', async () => {
      const idToken = jwt.sign(
        {
          iss: issuer,
          aud: 'wrong-audience',
          sub: 'user123',
        },
        privateKey,
        { algorithm: 'RS256', keyid: kid1, expiresIn: '1h' }
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ keys: [jwk1] }),
      } as Response);

      const res = await request(app)
        .post('/api/auth/session')
        .send({ idToken });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toContain('OIDC token validation failed');
    });
  });
});
