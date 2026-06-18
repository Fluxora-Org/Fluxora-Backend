import express from 'express';
import request from 'supertest';
import { corsAllowlistMiddleware } from '../src/middleware/cors';

describe('CORS allowlist policy', () => {
  const app = express();

  app.use(corsAllowlistMiddleware);
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.options('/api/streams', (_req, res) => {
    res.sendStatus(204);
  });

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

  // ── Development / non-production ──────────────────────────────────────────

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

  it('returns Access-Control-Max-Age on preflight in non-production', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CORS_ALLOWED_ORIGINS;

    const res = await request(app)
      .options('/api/streams')
      .set('Origin', 'https://frontend.local')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-max-age']).toBe('86400');
  });

  it('echoes Access-Control-Request-Headers in non-production preflight', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CORS_ALLOWED_ORIGINS;

    const res = await request(app)
      .options('/api/streams')
      .set('Origin', 'https://frontend.local')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'X-Custom-Header,Authorization');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toBe('X-Custom-Header,Authorization');
  });

  it('uses default allowed headers when Access-Control-Request-Headers is absent', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CORS_ALLOWED_ORIGINS;

    const res = await request(app)
      .options('/api/streams')
      .set('Origin', 'https://frontend.local')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toBe(
      'Content-Type,Authorization,X-Correlation-ID',
    );
  });

  // ── OPTIONS without Origin ─────────────────────────────────────────────────

  it('returns 204 for OPTIONS without Origin (non-browser probe)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.fluxora.io';

    const res = await request(app).options('/api/streams');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('passes through non-OPTIONS requests without Origin', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.fluxora.io';

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // ── Production: allowlisted origin ────────────────────────────────────────

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
    expect(res.headers['access-control-max-age']).toBe('86400');
  });

  it('allows second allowlisted origin in production preflight', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.fluxora.io,https://ops.fluxora.io';

    const res = await request(app)
      .options('/api/streams')
      .set('Origin', 'https://ops.fluxora.io')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://ops.fluxora.io');
  });

  it('allows allowlisted origin on non-preflight request in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.fluxora.io';

    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://app.fluxora.io');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.fluxora.io');
  });

  it('echoes Access-Control-Request-Headers in production preflight', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.fluxora.io';

    const res = await request(app)
      .options('/api/streams')
      .set('Origin', 'https://app.fluxora.io')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'X-Idempotency-Key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toBe('X-Idempotency-Key');
  });

  // ── Production: denied origin ──────────────────────────────────────────────

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

  it('passes through (no CORS headers) non-allowlisted origin on non-preflight in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.fluxora.io';

    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://evil.example');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // ── Production: empty / unset allowlist ───────────────────────────────────

  it('does not emit CORS allow header when production allowlist is unset', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CORS_ALLOWED_ORIGINS;

    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://frontend.local');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('denies preflight when production allowlist is unset', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CORS_ALLOWED_ORIGINS;

    const res = await request(app)
      .options('/api/streams')
      .set('Origin', 'https://frontend.local')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORS_ORIGIN_DENIED');
  });

  // ── Whitespace handling in CORS_ALLOWED_ORIGINS ───────────────────────────

  it('trims whitespace around origins in CORS_ALLOWED_ORIGINS', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = '  https://app.fluxora.io , https://ops.fluxora.io  ';

    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://app.fluxora.io');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.fluxora.io');
  });

  it('trims whitespace and allows second origin', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = '  https://app.fluxora.io , https://ops.fluxora.io  ';

    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://ops.fluxora.io');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://ops.fluxora.io');
  });
});
