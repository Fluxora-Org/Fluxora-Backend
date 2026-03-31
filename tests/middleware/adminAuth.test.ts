import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { requireAdminAuth } from '../../src/middleware/adminAuth.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requireAdminAuth);
  app.get('/protected', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('requireAdminAuth middleware', () => {
  const ADMIN_KEY = 'test-admin-secret-key-1234';
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it('returns 503 when ADMIN_API_KEY is not set', async () => {
    delete process.env.ADMIN_API_KEY;
    const res = await request(buildApp()).get('/protected');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('returns 401 when Authorization header is missing', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp()).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Missing Authorization/i);
  });

  it('returns 401 when Authorization header is not Bearer scheme', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Basic ${ADMIN_KEY}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Bearer scheme/i);
  });

  it('returns 401 when Authorization header has too many parts', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', 'Bearer token extra');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Bearer scheme/i);
  });

  it('returns 403 when token is wrong', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid admin credentials/i);
  });

  it('returns 403 when token has wrong length', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', 'Bearer short');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid admin credentials/i);
  });

  it('passes through when token matches ADMIN_API_KEY', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
