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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  // Use the canonical error handler so error responses match the documented schema.
  app.use(errorHandler);
  return app;
}

describe('POST /api/auth/session — OIDC path', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'development', OIDC_ISSUER_URL: 'https://idp.example.com', OIDC_AUDIENCE: 'fluxora-dashboard' };
    resetConfig();
    initializeConfig();
    vi.clearAllMocks();
  });

  afterEach(() => {
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
});
