import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { syncWebhookStoreMetrics } from '../../src/metrics/businessMetrics.js';

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
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization header is not Bearer scheme', async () => {
    const res = await request(app).get('/metrics').set('Authorization', `Basic ${ADMIN_KEY}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when Bearer token is invalid', async () => {
    const res = await request(app).get('/metrics').set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(403);
  });

  it('returns 200 with metrics body when token is valid', async () => {
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('# HELP');
  });

  it('exposes webhook backlog gauges only through the admin-protected metrics route', async () => {
    syncWebhookStoreMetrics({ dlqItems: 2, outboxItems: 4 });

    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/fluxora_webhook_dlq_items\{[^}]*\} 2/);
    expect(res.text).toMatch(/fluxora_webhook_outbox_pending_items\{[^}]*\} 4/);
  });

  it('returns 503 when ADMIN_API_KEY is not configured', async () => {
    delete process.env.ADMIN_API_KEY;
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(503);
  });

  it('health endpoint remains unauthenticated', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});