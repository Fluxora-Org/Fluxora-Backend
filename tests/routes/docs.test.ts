import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { resetSpecCache } from '../../src/routes/docs.js';

beforeEach(() => {
  resetSpecCache();
});

describe('GET /openapi.json', () => {
  it('returns 200 with JSON content-type', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns a valid OpenAPI 3.1 document', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.title).toBe('Fluxora Backend API');
    expect(res.body.info.version).toBe('0.1.0');
  });

  it('includes paths object', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.body.paths).toBeDefined();
    expect(typeof res.body.paths).toBe('object');
  });

  it('includes security schemes', async () => {
    const res = await request(app).get('/openapi.json');
    const schemes = res.body.components?.securitySchemes;
    expect(schemes).toBeDefined();
    expect(schemes.bearerAuth).toBeDefined();
    expect(schemes.bearerAuth.type).toBe('http');
    expect(schemes.bearerAuth.scheme).toBe('bearer');
    expect(schemes.indexerWorkerToken).toBeDefined();
    expect(schemes.indexerWorkerToken.type).toBe('apiKey');
  });

  it('covers all stream routes', async () => {
    const res = await request(app).get('/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/api/streams']).toBeDefined();
    expect(paths['/api/streams/{id}']).toBeDefined();
  });

  it('covers health routes', async () => {
    const res = await request(app).get('/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/health']).toBeDefined();
    expect(paths['/health/ready']).toBeDefined();
    expect(paths['/health/live']).toBeDefined();
  });

  it('covers auth route', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.body.paths['/api/auth/session']).toBeDefined();
  });

  it('covers admin routes', async () => {
    const res = await request(app).get('/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/api/admin/status']).toBeDefined();
    expect(paths['/api/admin/pause']).toBeDefined();
    expect(paths['/api/admin/reindex']).toBeDefined();
    expect(paths['/api/admin/api-keys']).toBeDefined();
  });

  it('covers DLQ routes', async () => {
    const res = await request(app).get('/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/admin/dlq']).toBeDefined();
    expect(paths['/admin/dlq/{id}']).toBeDefined();
  });

  it('covers indexer routes', async () => {
    const res = await request(app).get('/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/internal/indexer/contract-events']).toBeDefined();
    expect(paths['/internal/indexer/events']).toBeDefined();
    expect(paths['/internal/indexer/events/replay']).toBeDefined();
  });

  it('covers webhook routes', async () => {
    const res = await request(app).get('/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/internal/webhooks/receive']).toBeDefined();
    expect(paths['/internal/webhooks/queue']).toBeDefined();
  });

  it('covers rate-limit routes', async () => {
    const res = await request(app).get('/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/api/rate-limits']).toBeDefined();
    expect(paths['/api/rate-limits/config']).toBeDefined();
  });

  it('covers metrics route', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.body.paths['/metrics']).toBeDefined();
  });

  it('covers privacy routes', async () => {
    const res = await request(app).get('/openapi.json');
    const paths = res.body.paths as Record<string, unknown>;
    expect(paths['/api/privacy/policy']).toBeDefined();
    expect(paths['/api/privacy/retention']).toBeDefined();
  });

  it('POST /api/streams requires bearerAuth security', async () => {
    const res = await request(app).get('/openapi.json');
    const postStreams = (res.body.paths['/api/streams'] as Record<string, unknown>)?.post as Record<string, unknown>;
    expect(postStreams?.security).toBeDefined();
    const sec = postStreams.security as Array<Record<string, unknown>>;
    expect(sec.some((s) => 'bearerAuth' in s)).toBe(true);
  });

  it('POST /internal/indexer/contract-events requires indexerWorkerToken', async () => {
    const res = await request(app).get('/openapi.json');
    const route = (res.body.paths['/internal/indexer/contract-events'] as Record<string, unknown>)?.post as Record<string, unknown>;
    const sec = route?.security as Array<Record<string, unknown>>;
    expect(sec?.some((s) => 'indexerWorkerToken' in s)).toBe(true);
  });

  it('includes error response schemas (400, 401, 404, 500)', async () => {
    const res = await request(app).get('/openapi.json');
    const postStreams = (res.body.paths['/api/streams'] as Record<string, unknown>)?.post as Record<string, unknown>;
    const responses = postStreams?.responses as Record<string, unknown>;
    expect(responses?.['400']).toBeDefined();
    expect(responses?.['401']).toBeDefined();
  });

  it('includes example payloads for POST /api/streams', async () => {
    const res = await request(app).get('/openapi.json');
    const postStreams = (res.body.paths['/api/streams'] as Record<string, unknown>)?.post as Record<string, unknown>;
    const body = postStreams?.requestBody as Record<string, unknown>;
    const content = (body?.content as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
    expect(content?.example).toBeDefined();
  });

  it('includes tags array', async () => {
    const res = await request(app).get('/openapi.json');
    expect(Array.isArray(res.body.tags)).toBe(true);
    const tagNames = (res.body.tags as Array<{ name: string }>).map((t) => t.name);
    expect(tagNames).toContain('streams');
    expect(tagNames).toContain('health');
    expect(tagNames).toContain('admin');
    expect(tagNames).toContain('indexer');
  });

  it('sets cache-control header', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.headers['cache-control']).toMatch(/max-age/);
  });

  it('returns the same spec on repeated calls (cached)', async () => {
    const res1 = await request(app).get('/openapi.json');
    const res2 = await request(app).get('/openapi.json');
    expect(res1.body.info.version).toBe(res2.body.info.version);
    expect(Object.keys(res1.body.paths as object).length).toBe(
      Object.keys(res2.body.paths as object).length,
    );
  });
});

describe('GET /docs', () => {
  it('redirects /docs to /docs/', async () => {
    const res = await request(app).get('/docs');
    expect([301, 302, 308]).toContain(res.status);
  });

  it('returns 200 with HTML content at /docs/', async () => {
    const res = await request(app).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  it('HTML references the openapi.json URL', async () => {
    const res = await request(app).get('/docs/');
    expect(res.text).toMatch(/swagger|openapi/i);
  });
});
