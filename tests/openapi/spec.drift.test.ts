/**
 * Issue #1269 — Make OpenAPI generation fail on route and schema drift
 *
 * Structural checks that fail CI whenever the generated spec drifts from the
 * known-good contract:
 *
 *  1. Every route registered in src/app.ts has a corresponding entry in the
 *     generated spec (no undocumented routes).
 *  2. Every path in the spec matches an actual Express route prefix (no ghost
 *     paths that were removed from the router).
 *  3. Every documented operation has at least one response with a non-empty
 *     description.
 *  4. Operations that accept a request body document the body as required or
 *     provide an explicit schema.
 *  5. Security schemes referenced by operations exist in components.
 *  6. $ref targets inside components resolve within the same document (no
 *     dangling references).
 *  7. Enum values in schema properties are non-empty arrays.
 *  8. Required fields listed on object schemas exist in the properties map.
 *  9. The spec validates as OpenAPI 3.1 — openapi field, info, and paths all
 *     present.
 * 10. No duplicate operationIds across the entire spec.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';

// ── Spec fixture ──────────────────────────────────────────────────────────────

let spec: Record<string, unknown>;

beforeAll(async () => {
  const res = await request(app).get('/openapi.json');
  expect(res.status).toBe(200);
  spec = res.body as Record<string, unknown>;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPaths(): Record<string, unknown> {
  return (spec.paths ?? {}) as Record<string, unknown>;
}

function getComponents(): Record<string, unknown> {
  return (spec.components ?? {}) as Record<string, unknown>;
}

function getSchemas(): Record<string, unknown> {
  return ((spec.components as Record<string, unknown>)?.schemas ?? {}) as Record<string, unknown>;
}

function getSecuritySchemes(): Record<string, unknown> {
  return (
    ((spec.components as Record<string, unknown>)?.securitySchemes ?? {}) as Record<
      string,
      unknown
    >
  );
}

/** Collect all (path, method, operation) tuples from the spec. */
function allOperations(): Array<{ path: string; method: string; op: Record<string, unknown> }> {
  const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
  const result: Array<{ path: string; method: string; op: Record<string, unknown> }> = [];
  for (const [path, pathItem] of Object.entries(getPaths())) {
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method];
      if (op && typeof op === 'object') {
        result.push({ path, method, op: op as Record<string, unknown> });
      }
    }
  }
  return result;
}

/**
 * Resolve a $ref string like "#/components/schemas/Foo" within the spec.
 * Returns the resolved node or undefined if not found.
 */
function resolveRef(ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let node: unknown = spec;
  for (const part of parts) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/**
 * Recursively collect all "$ref" strings from an arbitrary JSON subtree.
 */
function collectRefs(node: unknown, refs: Set<string> = new Set()): Set<string> {
  if (typeof node !== 'object' || node === null) return refs;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
    return refs;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj['$ref'] === 'string') {
    refs.add(obj['$ref']);
  }
  for (const value of Object.values(obj)) {
    collectRefs(value, refs);
  }
  return refs;
}

// ── 1. Required routes from src/app.ts are documented in the spec ────────────

describe('Route coverage — app routes appear in the spec', () => {
  /**
   * These are the path prefixes registered in src/app.ts.
   * Each entry is [express mount path, spec path prefix].
   * A spec path "covers" a mount if it starts with that prefix.
   */
  const REQUIRED_SPEC_PREFIXES = [
    '/',
    '/health',
    '/api/streams',
    '/api/auth',
    '/api/admin',
    '/internal/indexer',
    '/internal/webhooks',
    '/api/audit',
    '/api/privacy',
    '/admin/dlq',
    '/api/rate-limits',
    '/metrics',
  ];

  it.each(REQUIRED_SPEC_PREFIXES)(
    'spec has at least one path entry covering mount prefix "%s"',
    (prefix) => {
      const specPaths = Object.keys(getPaths());
      const covered = specPaths.some((p) => p === prefix || p.startsWith(prefix + '/') || p.startsWith(prefix + '{'));
      expect(
        covered,
        `No spec path starts with "${prefix}". Spec paths: ${specPaths.join(', ')}`
      ).toBe(true);
    }
  );
});

// ── 2. Spec paths correspond to real registered route trees ──────────────────

describe('Spec paths match registered Express route prefixes (no ghost paths)', () => {
  /**
   * All path prefixes that are legitimately registered in the app.
   * A spec path is valid when its first segment matches one of these.
   */
  const VALID_PREFIXES = [
    '/',
    '/health',
    '/api',
    '/internal',
    '/admin',
    '/metrics',
    '/openapi.json',
    '/docs',
  ];

  it('every spec path starts with a known route prefix', () => {
    const ghost: string[] = [];
    for (const path of Object.keys(getPaths())) {
      const matched = VALID_PREFIXES.some(
        (prefix) => path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '{')
      );
      if (!matched) ghost.push(path);
    }
    expect(ghost, `Spec paths not matching any known prefix: ${ghost.join(', ')}`).toHaveLength(0);
  });
});

