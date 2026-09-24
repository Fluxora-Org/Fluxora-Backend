import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import * as logger from '../../src/utils/logger.js';
import { registry } from '../../src/metrics.js';

const ADMIN_KEY = 'test-metrics-admin-key';

describe('GET /metrics auth', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it('returns 401 and logs warning when Authorization header is missing', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(401);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Admin authorization refused — missing Authorization header'),
      expect.objectContaining({
        path: '/metrics',
        method: 'GET',
      })
    );
  });

  it('returns 401 and logs warning when Authorization header is not Bearer scheme', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const res = await request(app).get('/metrics').set('Authorization', `Basic ${ADMIN_KEY}`);
    expect(res.status).toBe(401);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Admin authorization refused — invalid Authorization header scheme'),
      expect.objectContaining({
        path: '/metrics',
        method: 'GET',
      })
    );
  });

  it('returns 403 and logs warning when Bearer token is invalid without leaking credentials', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const invalidToken = 'wrong-token-abc';
    const res = await request(app).get('/metrics').set('Authorization', `Bearer ${invalidToken}`);
    expect(res.status).toBe(403);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Admin authorization refused — invalid admin credentials'),
      expect.objectContaining({
        path: '/metrics',
        method: 'GET',
      })
    );

    for (const call of warnSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(invalidToken);
      expect(serialized).not.toContain(ADMIN_KEY);
    }
  });

  it('returns 200 with metrics body when token is valid', async () => {
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('# HELP');
  });

  it('health endpoint remains unauthenticated', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('returns 401 with correct error shape when Authorization header is missing', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing Authorization header.' });
  });

  it('returns 401 with correct error shape when Authorization header is not Bearer scheme', async () => {
    const res = await request(app).get('/metrics').set('Authorization', `Basic ${ADMIN_KEY}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authorization header must use Bearer scheme.' });
  });

  it('returns 401 with correct error shape when Authorization header exceeds maximum length (8192 bytes)', async () => {
    const oversizedToken = 'A'.repeat(8193);
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${oversizedToken}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authorization header too large.' });
  });

  it('passes header size check when Authorization header is under boundary (8191 bytes)', async () => {
    // Bearer + space + 8184 chars = 8191 total (should pass size check but fail auth)
    const maxToken = 'A'.repeat(8184);
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${maxToken}`);
    expect(res.status).toBe(403); // Passes size check, but JWT verification fails with 403
    expect(res.body).toEqual({ error: 'Invalid admin credentials.' });
  });

  it('returns 401 with correct error shape when Bearer token is missing after scheme', async () => {
    const res = await request(app).get('/metrics').set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authorization header must use Bearer scheme.' });
  });

  it('returns 401 with correct error shape when Authorization header has wrong number of parts', async () => {
    const res = await request(app).get('/metrics').set('Authorization', 'Bearer token extra');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authorization header must use Bearer scheme.' });
  });

  it('returns 401 with correct error shape when Authorization header has no scheme', async () => {
    const res = await request(app).get('/metrics').set('Authorization', ADMIN_KEY);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authorization header must use Bearer scheme.' });
  });

  it('returns 403 with correct error shape for invalid credentials', async () => {
    const res = await request(app).get('/metrics').set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Invalid admin credentials.' });
  });

  it('returns 503 with correct error shape when ADMIN_API_KEY is not configured', async () => {
    delete process.env.ADMIN_API_KEY;
    const warnSpy = vi.spyOn(logger, 'warn');
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'Admin API is not configured. Set ADMIN_API_KEY to enable admin access.',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Admin authorization refused — ADMIN_API_KEY is not configured'),
      expect.objectContaining({
        path: '/metrics',
        method: 'GET',
      })
    );
  });

  it('ensures no high-cardinality label exposes per-user data in the scraped metrics payload', async () => {
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    expect(res.status).toBe(200);
    const metricsText = res.text;

    // No Stellar public key addresses (G followed by 55 alphanumeric characters)
    expect(metricsText).not.toMatch(/G[A-Z0-9]{55}/);

    // No email addresses
    expect(metricsText).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

    // No raw secret tokens
    expect(metricsText).not.toContain(ADMIN_KEY);
  });

  it('returns 500 when metrics generation fails', async () => {
    const metricsSpy = vi.spyOn(registry, 'metrics').mockRejectedValueOnce(new Error('Registry error'));
    
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    
    expect(res.status).toBe(500);
    expect(res.text).toBe('Failed to generate metrics');
    
    metricsSpy.mockRestore();
  });
});
