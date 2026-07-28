import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';

describe('404 catch-all handler', () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  it('returns structured 404 for unmatched GET routes', async () => {
    const res = await request(app).get('/this-route-does-not-exist-12345');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found',
        requestId: expect.any(String),
      },
    });
  });

  it('returns structured 404 for unmatched POST routes', async () => {
    const res = await request(app).post('/nonexistent-path');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('The requested resource was not found');
  });

  it('returns structured 404 for unmatched methods on existing paths', async () => {
    const res = await request(app).patch('/health');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});