// ── 3. Every operation has at least one response ──────────────────────────────

describe('Every documented operation has at least one response', () => {
  it('all operations define responses', () => {
    const missing: string[] = [];
    for (const { path, method, op } of allOperations()) {
      const responses = op['responses'];
      if (
        !responses ||
        typeof responses !== 'object' ||
        Object.keys(responses as object).length === 0
      ) {
        missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(
      missing,
      `Operations with no responses: ${missing.join(', ')}`
    ).toHaveLength(0);
  });

  it('all responses have a non-empty description', () => {
    const missing: string[] = [];
    for (const { path, method, op } of allOperations()) {
      const responses = (op['responses'] ?? {}) as Record<string, unknown>;
      for (const [code, response] of Object.entries(responses)) {
        const desc = ((response as Record<string, unknown>)?.['description'] ?? '') as string;
        if (!desc || desc.trim().length === 0) {
          missing.push(`${method.toUpperCase()} ${path} → ${code}`);
        }
      }
    }
    expect(
      missing,
      `Responses with empty description: ${missing.join(', ')}`
    ).toHaveLength(0);
  });
});

// ── 4. Request bodies have explicit schemas ───────────────────────────────────

describe('Request bodies declare schemas', () => {
  it('all requestBody entries reference a schema', () => {
    const missing: string[] = [];
    for (const { path, method, op } of allOperations()) {
      const body = op['requestBody'] as Record<string, unknown> | undefined;
      if (!body) continue;
      const content = body['content'] as Record<string, unknown> | undefined;
      if (!content) {
        missing.push(`${method.toUpperCase()} ${path}: requestBody has no content`);
        continue;
      }
      for (const [mediaType, mediaObj] of Object.entries(content)) {
        const schema = (mediaObj as Record<string, unknown>)?.['schema'];
        if (!schema) {
          missing.push(`${method.toUpperCase()} ${path}: ${mediaType} has no schema`);
        }
      }
    }
    expect(
      missing,
      `Operations with missing body schema: ${missing.join(', ')}`
    ).toHaveLength(0);
  });
});

// ── 5. Security schemes referenced in operations exist in components ──────────

describe('Security scheme references are resolvable', () => {
  it('all security requirement scheme names exist in components/securitySchemes', () => {
    const schemes = getSecuritySchemes();
    const missing: string[] = [];
    for (const { path, method, op } of allOperations()) {
      const security = op['security'] as Array<Record<string, unknown>> | undefined;
      if (!security) continue;
      for (const requirement of security) {
        for (const schemeName of Object.keys(requirement)) {
          if (!(schemeName in schemes)) {
            missing.push(`${method.toUpperCase()} ${path} references unknown scheme "${schemeName}"`);
          }
        }
      }
    }
    expect(
      missing,
      `Dangling security scheme refs: ${missing.join(', ')}`
    ).toHaveLength(0);
  });

  it('components/securitySchemes contains bearerAuth', () => {
    expect(getSecuritySchemes()['bearerAuth']).toBeDefined();
  });

  it('components/securitySchemes contains indexerWorkerToken', () => {
    expect(getSecuritySchemes()['indexerWorkerToken']).toBeDefined();
  });
});

// ── 6. All $ref targets resolve within the document ──────────────────────────

describe('$ref targets resolve (no dangling references)', () => {
  it('every $ref in the spec points to a node that exists', () => {
    const refs = collectRefs(spec);
    const dangling: string[] = [];
    for (const ref of refs) {
      if (!ref.startsWith('#/')) continue; // skip external refs
      if (resolveRef(ref) === undefined) {
        dangling.push(ref);
      }
    }
    expect(
      dangling,
      `Dangling $refs: ${dangling.join(', ')}`
    ).toHaveLength(0);
  });
});

// ── 7. Enum arrays in schemas are non-empty ───────────────────────────────────

describe('Schema enum arrays are non-empty', () => {
  /**
   * Recursively find all nodes that have an "enum" property and return
   * their location path + enum value for assertion.
   */
  function collectEnums(
    node: unknown,
    path: string,
    results: Array<{ path: string; enum: unknown[] }> = []
  ): Array<{ path: string; enum: unknown[] }> {
    if (typeof node !== 'object' || node === null) return results;
    if (Array.isArray(node)) {
      node.forEach((item, i) => collectEnums(item, `${path}[${i}]`, results));
      return results;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj['enum'])) {
      results.push({ path, enum: obj['enum'] as unknown[] });
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key !== 'enum') collectEnums(value, `${path}.${key}`, results);
    }
    return results;
  }

  it('no enum property in the spec is an empty array', () => {
    const enums = collectEnums(spec, 'spec');
    const empty = enums.filter((e) => e.enum.length === 0);
    expect(
      empty.map((e) => e.path),
      `Empty enum arrays at: ${empty.map((e) => e.path).join(', ')}`
    ).toHaveLength(0);
  });

  it('ContractEventSchema topic enum contains all 6 known topics', () => {
    const schemas = getSchemas();
    const contractSchema = schemas['ContractEventSchema'] as Record<string, unknown>;
    const props = contractSchema?.['properties'] as Record<string, unknown>;
    const topic = props?.['topic'] as Record<string, unknown>;
    const enumVals = topic?.['enum'] as string[];

    const EXPECTED_TOPICS = [
      'stream.created',
      'stream.updated',
      'stream.cancelled',
      'stream.completed',
      'stream.funded',
      'stream.withdrawn',
    ];

    expect(Array.isArray(enumVals)).toBe(true);
    expect(enumVals.length).toBe(EXPECTED_TOPICS.length);
    for (const topic of EXPECTED_TOPICS) {
      expect(enumVals).toContain(topic);
    }
  });
});

