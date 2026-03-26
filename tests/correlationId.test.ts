import request from 'supertest';
import { app } from '../src/app';
import { CORRELATION_ID_HEADER } from '../src/middleware/correlationId';

describe('correlationId middleware', () => {
  describe('ID generation', () => {
    it('generates a correlation ID when none is provided', async () => {
      const res = await request(app).get('/health');
      expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
      expect(typeof res.headers[CORRELATION_ID_HEADER]).toBe('string');
      expect(res.headers[CORRELATION_ID_HEADER].length).toBeGreaterThan(0);
    });

    it('generated ID looks like a UUID v4', async () => {
      const res = await request(app).get('/health');
      const id: string = res.headers[CORRELATION_ID_HEADER];
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('generates a unique ID for each request', async () => {
      const [r1, r2] = await Promise.all([
        request(app).get('/health'),
        request(app).get('/health'),
      ]);
      expect(r1.headers[CORRELATION_ID_HEADER]).not.toBe(r2.headers[CORRELATION_ID_HEADER]);
    });
  });

  describe('ID propagation', () => {
    it('reuses the incoming x-correlation-id header', async () => {
      const clientId = 'my-client-id-123';
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, clientId);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe(clientId);
    });

    it('trims whitespace from incoming header', async () => {
      const clientId = '  trimmed-id  ';
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, clientId);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe('trimmed-id');
    });

    it('generates a new ID when incoming header is an empty string', async () => {
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, '');
      const id: string = res.headers[CORRELATION_ID_HEADER];
      expect(id.length).toBeGreaterThan(0);
    });

    it('generates a new ID when incoming header is only whitespace', async () => {
      const res = await request(app).get('/health').set(CORRELATION_ID_HEADER, '   ');
      const id: string = res.headers[CORRELATION_ID_HEADER];
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe('header on every route', () => {
    it('sets correlation ID on GET /', async () => {
      const res = await request(app).get('/');
      expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
    });

    it('sets correlation ID on GET /health', async () => {
      const res = await request(app).get('/health');
      expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
    });

    it('sets correlation ID on GET /api/streams', async () => {
      const res = await request(app).get('/api/streams');
      expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
    });

    it('sets correlation ID on POST /api/streams', async () => {
      const res = await request(app)
        .post('/api/streams')
        .send({ sender: 'A', recipient: 'B', depositAmount: '100', ratePerSecond: '1', startTime: 0 });
      expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
    });
  });
});
