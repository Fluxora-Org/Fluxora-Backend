import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import * as logger from '../../src/lib/logger.js';
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
    expect(res.body).toEqual({ error: 'Missing Authorization header.' });
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
    expect(res.body).toEqual({ error: 'Authorization header must use Bearer scheme.' });
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
    expect(res.body).toEqual({ error: 'Invalid admin credentials.' });
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
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('# HELP');
  });

  it('returns 503 and logs warning when ADMIN_API_KEY is not configured', async () => {
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

  it('emits the canonical single-line JSON shape for a representative warning', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    logger.warn('Admin authorization refused — missing Authorization header', {
      path: '/metrics',
      method: 'GET',
    });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const payload = stdoutSpy.mock.calls[0][0]?.toString();
    expect(payload).toContain('"level":"warn"');
    expect(payload).toContain('"message":"Admin authorization refused — missing Authorization header"');
    expect(payload).toContain('"path":"/metrics"');
    expect(payload).toContain('"method":"GET"');
  });

  it('returns 500 when metrics generation fails', async () => {
    const metricsSpy = vi.spyOn(registry, 'metrics').mockRejectedValueOnce(new Error('Registry error'));

    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    expect(res.status).toBe(500);
    expect(res.text).toBe('Failed to generate metrics');
    expect(metricsSpy).toHaveBeenCalledTimes(1);
  });
});
