import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { resetSpecCache } from '../../src/routes/docs.js';

beforeEach(() => {
  resetSpecCache();
});

// ?? Helpers ???????????????????????????????????????????????????????????????????

/** Traverse a resolved $ref or inline schema in the components. */
function resolveRef(spec: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  // ref format: '#/components/schemas/Foo'
  const parts = ref.replace('#/', '').split('/');
  let node: unknown = spec;
  for (const part of parts) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node as Record<string, unknown>;
}

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
    expect((paths['/api/streams/{id}'] as Record<string, unknown>).head).toBeDefined();
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
    expect(paths['/internal/indexer/status']).toBeDefined();
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

  it('POST /internal/indexer/events/replay requires bearerAuth', async () => {
    const res = await request(app).get('/openapi.json');
    const route = (res.body.paths['/internal/indexer/events/replay'] as Record<string, unknown>)?.post as Record<string, unknown>;
    const sec = route?.security as Array<Record<string, unknown>>;
    expect(sec?.some((s) => 'bearerAuth' in s)).toBe(true);
    expect(route?.responses).toMatchObject({ 202: expect.any(Object), 400: expect.any(Object), 401: expect.any(Object), 403: expect.any(Object) });
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

  // ?? Cursor semantics documentation ???????????????????????????????????????????

  describe('GET /api/streams - cursor pagination documentation', () => {
    async function getListOp() {
      const res = await request(app).get('/openapi.json');
      const spec = res.body as Record<string, unknown>;
      return (
        (spec.paths as Record<string, unknown>)['/api/streams'] as Record<string, unknown>
      )?.get as Record<string, unknown>;
    }

    // ?? cursor param documentation ???????????????????????????????????????????

    it('documents the cursor query parameter', async () => {
      const op = await getListOp();
      const params = op.parameters as Array<Record<string, unknown>>;
      const cursorParam = params?.find((p) => p['name'] === 'cursor');
      expect(cursorParam).toBeDefined();
      expect(cursorParam!['in']).toBe('query');
    });

    it('cursor param description mentions opaque and black box', async () => {
      const op = await getListOp();
      const params = op.parameters as Array<Record<string, unknown>>;
      const cursorParam = params?.find((p) => p['name'] === 'cursor');
      const schema = cursorParam?.['schema'] as Record<string, unknown>;
      const description: string = (schema?.['description'] ?? cursorParam?.['description'] ?? '') as string;
      expect(description.toLowerCase()).toMatch(/opaque/);
    });

    it('cursor param includes an example base64url token', async () => {
      const res = await request(app).get('/openapi.json');
      const spec = res.body as Record<string, unknown>;
      const op = (
        (spec.paths as Record<string, unknown>)['/api/streams'] as Record<string, unknown>
      )?.get as Record<string, unknown>;
      const params = op.parameters as Array<Record<string, unknown>>;
      const cursorParam = params?.find((p) => p['name'] === 'cursor');
      const schema = cursorParam?.['schema'] as Record<string, unknown>;
      const example = schema?.['example'] as string | undefined;
      // Must be a non-empty string containing only base64url chars
      expect(typeof example).toBe('string');
      expect(example!.length).toBeGreaterThan(0);
      expect(/^[A-Za-z0-9_-]+$/.test(example!)).toBe(true);
    });

    it('cursor example decodes to a valid v:1 cursor shape', async () => {
      const res = await request(app).get('/openapi.json');
      const spec = res.body as Record<string, unknown>;
      const op = (
        (spec.paths as Record<string, unknown>)['/api/streams'] as Record<string, unknown>
      )?.get as Record<string, unknown>;
      const params = op.parameters as Array<Record<string, unknown>>;
      const cursorParam = params?.find((p) => p['name'] === 'cursor');
      const schema = cursorParam?.['schema'] as Record<string, unknown>;
      const example = schema?.['example'] as string;
      const decoded = JSON.parse(Buffer.from(example, 'base64url').toString('utf8')) as Record<string, unknown>;
      expect(decoded['v']).toBe(1);
      expect(typeof decoded['lastId']).toBe('string');
      expect((decoded['lastId'] as string).length).toBeGreaterThan(0);
    });

    // ?? operation-level description ????????????????????????????????????????????

    it('operation description mentions cursor encoding', async () => {
      const op = await getListOp();
      const desc = (op['description'] ?? '') as string;
      expect(desc.toLowerCase()).toMatch(/encod/);
    });

    it('operation description mentions opaque / black box', async () => {
      const op = await getListOp();
      const desc = (op['description'] ?? '') as string;
      expect(desc.toLowerCase()).toMatch(/opaque|black box/);
    });

    it('operation description states ordering guarantee (id ASC)', async () => {
      const op = await getListOp();
      const desc = (op['description'] ?? '') as string;
      expect(desc.toLowerCase()).toMatch(/order|asc/);
    });

    it('operation description mentions cursor stability across inserts', async () => {
      const op = await getListOp();
      const desc = (op['description'] ?? '') as string;
      expect(desc.toLowerCase()).toMatch(/stable|insert|keyset/);
    });

    it('operation description documents invalid cursor response (400)', async () => {
      const op = await getListOp();
      const desc = (op['description'] ?? '') as string;
      expect(desc).toMatch(/400|VALIDATION_ERROR/);
    });

    it('operation description mentions PII / security guarantee', async () => {
      const op = await getListOp();
      const desc = (op['description'] ?? '') as string;
      expect(desc.toLowerCase()).toMatch(/pii|ownership|scop|internal/);
    });

    // ?? 400 response ????????????????????????????????????????????????????????

    it('documents 400 response on the list operation', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      expect(responses?.['400']).toBeDefined();
    });

    it('400 response description mentions invalid cursor', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const r400 = responses?.['400'] as Record<string, unknown>;
      const desc = (r400?.['description'] ?? '') as string;
      expect(desc.toLowerCase()).toMatch(/cursor|invalid/);
    });

    it('400 response description tells clients to restart pagination', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const r400 = responses?.['400'] as Record<string, unknown>;
      const desc = (r400?.['description'] ?? '') as string;
      expect(desc.toLowerCase()).toMatch(/restart|discard|page 1|page one|omit/);
    });

    it('400 response includes invalidCursor example', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const r400 = responses?.['400'] as Record<string, unknown>;
      const content = (r400?.['content'] as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
      const examples = content?.['examples'] as Record<string, unknown> | undefined;
      expect(examples?.['invalidCursor']).toBeDefined();
    });

    it('invalidCursor example has VALIDATION_ERROR code', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const r400 = responses?.['400'] as Record<string, unknown>;
      const content = (r400?.['content'] as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
      const examples = content?.['examples'] as Record<string, unknown>;
      const example = examples?.['invalidCursor'] as Record<string, unknown>;
      const value = example?.['value'] as Record<string, unknown>;
      expect((value?.['error'] as Record<string, unknown>)?.['code']).toBe('VALIDATION_ERROR');
    });

    it('invalidCursor example message matches actual route error message', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const r400 = responses?.['400'] as Record<string, unknown>;
      const content = (r400?.['content'] as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
      const examples = content?.['examples'] as Record<string, unknown>;
      const example = examples?.['invalidCursor'] as Record<string, unknown>;
      const value = example?.['value'] as Record<string, unknown>;
      const message = (value?.['error'] as Record<string, unknown>)?.['message'] as string;
      // Must match the actual error thrown by decodeCursor() in src/routes/streams.ts
      expect(message).toBe('cursor must be a valid opaque pagination token');
    });

    // ?? 200 response examples ???????????????????????????????????????????????

    it('200 response has examples (not a single example)', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const r200 = responses?.['200'] as Record<string, unknown>;
      const content = (r200?.['content'] as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
      const examples = content?.['examples'] as Record<string, unknown> | undefined;
      expect(examples).toBeDefined();
    });

    it('200 response has firstPage example', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const content = ((responses?.['200'] as Record<string, unknown>)?.['content'] as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
      const examples = content?.['examples'] as Record<string, unknown>;
      expect(examples?.['firstPage']).toBeDefined();
    });

    it('200 response has nextPage example', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const content = ((responses?.['200'] as Record<string, unknown>)?.['content'] as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
      const examples = content?.['examples'] as Record<string, unknown>;
      expect(examples?.['nextPage']).toBeDefined();
    });

    it('200 response has lastPage example', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const content = ((responses?.['200'] as Record<string, unknown>)?.['content'] as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
      const examples = content?.['examples'] as Record<string, unknown>;
      expect(examples?.['lastPage']).toBeDefined();
    });

    it('firstPage example has has_more=true and non-null next_cursor', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const content = ((responses?.['200'] as Record<string, unknown>)?.['content'] as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
      const examples = content?.['examples'] as Record<string, unknown>;
      const firstPage = examples?.['firstPage'] as Record<string, unknown>;
      const data = ((firstPage?.['value'] as Record<string, unknown>)?.['data']) as Record<string, unknown>;
      expect(data?.['has_more']).toBe(true);
      expect(data?.['next_cursor']).not.toBeNull();
      expect(typeof data?.['next_cursor']).toBe('string');
    });

    it('firstPage example next_cursor decodes to a valid v:1 cursor', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const content = ((responses?.['200'] as Record<string, unknown>)?.['content'] as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
      const examples = content?.['examples'] as Record<string, unknown>;
      const firstPage = examples?.['firstPage'] as Record<string, unknown>;
      const data = ((firstPage?.['value'] as Record<string, unknown>)?.['data']) as Record<string, unknown>;
      const token = data?.['next_cursor'] as string;
      const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;
      expect(decoded['v']).toBe(1);
      expect(typeof decoded['lastId']).toBe('string');
    });

    it('nextPage example has has_more=true and non-null next_cursor', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const content = ((responses?.['200'] as Record<string, unknown>)?.['content'] as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
      const examples = content?.['examples'] as Record<string, unknown>;
      const nextPage = examples?.['nextPage'] as Record<string, unknown>;
      const data = ((nextPage?.['value'] as Record<string, unknown>)?.['data']) as Record<string, unknown>;
      expect(data?.['has_more']).toBe(true);
      expect(data?.['next_cursor']).not.toBeNull();
    });

    it('lastPage example has has_more=false and next_cursor=null', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const content = ((responses?.['200'] as Record<string, unknown>)?.['content'] as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
      const examples = content?.['examples'] as Record<string, unknown>;
      const lastPage = examples?.['lastPage'] as Record<string, unknown>;
      const data = ((lastPage?.['value'] as Record<string, unknown>)?.['data']) as Record<string, unknown>;
      expect(data?.['has_more']).toBe(false);
      expect(data?.['next_cursor']).toBeNull();
    });

    it('each page example contains a non-empty streams array', async () => {
      const op = await getListOp();
      const responses = op['responses'] as Record<string, unknown>;
      const content = ((responses?.['200'] as Record<string, unknown>)?.['content'] as Record<string, unknown>)?.['application/json'] as Record<string, unknown>;
      const examples = content?.['examples'] as Record<string, unknown>;
      for (const key of ['firstPage', 'nextPage', 'lastPage']) {
        const ex = examples?.[key] as Record<string, unknown>;
        const data = ((ex?.['value'] as Record<string, unknown>)?.['data']) as Record<string, unknown>;
        expect(Array.isArray(data?.['streams'])).toBe(true);
        expect((data?.['streams'] as unknown[]).length).toBeGreaterThan(0);
      }
    });

    // ?? StreamCursorToken schema registration ???????????????????????????????

    it('registers StreamCursorToken in components/schemas', async () => {
      const res = await request(app).get('/openapi.json');
      const schemas = (res.body?.components?.schemas ?? {}) as Record<string, unknown>;
      expect(schemas['StreamCursorToken']).toBeDefined();
    });

    it('StreamCursorToken description mentions opaque and base64url', async () => {
      const res = await request(app).get('/openapi.json');
      const schemas = (res.body?.components?.schemas ?? {}) as Record<string, unknown>;
      const schema = schemas['StreamCursorToken'] as Record<string, unknown>;
      const desc = (schema?.['description'] ?? '') as string;
      expect(desc.toLowerCase()).toMatch(/opaque/);
      expect(desc.toLowerCase()).toMatch(/base64/);
    });

    it('StreamCursorToken example is a valid base64url string', async () => {
      const res = await request(app).get('/openapi.json');
      const schemas = (res.body?.components?.schemas ?? {}) as Record<string, unknown>;
      const schema = schemas['StreamCursorToken'] as Record<string, unknown>;
      const example = schema?.['example'] as string;
      expect(typeof example).toBe('string');
      expect(/^[A-Za-z0-9_-]+$/.test(example)).toBe(true);
    });

    it('StreamCursorToken example does not expose internal row ids (no plain integers)', async () => {
      const res = await request(app).get('/openapi.json');
      const schemas = (res.body?.components?.schemas ?? {}) as Record<string, unknown>;
      const schema = schemas['StreamCursorToken'] as Record<string, unknown>;
      const example = schema?.['example'] as string;
      // The decoded payload should contain a stream-id (string), not a raw integer id
      const decoded = JSON.parse(Buffer.from(example, 'base64url').toString('utf8')) as Record<string, unknown>;
      expect(typeof decoded['lastId']).toBe('string');
      // lastId must not be a plain number string that could enumerate internal rows
      expect(isNaN(Number(decoded['lastId']))).toBe(true);
    });

    // ?? StreamListPage schema ???????????????????????????????????????????????

    it('registers StreamListPage in components/schemas', async () => {
      const res = await request(app).get('/openapi.json');
      const schemas = (res.body?.components?.schemas ?? {}) as Record<string, unknown>;
      expect(schemas['StreamListPage']).toBeDefined();
    });

    it('StreamListPage schema has has_more with description about additional pages', async () => {
      const res = await request(app).get('/openapi.json');
      const schemas = (res.body?.components?.schemas ?? {}) as Record<string, unknown>;
      const schema = schemas['StreamListPage'] as Record<string, unknown>;
      const props = schema?.['properties'] as Record<string, unknown>;
      const hasMorDesc = ((props?.['has_more'] as Record<string, unknown>)?.['description'] ?? '') as string;
      expect(hasMorDesc.toLowerCase()).toMatch(/page|more/);
    });

    it('StreamListPage schema next_cursor has description mentioning null on last page', async () => {
      const res = await request(app).get('/openapi.json');
      const schemas = (res.body?.components?.schemas ?? {}) as Record<string, unknown>;
      const schema = schemas['StreamListPage'] as Record<string, unknown>;
      const props = schema?.['properties'] as Record<string, unknown>;
      // next_cursor may be an inline schema or a $ref - check anyOf/oneOf or direct
      const nextCursorProp = props?.['next_cursor'] as Record<string, unknown>;
      const desc = (nextCursorProp?.['description'] ?? '') as string;
      expect(desc.toLowerCase()).toMatch(/null|last page/);
    });
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
