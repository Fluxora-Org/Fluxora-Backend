/**
 * Integration tests for GET /api/privacy/retention
 *
 * Verifies the endpoint returns RETENTION_SCHEDULE from src/pii/policy.ts
 * with correct shape, headers, and HTTP semantics.
 */

import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { app } from '../src/app.js';
import { RETENTION_SCHEDULE } from '../src/pii/policy.js';

describe('GET /api/privacy/retention', () => {
  it('returns 200 with JSON content-type', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('response contains retentionSchedule array', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.body).toHaveProperty('retentionSchedule');
    expect(Array.isArray(res.body.retentionSchedule)).toBe(true);
  });

  it('retentionSchedule matches the exported RETENTION_SCHEDULE constant', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.body.retentionSchedule).toEqual(RETENTION_SCHEDULE);
  });

  it('each retention rule has required fields: category, retentionDays, storageLayer, rationale', async () => {
    const res = await request(app).get('/api/privacy/retention');
    for (const rule of res.body.retentionSchedule) {
      expect(rule).toHaveProperty('category');
      expect(rule).toHaveProperty('retentionDays');
      expect(rule).toHaveProperty('storageLayer');
      expect(rule).toHaveProperty('rationale');
    }
  });

  it('response includes _links with self and fullPolicy', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.body._links).toMatchObject({
      self: '/api/privacy/retention',
      fullPolicy: '/api/privacy/policy',
    });
  });

  it('sets Cache-Control: no-store header', async () => {
    const res = await request(app).get('/api/privacy/retention');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 405 for POST requests', async () => {
    const res = await request(app).post('/api/privacy/retention').send({});
    expect(res.status).toBe(405);
  });

  it('returns at least one retention rule with null retentionDays for chain data', async () => {
    const res = await request(app).get('/api/privacy/retention');
    const chainRule = res.body.retentionSchedule.find(
      (r: { retentionDays: number | null }) => r.retentionDays === null,
    );
    expect(chainRule).toBeDefined();
  });
});
