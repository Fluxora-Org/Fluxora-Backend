import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { resetConfig, initializeConfig } from '../config/env.js';

vi.mock('../services/oidcProvider.js', () => ({
  verifyIdToken: vi.fn(),
}));

import { verifyIdToken } from '../services/oidcProvider.js';
import { authRouter } from './auth.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 500).json({ error: err.message });
  });
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
    expect(res.body.token).toBeDefined();
    expect(res.body.user.address).toBe('GABC...XYZ');
    expect(res.body.user.role).toBe('operator');
  });

  it('rejects with 401 when OIDC verification fails', async () => {
    (verifyIdToken as any).mockRejectedValue(new Error('Token verification failed'));

    const res = await request(makeApp())
      .post('/api/auth/session')
      .send({ idToken: 'bad-token' });

    expect(res.status).toBe(401);
  });

  it('rejects idToken login with a clear error when OIDC is not configured', async () => {
    process.env = { ...originalEnv, NODE_ENV: 'development' };
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_AUDIENCE;
    resetConfig();
    initializeConfig();

    const res = await request(makeApp())
      .post('/api/auth/session')
      .send({ idToken: 'anything' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not configured/i);
  });
});