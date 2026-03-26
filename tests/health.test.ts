import request from 'supertest';
import { app } from '../src/app';
import { CORRELATION_ID_HEADER } from '../src/middleware/correlationId';

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('response body includes service and timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.body.service).toBe('fluxora-backend');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('response includes x-correlation-id header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
  });

  it('propagates client-supplied correlation ID', async () => {
    const id = 'health-check-id';
    const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, id);
    expect(res.headers[CORRELATION_ID_HEADER]).toBe(id);
  });
});
