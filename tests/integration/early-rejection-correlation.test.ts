import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { BODY_LIMIT_BYTES } from '../../src/middleware/requestProtection.js';
import { CORRELATION_ID_HEADER } from '../../src/middleware/correlationId.js';

describe('Early rejection correlation IDs', () => {
  it('includes a correlation ID when rejecting an oversized body with 413', async () => {
    // Generate a payload that exceeds the body size limit
    const padding = 'x'.repeat(BODY_LIMIT_BYTES + 1);
    
    const res = await request(app)
      .post('/api/streams')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
      .send(`{"data":"${padding}"}`);

    expect(res.status).toBe(413);
    const correlationId = res.headers[CORRELATION_ID_HEADER];
    expect(correlationId).toBeDefined();
    expect(typeof correlationId).toBe('string');
    expect(correlationId.length).toBeGreaterThan(0);
  });

  it('includes a correlation ID when rejecting a wrong Content-Type with 415', async () => {
    const res = await request(app)
      .post('/api/streams')
      .set('Content-Type', 'text/plain')
      .set('Accept', 'application/json')
      .send('not json');

    expect(res.status).toBe(415);
    const correlationId = res.headers[CORRELATION_ID_HEADER];
    expect(correlationId).toBeDefined();
    expect(typeof correlationId).toBe('string');
    expect(correlationId.length).toBeGreaterThan(0);
  });

  it('includes a correlation ID when rejecting an unsatisfiable Accept header with 406', async () => {
    const res = await request(app)
      .get('/api/streams')
      .set('Accept', 'text/html');

    expect(res.status).toBe(406);
    const correlationId = res.headers[CORRELATION_ID_HEADER];
    expect(correlationId).toBeDefined();
    expect(typeof correlationId).toBe('string');
    expect(correlationId.length).toBeGreaterThan(0);
  });
});
