/**
 * Blue/Green Deployment Slot Header Tests
 *
 * Verifies that the `X-Fluxora-Deployment-Slot` response header is emitted
 * on every HTTP response, including errors, and that its value reflects the
 * `DEPLOYMENT_SLOT` environment variable.
 *
 * Closes: #739
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('Blue/Green deployment slot header (#739)', () => {
  const ORIGINAL_DEPLOYMENT_SLOT = process.env.DEPLOYMENT_SLOT;

  afterEach(() => {
    // Restore env after each test.
    if (ORIGINAL_DEPLOYMENT_SLOT === undefined) {
      delete process.env.DEPLOYMENT_SLOT;
    } else {
      process.env.DEPLOYMENT_SLOT = ORIGINAL_DEPLOYMENT_SLOT;
    }
  });

  it('defaults to "blue" when DEPLOYMENT_SLOT is not set', async () => {
    delete process.env.DEPLOYMENT_SLOT;
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
  });

  it('returns "green" when DEPLOYMENT_SLOT=green', async () => {
    process.env.DEPLOYMENT_SLOT = 'green';
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.headers['x-fluxora-deployment-slot']).toBe('green');
  });

  it('returns "blue" when DEPLOYMENT_SLOT=blue', async () => {
    process.env.DEPLOYMENT_SLOT = 'blue';
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
  });

  it('header is present on 404 responses', async () => {
    delete process.env.DEPLOYMENT_SLOT;
    const app = createApp();
    const res = await request(app).get('/nonexistent-route-xyz');
    expect(res.status).toBe(404);
    expect(res.headers['x-fluxora-deployment-slot']).toBeDefined();
    expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
  });

  it('header is present on 200 responses from root endpoint', async () => {
    process.env.DEPLOYMENT_SLOT = 'blue';
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
  });

  it('sanitises non-conforming DEPLOYMENT_SLOT values to "blue"', async () => {
    // Header injection attempt — must be rejected
    process.env.DEPLOYMENT_SLOT = 'blue\r\nX-Evil-Header: injected';
    const app = createApp();
    const res = await request(app).get('/health');
    // Should fall back to 'blue' because the value contains non-[a-z0-9-] chars
    expect(res.headers['x-fluxora-deployment-slot']).toBe('blue');
    expect(res.headers['x-evil-header']).toBeUndefined();
  });

  it('allows alphanumeric slot names like "canary-1"', async () => {
    process.env.DEPLOYMENT_SLOT = 'canary-1';
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.headers['x-fluxora-deployment-slot']).toBe('canary-1');
  });

  it('reads DEPLOYMENT_SLOT at request time, not module load time', async () => {
    // Start with blue
    process.env.DEPLOYMENT_SLOT = 'blue';
    const app = createApp();

    const res1 = await request(app).get('/health');
    expect(res1.headers['x-fluxora-deployment-slot']).toBe('blue');

    // Change mid-flight (simulates env mutation during tests)
    process.env.DEPLOYMENT_SLOT = 'green';
    const res2 = await request(app).get('/health');
    expect(res2.headers['x-fluxora-deployment-slot']).toBe('green');
  });

  it('header is present on health check live endpoint', async () => {
    process.env.DEPLOYMENT_SLOT = 'green';
    const app = createApp();
    const res = await request(app).get('/health/live');
    expect(res.headers['x-fluxora-deployment-slot']).toBe('green');
  });
});
