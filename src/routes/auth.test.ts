import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { resetConfig, initializeConfig } from '../config/env.js';
import { isErrorEnvelope } from '../utils/response.js';

vi.mock('../services/oidcProvider.js', () => ({
  verifyIdToken: vi.fn(),
}));

import { verifyIdToken } from '../services/oidcProvider.js';
import { authRouter } from './auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { setAuthAttemptStore } from '../middleware/authLockout.js';
import { generateToken } from '../lib/auth.js';

function makeApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', authRouter);
  // Use the canonical error handler so error responses match the documented schema.
  app.use(errorHandler);
  return app;
}

describe('POST /api/auth/session — OIDC path', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    setAuthAttemptStore(null as any);
    process.env = { ...originalEnv, NODE_ENV: 'development', OIDC_ISSUER_URL: 'https://idp.example.com', OIDC_AUDIENCE: 'fluxora-dashboard' };
    resetConfig();
    initializeConfig();
    vi.clearAllMocks();
  });

  afterEach(() => {
    setAuthAttemptStore(null as any);
    process.env = originalEnv;
    resetConfig();
  });

  it('issues a session token from a verified idToken', async () => {
    (verifyIdToken as any).mockResolvedValue({
      address: 'GABC...XYZ',
      role: 'operator',
      sub: 'user-123',
      claims: {},
    });

    const res = await request(makeApp())
      .post('/api/auth/session')
      .send({ idToken: 'fake-but-verified-token' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.address).toBe('GABC...XYZ');
    expect(res.body.data.user.role).toBe('operator');
  });

  it('rejects with 401 when OIDC verification fails — error matches canonical shape', async () => {
    (verifyIdToken as any).mockRejectedValue(new Error('Token verification failed'));

    const res = await request(makeApp())
      .post('/api/auth/session')
      .send({ idToken: 'bad-token' });

    expect(res.status).toBe(401);
    expect(isErrorEnvelope(res.body)).toBe(true);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects idToken login with a clear error when OIDC is not configured — error matches canonical shape', async () => {
    process.env = { ...originalEnv, NODE_ENV: 'development' };
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_AUDIENCE;
    resetConfig();
    initializeConfig();

    const res = await request(makeApp())
      .post('/api/auth/session')
      .send({ idToken: 'anything' });

    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res.body)).toBe(true);
    expect(res.body.error.message).toMatch(/not configured/i);
  });

  it('rejects malformed session payloads and empty address boundary values with the validation envelope', async () => {
    const res = await request(makeApp())
      .post('/api/auth/session')
      .send({ address: '', role: 'viewer' });

    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res.body)).toBe(true);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/Stellar address is required/i);

    const invalidRole = await request(makeApp())
      .post('/api/auth/session')
      .send({ address: 'GABC...', role: 'admin' });

    expect(invalidRole.status).toBe(400);
    expect(isErrorEnvelope(invalidRole.body)).toBe(true);
    expect(invalidRole.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('records failed OIDC credentials and trips the lockout middleware before the next request', async () => {
    const store = {
      isLockedOut: vi.fn().mockResolvedValue(0),
      recordFailure: vi.fn().mockResolvedValue(undefined),
      resetAttempts: vi.fn().mockResolvedValue(undefined),
    };
    setAuthAttemptStore(store as any);
    (verifyIdToken as any).mockRejectedValue(new Error('Token verification failed'));

    const failure = await request(makeApp())
      .post('/api/auth/session')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ idToken: 'wrong-token', address: 'GABC...XYZ' });

    expect(failure.status).toBe(401);
    expect(isErrorEnvelope(failure.body)).toBe(true);
    expect(failure.body.error.code).toBe('UNAUTHORIZED');
    expect(store.recordFailure).toHaveBeenCalledWith('203.0.113.10');
    expect(store.recordFailure).toHaveBeenCalledWith('GABC...XYZ');

    store.isLockedOut.mockResolvedValue(60);
    const locked = await request(makeApp())
      .post('/api/auth/session')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ idToken: 'wrong-token', address: 'GABC...XYZ' });

    expect(locked.status).toBe(429);
    expect(isErrorEnvelope(locked.body)).toBe(true);
    expect(locked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(locked.body.error.message).toBe('Too many failed attempts, try again later');
    expect(locked.headers['retry-after']).toBe('60');
  });
});

describe('POST /api/auth/revoke — authorization and payload validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    setAuthAttemptStore(null as any);
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      JWT_SECRET: 'test-secret-value-32-plus-characters',
      JWT_SECRET_PREVIOUS: 'previous-test-secret-value-32-plus',
    };
    resetConfig();
    initializeConfig();
  });

  afterEach(() => {
    setAuthAttemptStore(null as any);
    process.env = originalEnv;
    resetConfig();
  });

  it('returns a canonical 401 for missing authorization', async () => {
    const res = await request(makeApp())
      .post('/api/auth/revoke')
      .send({ jti: 'abc', exp: Math.floor(Date.now() / 1000) + 3600 });

    expect(res.status).toBe(401);
    expect(isErrorEnvelope(res.body)).toBe(true);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Authentication required to access this resource');
  });

  it('returns a canonical 403 for insufficient authorization', async () => {
    const token = generateToken({ address: 'GVIEWER', role: 'viewer', permissions: ['streams:read'] });
    const res = await request(makeApp())
      .post('/api/auth/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ jti: 'abc', exp: Math.floor(Date.now() / 1000) + 3600 });

    expect(res.status).toBe(403);
    expect(isErrorEnvelope(res.body)).toBe(true);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Insufficient permissions to access this resource');
  });

  it('rejects malformed payloads and boundary values with the validation envelope', async () => {
    const adminToken = generateToken({ address: 'GADMIN', role: 'admin', permissions: ['admin:pause'] });

    const missingJti = await request(makeApp())
      .post('/api/auth/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ jti: '', exp: Math.floor(Date.now() / 1000) + 3600 });

    expect(missingJti.status).toBe(400);
    expect(isErrorEnvelope(missingJti.body)).toBe(true);
    expect(missingJti.body.error.code).toBe('VALIDATION_ERROR');

    const zeroExp = await request(makeApp())
      .post('/api/auth/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ jti: 'abc', exp: 0 });

    expect(zeroExp.status).toBe(400);
    expect(isErrorEnvelope(zeroExp.body)).toBe(true);
    expect(zeroExp.body.error.code).toBe('VALIDATION_ERROR');

    const zeroTtl = await request(makeApp())
      .post('/api/auth/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ jti: 'abc', exp: Math.floor(Date.now() / 1000) + 3600, ttl: 0 });

    expect(zeroTtl.status).toBe(400);
    expect(isErrorEnvelope(zeroTtl.body)).toBe(true);
    expect(zeroTtl.body.error.code).toBe('VALIDATION_ERROR');
  });
});
