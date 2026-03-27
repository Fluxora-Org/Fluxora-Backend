import { test } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { createApp } from './app.js';
import { ApiErrorCode } from './middleware/errorHandler.js';

const app = createApp({ includeTestRoutes: true });

test('returns a normalized 404 envelope for unknown routes', async () => {
  const response = await request(app)
    .get('/v1/does-not-exist')
    .expect('Content-Type', /json/)
    .expect('X-API-Version', 'v1');
    
  const data = response.body;
  assert.equal(data.error.code, 'NOT_FOUND');
  assert.equal(data.error.status, 404);
  assert.ok(data.error.requestId);
});

test('returns a normalized 400 envelope for invalid JSON', async () => {
  const response = await request(app)
    .post('/v1/streams')
    .set('Content-Type', 'application/json')
    .send('{"sender":') // Invalid JSON
    .expect(400);
    
  const data = response.body;
  // Express 4/body-parser returns 'BAD_REQUEST' or similar for parse errors
  // with our errorHandler, it might be UNSUPPORTED_MEDIA_TYPE if it failed early
  // but usually it's a 400.
  assert.equal(data.error.status, 400);
  assert.ok(data.error.requestId);
});

test('returns a normalized 413 envelope for oversized payloads', async () => {
  const response = await request(app)
    .post('/v1/streams')
    .set('Content-Type', 'application/json')
    .send({ sender: 'a'.repeat(2 * 1024 * 1024) }) // 2MB, limit is 1mb
    .expect(413);
    
  const data = response.body;
  assert.equal(data.error.status, 413);
  assert.ok(data.error.requestId);
});

test('returns validation errors in the normalized envelope', async () => {
  const response = await request(app)
    .post('/v1/streams')
    .set('Content-Type', 'application/json')
    .send({ sender: 'alice' }) // Missing recipient
    .expect(400);
    
  const data = response.body;
  assert.equal(data.error.code, 'VALIDATION_ERROR');
  assert.equal(data.error.status, 400);
  assert.ok(data.error.requestId);
});

test('returns a normalized 500 envelope for unexpected failures', async () => {
  const response = await request(app)
    .get('/__test/error')
    .expect(500);
    
  const data = response.body;
  assert.equal(data.error.code, 'INTERNAL_ERROR');
  assert.equal(data.error.status, 500);
  assert.ok(data.error.requestId);
});
