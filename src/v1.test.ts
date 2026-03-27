import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from './app.js';

describe('V1 API Integration', () => {
  let app: any;

  beforeEach(() => {
    app = createApp();
  });

  it('should expose API discovery at root', async () => {
    const res = await request(app).get('/');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, 'Fluxora API');
    assert.strictEqual(res.body.current_version, '/v1');
  });

  it('should respond to v1 health check', async () => {
    const res = await request(app).get('/v1/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
  });

  it('should respond with 404 for unknown v1 routes in standard envelope', async () => {
    const res = await request(app).get('/v1/unknown');
    assert.strictEqual(res.status, 404);
    assert.ok(res.body.error);
    assert.strictEqual(res.body.error.code, 'NOT_FOUND');
    assert.ok(res.body.error.requestId);
  });

  it('should handle legacy routes with deprecation headers', async () => {
    const res = await request(app).get('/api/streams');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['deprecation'], 'true');
    assert.ok(res.headers['link']);
  });

  it('should return 405 for unsupported methods on known routes', async () => {
    const res = await request(app).post('/v1/health');
    assert.strictEqual(res.status, 405);
    assert.strictEqual(res.body.error.code, 'METHOD_NOT_ALLOWED');
  });
});
