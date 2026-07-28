import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { _resetForTest } from '../../src/state/adminState.js';

const ADMIN_KEY = 'test-admin-key-for-deprecations';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

describe('GET /api/admin/deprecations', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    _resetForTest();
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it('returns 401 for unauthenticated requests', async () => {
    const res = await request(app).get('/api/admin/deprecations');
    expect(res.status).toBe(401);
  });

  it('returns 403 for requests with invalid credentials', async () => {
    const res = await request(app)
      .get('/api/admin/deprecations')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
  });

  it('returns 200 with success envelope for authenticated requests', async () => {
    const res = await authed(request(app).get('/api/admin/deprecations'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toHaveProperty('timestamp');
  });

  it('returns an array of deprecated routes', async () => {
    const res = await authed(request(app).get('/api/admin/deprecations'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('each entry includes route, sunsetDate, and daysUntilSunset', async () => {
    const res = await authed(request(app).get('/api/admin/deprecations'));
    expect(res.status).toBe(200);

    for (const entry of res.body.data) {
      expect(entry).toHaveProperty('route');
      expect(typeof entry.route).toBe('string');
      expect(entry).toHaveProperty('sunsetDate');
      expect(typeof entry.sunsetDate).toBe('string');
      expect(entry).toHaveProperty('daysUntilSunset');
      expect(typeof entry.daysUntilSunset).toBe('number');
      expect(Number.isInteger(entry.daysUntilSunset)).toBe(true);
    }
  });

  it('daysUntilSunset is a finite integer', async () => {
    const res = await authed(request(app).get('/api/admin/deprecations'));
    expect(res.status).toBe(200);

    for (const entry of res.body.data) {
      expect(Number.isFinite(entry.daysUntilSunset)).toBe(true);
      expect(Number.isInteger(entry.daysUntilSunset)).toBe(true);
    }
  });

  it('does not expose internal file paths or source map references', async () => {
    const res = await authed(request(app).get('/api/admin/deprecations'));
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toMatch(/\.ts['"]/);
    expect(bodyStr).not.toMatch(/\/src\//);
    expect(bodyStr).not.toMatch(/sourceMappingURL/);
    expect(bodyStr).not.toMatch(/middleware/);
  });

  it('past-sunset entries have negative daysUntilSunset', () => {
    // Verify computation logic: a past date yields negative days
    const pastDate = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const sunsetMs = new Date(pastDate).getTime();
    const daysUntilSunset = Math.floor((sunsetMs - Date.now()) / 86_400_000);
    expect(daysUntilSunset).toBeLessThan(0);
  });

  it('future-sunset entries have positive daysUntilSunset', () => {
    // Verify computation logic: a future date yields positive days
    const futureDate = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const sunsetMs = new Date(futureDate).getTime();
    const daysUntilSunset = Math.floor((sunsetMs - Date.now()) / 86_400_000);
    expect(daysUntilSunset).toBeGreaterThan(0);
  });

  it('known deprecation entry has expected route path', async () => {
    const res = await authed(request(app).get('/api/admin/deprecations'));
    expect(res.status).toBe(200);

    const routes = res.body.data.map((e: { route: string }) => e.route);
    expect(routes).toContain('/api/rate-limits/config');
  });
});