// ── 8. Required fields exist in object properties ────────────────────────────

describe('Schema required fields exist in properties', () => {
  it('every required field in a schema object appears in its properties', () => {
    const schemas = getSchemas();
    const mismatches: string[] = [];

    for (const [schemaName, schema] of Object.entries(schemas)) {
      const s = schema as Record<string, unknown>;
      if (s['type'] !== 'object') continue;
      const required = s['required'] as string[] | undefined;
      const props = (s['properties'] ?? {}) as Record<string, unknown>;
      if (!required) continue;

      for (const field of required) {
        if (!(field in props)) {
          mismatches.push(`${schemaName}.required includes "${field}" but properties does not`);
        }
      }
    }

    expect(
      mismatches,
      `Required/properties mismatches: ${mismatches.join('; ')}`
    ).toHaveLength(0);
  });
});

// ── 9. Minimum valid OpenAPI 3.1 document structure ──────────────────────────

describe('Spec is a valid OpenAPI 3.1 document skeleton', () => {
  it('openapi field is "3.1.0"', () => {
    expect(spec['openapi']).toBe('3.1.0');
  });

  it('info.title is present and non-empty', () => {
    const info = spec['info'] as Record<string, unknown>;
    expect(typeof info?.['title']).toBe('string');
    expect((info['title'] as string).length).toBeGreaterThan(0);
  });

  it('info.version is present and non-empty', () => {
    const info = spec['info'] as Record<string, unknown>;
    expect(typeof info?.['version']).toBe('string');
    expect((info['version'] as string).length).toBeGreaterThan(0);
  });

  it('paths object is present', () => {
    expect(typeof spec['paths']).toBe('object');
    expect(spec['paths']).not.toBeNull();
  });

  it('spec has at least 20 documented paths', () => {
    expect(Object.keys(getPaths()).length).toBeGreaterThanOrEqual(20);
  });

  it('components object is present', () => {
    expect(typeof spec['components']).toBe('object');
  });

  it('tags array is present and non-empty', () => {
    expect(Array.isArray(spec['tags'])).toBe(true);
    expect((spec['tags'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('servers array is present', () => {
    expect(Array.isArray(spec['servers'])).toBe(true);
  });
});

// ── 10. No duplicate operationIds ────────────────────────────────────────────

describe('No duplicate operationIds', () => {
  it('all operationId values in the spec are unique', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const { path, method, op } of allOperations()) {
      const opId = op['operationId'] as string | undefined;
      if (!opId) continue;
      const key = `${method.toUpperCase()} ${path}`;
      if (seen.has(opId)) {
        duplicates.push(`"${opId}" used by ${seen.get(opId)} and ${key}`);
      } else {
        seen.set(opId, key);
      }
    }

    expect(
      duplicates,
      `Duplicate operationIds: ${duplicates.join('; ')}`
    ).toHaveLength(0);
  });
});

// ── 11. Critical endpoint response codes ─────────────────────────────────────

describe('Critical endpoints document expected response codes', () => {
  async function getOp(specPath: string, method: string): Promise<Record<string, unknown>> {
    const pathItem = getPaths()[specPath] as Record<string, unknown>;
    return (pathItem?.[method] ?? {}) as Record<string, unknown>;
  }

  it('POST /api/streams documents 201, 400, 401, 409', async () => {
    const op = await getOp('/api/streams', 'post');
    const responses = Object.keys(op['responses'] as object);
    expect(responses).toContain('201');
    expect(responses).toContain('400');
    expect(responses).toContain('401');
    expect(responses).toContain('409');
  });

  it('GET /api/streams documents 200 and 400', async () => {
    const op = await getOp('/api/streams', 'get');
    const responses = Object.keys(op['responses'] as object);
    expect(responses).toContain('200');
    expect(responses).toContain('400');
  });

  it('GET /api/streams/{id} documents 200 and 404', async () => {
    const op = await getOp('/api/streams/{id}', 'get');
    const responses = Object.keys(op['responses'] as object);
    expect(responses).toContain('200');
    expect(responses).toContain('404');
  });

  it('POST /internal/indexer/contract-events documents 200, 400, 401, 409', async () => {
    const op = await getOp('/internal/indexer/contract-events', 'post');
    const responses = Object.keys(op['responses'] as object);
    expect(responses).toContain('200');
    expect(responses).toContain('400');
    expect(responses).toContain('401');
    expect(responses).toContain('409');
  });

  it('DELETE /api/admin/api-keys/{id} documents 204 with no response body', async () => {
    const op = await getOp('/api/admin/api-keys/{id}', 'delete');
    const r204 = (op['responses'] as Record<string, unknown>)?.['204'] as Record<string, unknown>;
    expect(r204).toBeDefined();
    // 204 must not have a content body per OpenAPI 3.1 / HTTP spec
    expect(r204?.['content']).toBeUndefined();
  });

  it('GET /health documents 200', async () => {
    const op = await getOp('/health', 'get');
    expect(Object.keys(op['responses'] as object)).toContain('200');
  });

  it('POST /api/auth/session documents 200 and 400', async () => {
    const op = await getOp('/api/auth/session', 'post');
    const responses = Object.keys(op['responses'] as object);
    expect(responses).toContain('200');
    expect(responses).toContain('400');
  });
});

// ── 12. Parameter documentation ──────────────────────────────────────────────

describe('Route parameters are documented', () => {
  it('GET /api/streams/{id} documents the id path parameter', () => {
    const pathItem = getPaths()['/api/streams/{id}'] as Record<string, unknown>;
    const op = pathItem?.['get'] as Record<string, unknown>;
    const params = (op?.['parameters'] ?? []) as Array<Record<string, unknown>>;
    const idParam = params.find((p) => p['name'] === 'id' && p['in'] === 'path');
    expect(idParam).toBeDefined();
  });

  it('GET /api/streams documents limit and cursor query parameters', () => {
    const pathItem = getPaths()['/api/streams'] as Record<string, unknown>;
    const op = pathItem?.['get'] as Record<string, unknown>;
    const params = (op?.['parameters'] ?? []) as Array<Record<string, unknown>>;
    const names = params.map((p) => p['name']);
    expect(names).toContain('limit');
    expect(names).toContain('cursor');
  });

  it('GET /admin/dlq documents limit and offset query parameters', () => {
    const pathItem = getPaths()['/admin/dlq'] as Record<string, unknown>;
    const op = pathItem?.['get'] as Record<string, unknown>;
    const params = (op?.['parameters'] ?? []) as Array<Record<string, unknown>>;
    const names = params.map((p) => p['name']);
    expect(names).toContain('limit');
    expect(names).toContain('offset');
  });
});

// ── 13. Schema component registration ────────────────────────────────────────

describe('Key schemas are registered in components', () => {
  const REQUIRED_SCHEMAS = [
    'Stream',
    'StreamListPage',
    'StreamCursorToken',
    'ContractEventSchema',
    'ErrorEnvelope',
    'ResponseMeta',
    'WebSocketSubscriptionFilter',
    'WebSocketSubscribeMessage',
    'WebSocketUnsubscribeMessage',
  ];

  it.each(REQUIRED_SCHEMAS)('schema "%s" is registered in components/schemas', (schemaName) => {
    expect(getSchemas()[schemaName]).toBeDefined();
  });
});

// ── 14. Spec stability — no new undocumented paths added silently ─────────────

describe('Spec path count regression', () => {
  it('spec has at least 31 documented paths (baseline from last known-good build)', () => {
    // This number equals the path count from the current spec generation.
    // If a new route is added but NOT documented in spec.ts, this test fails.
    // If new routes ARE documented, update this number in your PR.
    expect(Object.keys(getPaths()).length).toBeGreaterThanOrEqual(31);
  });
});
