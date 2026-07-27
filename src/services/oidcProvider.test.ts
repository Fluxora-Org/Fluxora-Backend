import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig, initializeConfig } from '../config/env.js';
import { verifyIdToken, _resetOidcProviderForTest, preventReplay } from './oidcProvider.js';
import { FakeRedisClient } from '../redis/__test__/fakeRedisClient.js';
import { setRedisClientFactory, DefaultRedisClientFactory, type RedisClientFactory } from '../redis/client.js';

const ISSUER = 'https://idp.example.com';
const AUDIENCE = 'fluxora-dashboard';
const KID = 'test-key-1';

/** Generates a fresh RSA keypair and the matching public JWK (with our test kid). */
function generateKeyPairAndJwk() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwk.kid = KID;
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { jwk, privatePem };
}

describe('OIDC provider — verifyIdToken (end-to-end, mocked JWKS)', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    process.env = { ...originalEnv, NODE_ENV: 'development', OIDC_ISSUER_URL: ISSUER, OIDC_AUDIENCE: AUDIENCE };
    resetConfig();
    initializeConfig();
    await _resetOidcProviderForTest();
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(async () => {
    process.env = originalEnv;
    resetConfig();
    await _resetOidcProviderForTest();
    global.fetch = originalFetch;
  });

  it('verifies a validly signed ID token against a mocked JWKS endpoint', async () => {
    const { jwk, privatePem } = generateKeyPairAndJwk();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ keys: [jwk] }) });

    const idToken = jwt.sign(
      { sub: 'user-123', stellar_address: 'GABC...XYZ', role: 'operator', email: 'a@example.com' },
      privatePem,
      { algorithm: 'RS256', issuer: ISSUER, audience: AUDIENCE, keyid: KID, expiresIn: '5m' },
    );

    const result = await verifyIdToken(idToken);

    expect(result.address).toBe('GABC...XYZ');
    expect(result.role).toBe('operator');
    expect(result.sub).toBe('user-123');
    expect(fetchMock).toHaveBeenCalledWith(`${ISSUER}/.well-known/jwks.json`);
  });

  it('rejects a token signed with a key not present in the JWKS', async () => {
    const { jwk } = generateKeyPairAndJwk();
    const { privatePem: otherPrivatePem } = generateKeyPairAndJwk();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ keys: [jwk] }) });

    const idToken = jwt.sign(
      { sub: 'user-456' },
      otherPrivatePem,
      { algorithm: 'RS256', issuer: ISSUER, audience: AUDIENCE, keyid: 'unknown-kid', expiresIn: '5m' },
    );

    await expect(verifyIdToken(idToken)).rejects.toThrow(/Signing key not found/);
  });

  it('rejects a token with the wrong audience', async () => {
    const { jwk, privatePem } = generateKeyPairAndJwk();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ keys: [jwk] }) });

    const idToken = jwt.sign(
      { sub: 'user-789' },
      privatePem,
      { algorithm: 'RS256', issuer: ISSUER, audience: 'someone-else', keyid: KID, expiresIn: '5m' },
    );

    await expect(verifyIdToken(idToken)).rejects.toThrow(/aud claim/);
  });

  it('rejects replay of the same token', async () => {
    const { jwk, privatePem } = generateKeyPairAndJwk();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ keys: [jwk] }) });

    const idToken = jwt.sign(
      { sub: 'user-999', stellar_address: 'GXYZ' },
      privatePem,
      { algorithm: 'RS256', issuer: ISSUER, audience: AUDIENCE, keyid: KID, expiresIn: '5m' },
    );

    await verifyIdToken(idToken);
    await expect(verifyIdToken(idToken)).rejects.toThrow(/replay/i);
  });

  it('prevents token replay under concurrent requests with FakeRedisClient', async () => {
    process.env.REDIS_ENABLED = 'true';
    resetConfig();
    initializeConfig();

    const fakeRedis = new FakeRedisClient();
    const fakeFactory: RedisClientFactory = {
      createClient: async () => fakeRedis,
    };
    setRedisClientFactory(fakeFactory);
    await _resetOidcProviderForTest();

    const idToken = 'concurrent-test-token-unit-12345';
    const exp = Math.floor(Date.now() / 1000) + 300;

    let successCount = 0;
    let failureCount = 0;
    await Promise.all([
      preventReplay(idToken, exp)
        .then(() => { successCount++; })
        .catch((err) => {
          failureCount++;
          expect(err.message).toContain('Token replay detected');
        }),
      preventReplay(idToken, exp)
        .then(() => { successCount++; })
        .catch((err) => {
          failureCount++;
          expect(err.message).toContain('Token replay detected');
        }),
    ]);

    expect(successCount).toBe(1);
    expect(failureCount).toBe(1);

    setRedisClientFactory(new DefaultRedisClientFactory());
    await _resetOidcProviderForTest();
  });

  it('throws clearly when OIDC is not configured', async () => {
    process.env = { ...originalEnv, NODE_ENV: 'development' };
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_AUDIENCE;
    resetConfig();
    initializeConfig();

    await expect(verifyIdToken('anything')).rejects.toThrow(/OIDC issuer URL is not configured/);
  });
});