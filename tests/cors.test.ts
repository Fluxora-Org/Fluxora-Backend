import express from 'express';
import request from 'supertest';
import { corsAllowlistMiddleware } from '../src/middleware/cors';

describe('CORS allowlist policy', () => {
  const app = express();

  app.use(corsAllowlistMiddleware);
  app.get(
    '/health',
    (
      _req: unknown,
      res: { status: (code: number) => { json: (body: unknown) => void } },
    ) => {
    res.status(200).json({ status: 'ok' });
    },
  );

  const originalNodeEnv = process.env.NODE_ENV;
  const originalCorsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalCorsAllowedOrigins === undefined) {
      delete process.env.CORS_ALLOWED_ORIGINS;
    } else {
      process.env.CORS_ALLOWED_ORIGINS = originalCorsAllowedOrigins;
    }
  });

  it('allows any origin in non-production', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CORS_ALLOWED_ORIGINS;

    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://frontend.local');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://frontend.local');
    expect(res.headers.vary).toContain('Origin');
  });

  it('allows allowlisted origin in production preflight', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.fluxora.io,https://ops.fluxora.io';

    const res = await request(app)
      .options('/api/streams')
      .set('Origin', 'https://app.fluxora.io')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.fluxora.io');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('denies non-allowlisted origin in production preflight', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.fluxora.io';

    const res = await request(app)
      .options('/api/streams')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORS_ORIGIN_DENIED');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not emit CORS allow header when production allowlist is unset', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CORS_ALLOWED_ORIGINS;

    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://frontend.local');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
