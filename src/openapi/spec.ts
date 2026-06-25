/**
 * OpenAPI 3.1 spec builder for Fluxora Backend.
 * Generates the spec from zod schemas using @asteasolutions/zod-to-openapi.
 * @module openapi/spec
 */
import { z } from 'zod';
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ── Shared schemas ────────────────────────────────────────────────────────────

const DecimalString = registry.register(
  'DecimalString',
  z.string().openapi({ example: '1000000.0000000', description: 'Decimal string amount' }),
);

const StellarAddress = registry.register(
  'StellarAddress',
  z.string().openapi({ example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', description: 'Stellar public key (G…)' }),
);

const StreamStatus = registry.register(
  'StreamStatus',
  z.enum(['scheduled', 'active', 'paused', 'completed', 'cancelled']).openapi({ example: 'active' }),
);

const StreamObject = registry.register(
  'Stream',
  z.object({
    id: z.string().openapi({ example: 'stream-abc123' }),
    sender: StellarAddress,
    recipient: StellarAddress,
    depositAmount: DecimalString,
    ratePerSecond: DecimalString,
    startTime: z.number().int().openapi({ example: 1700000000 }),
    endTime: z.number().int().openapi({ example: 0 }),
    status: StreamStatus,
  }).openapi({ description: 'A treasury stream record' }),
);

const ResponseMeta = registry.register(
  'ResponseMeta',
  z.object({
    timestamp: z.string().openapi({ example: '2026-01-01T00:00:00.000Z' }),
    requestId: z.string().optional().openapi({ example: 'req_abc123' }),
    idempotencyReplayed: z.boolean().optional(),
  }),
);

const ErrorEnvelope = registry.register(
  'ErrorEnvelope',
  z.object({
    success: z.literal(false),
    error: z.object({
      code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
      message: z.string().openapi({ example: 'Validation failed' }),
      details: z.unknown().optional(),
      requestId: z.string().optional(),
    }),
  }),
);

// ── Security schemes ──────────────────────────────────────────────────────────

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'JWT issued by POST /api/auth/session',
});

registry.registerComponent('securitySchemes', 'indexerWorkerToken', {
  type: 'apiKey',
  in: 'header',
  name: 'x-indexer-worker-token',
  description: 'Static shared secret for internal indexer worker endpoints',
});

// ── Common response headers ───────────────────────────────────────────────────

/**
 * X-Request-ID is set on every response (success, error, and body-less 204).
 * Its value is the correlation ID resolved by the correlationId middleware and
 * is identical to the `requestId` field in the JSON envelope when a body is
 * present.  Clients, proxies, and gateways can use it to tie any response back
 * to a server-side trace without parsing the body.
 */
registry.registerComponent('headers', 'XRequestId', {
  description:
    'Opaque request identifier that matches the correlation ID attached to server-side log lines. ' +
    'Present on every response including body-less 204 responses. ' +
    'When a JSON envelope is returned its value equals `meta.requestId` (success) or `error.requestId` (error).',
  schema: { type: 'string', format: 'uuid', example: '123e4567-e89b-12d3-a456-426614174000' },
  required: true,
});

/** Reusable headers object referencing the common X-Request-ID component. */
const commonResponseHeaders = {
  'X-Request-ID': { $ref: '#/components/headers/XRequestId' },
} as const;

// ── Reusable response helpers ─────────────────────────────────────────────────

function successSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({ success: z.literal(true), data: dataSchema, meta: ResponseMeta });
}

/** Wraps a successSchema in a full 200-response object with common headers. */
function successResponse200<T extends z.ZodTypeAny>(dataSchema: T, description = 'Success') {
  return {
    description,
    headers: commonResponseHeaders,
    content: { 'application/json': { schema: successSchema(dataSchema) } },
  };
}

const errorResponses = {
  '400': { description: 'Validation error', headers: commonResponseHeaders, content: { 'application/json': { schema: ErrorEnvelope } } },
  '401': { description: 'Unauthorized', headers: commonResponseHeaders, content: { 'application/json': { schema: ErrorEnvelope } } },
  '403': { description: 'Forbidden', headers: commonResponseHeaders, content: { 'application/json': { schema: ErrorEnvelope } } },
  '404': { description: 'Not found', headers: commonResponseHeaders, content: { 'application/json': { schema: ErrorEnvelope } } },
  '408': { description: 'Request timeout', headers: commonResponseHeaders, content: { 'application/json': { schema: ErrorEnvelope } } },
  '409': { description: 'Conflict', headers: commonResponseHeaders, content: { 'application/json': { schema: ErrorEnvelope } } },
  '422': { description: 'Unprocessable entity', headers: commonResponseHeaders, content: { 'application/json': { schema: ErrorEnvelope } } },
  '429': { description: 'Too many requests', headers: commonResponseHeaders, content: { 'application/json': { schema: ErrorEnvelope } } },
  '500': { description: 'Internal server error', headers: commonResponseHeaders, content: { 'application/json': { schema: ErrorEnvelope } } },
  '503': { description: 'Service unavailable', headers: commonResponseHeaders, content: { 'application/json': { schema: ErrorEnvelope } } },
} as const;

// ── GET / ─────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get', path: '/',
  summary: 'API info',
  tags: ['meta'],
  responses: {
    '200': {
      description: 'API metadata',
      content: { 'application/json': { schema: successSchema(z.object({ name: z.string(), version: z.string(), docs: z.string() })) } },
    },
  },
});

// ── Health ────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get', path: '/health',
  summary: 'Liveness probe',
  tags: ['health'],
  responses: {
    '200': {
      description: 'Service status',
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['ok', 'degraded', 'shutting_down']),
            service: z.string(),
            network: z.string(),
            timestamp: z.string(),
          }),
          example: { status: 'ok', service: 'fluxora-backend', network: 'testnet', timestamp: '2026-01-01T00:00:00.000Z' },
        },
      },
    },
    '503': errorResponses['503'],
  },
});

registry.registerPath({
  method: 'get', path: '/health/ready',
  summary: 'Readiness probe',
  tags: ['health'],
  responses: {
    '200': {
      description: 'All dependencies healthy or degraded',
      content: { 'application/json': { schema: z.object({ status: z.enum(['healthy', 'degraded']), version: z.string(), dependencies: z.record(z.string(), z.string()) }) } },
    },
    '503': { description: 'One or more dependencies unhealthy', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: 'get', path: '/health/live',
  summary: 'Detailed health report',
  tags: ['health'],
  responses: {
    '200': {
      description: 'Full health report',
      content: { 'application/json': { schema: successSchema(z.object({ report: z.record(z.string(), z.unknown()) })) } },
    },
    '500': errorResponses['500'],
  },
});

// ── Streams ───────────────────────────────────────────────────────────────────

/**
 * Cursor semantics for GET /api/streams
 * ----------------------------------------
 * ENCODING
 *   Each cursor is an opaque base64url token. Internally it encodes a
 *   version-tagged JSON object `{ v: 1, lastId: "<stream-id>" }`, where
 *   `lastId` is the `id` of the last stream returned on the previous page.
 *   Clients MUST treat cursors as black boxes — the internal structure is
 *   not part of the public API and may change without notice. Do not
 *   construct or decode cursors manually.
 *
 *   Security: cursors do NOT contain raw database row IDs or any plaintext
 *   PII. The `lastId` value is the application-level stream identifier
 *   (e.g. `stream-abc123`), which is already visible in every list response.
 *   Ownership scoping is enforced by the repository layer on every request,
 *   independent of the cursor value.
 *
 * STABILITY
 *   Cursors are stable across inserts: new rows added after a cursor is
 *   issued do not invalidate it, because the query uses a keyset condition
 *   (`id > lastId`). However, a cursor referencing a deleted or
 *   compacted stream id will simply skip to the next matching row without
 *   error — the client observes a gap, not a failure.
 *
 *   A structurally invalid cursor (wrong base64url encoding, missing version
 *   tag, or empty `lastId`) is rejected immediately with 400
 *   INVALID_CURSOR before any database call is made.
 *
 * ORDERING
 *   Results are returned in ascending `id` order (lexicographically by
 *   application stream id). This ordering is deterministic and consistent
 *   across pages because stream ids are generated from a SHA-256 hash of
 *   the creation input, so they do not collide and are stable once written.
 *
 * PAGINATION FLOW
 *   1. Omit `cursor` to fetch the first page.
 *   2. If `has_more` is `true`, pass the returned `next_cursor` as the
 *      `cursor` parameter to fetch the next page.
 *   3. When `has_more` is `false`, `next_cursor` is `null` and you are on
 *      the last page — stop iterating.
 */

/** Cursor token schema with full semantics documented. */
const StreamCursorToken = registry.register(
  'StreamCursorToken',
  z.string().openapi({
    description:
      'Opaque base64url pagination cursor issued by the server. ' +
      'Encodes `{ v: 1, lastId }` internally; treat as a black box. ' +
      'Pass the `next_cursor` from the previous response verbatim. ' +
      'Cursors do not expose internal row ids or PII. ' +
      'Stable across inserts; invalid/expired cursors return 400 INVALID_CURSOR.',
    example: 'eyJ2IjoxLCJsYXN0SWQiOiJzdHJlYW0tYWJjMTIzIn0',
  }),
);

/** Reusable list-page response schema. */
const StreamListPage = registry.register(
  'StreamListPage',
  z.object({
    streams: z.array(StreamObject).openapi({
      description: 'Streams on this page, ordered by id ASC.',
    }),
    has_more: z.boolean().openapi({
      description: 'True when additional pages exist. Fetch them by passing `next_cursor`.',
      example: true,
    }),
    next_cursor: StreamCursorToken.nullable().openapi({
      description:
        'Cursor to pass as `cursor` on the next request. ' +
        'Null on the last page (has_more=false).',
      example: 'eyJ2IjoxLCJsYXN0SWQiOiJzdHJlYW0tYWJjMTIzIn0',
    }),
    total: z.number().int().optional().openapi({
      description: 'Total matching rows. Only present when include_total=true.',
      example: 42,
    }),
  }),
);

/** 400 body specific to invalid/expired cursor. */
const InvalidCursorError = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.literal('VALIDATION_ERROR').openapi({ example: 'VALIDATION_ERROR' }),
    message: z.string().openapi({
      example: 'cursor must be a valid opaque pagination token',
    }),
  }),
}).openapi({
  description:
    'Returned when the `cursor` parameter is present but cannot be decoded ' +
    '(bad base64url, wrong JSON shape, missing version tag, or empty lastId). ' +
    'The client must discard the cursor and restart pagination from the first page ' +
    'by omitting the `cursor` parameter.',
});

registry.registerPath({
  method: 'get', path: '/api/streams',
  summary: 'List streams (cursor-paginated)',
  description:
    '## Cursor Pagination\n\n' +
    '**Encoding** — `next_cursor` is an opaque base64url token (`{ v: 1, lastId }` internally). ' +
    'Never construct or decode it manually; the internal format may change.\n\n' +
    '**Security** — Cursors do not contain raw database row ids or PII. ' +
    'The embedded `lastId` is the same application-level id that appears in list responses. ' +
    'Server-side ownership scoping is re-applied on every request.\n\n' +
    '**Stability** — Cursors survive concurrent inserts (keyset semantics: `id > lastId`). ' +
    'Deleting the row referenced by a cursor does not cause an error; the next matching row is returned.\n\n' +
    '**Ordering** — Pages are returned in ascending `id` order (deterministic lexicographic sort).\n\n' +
    '**Invalid cursor** — A malformed or tampered cursor returns `400 VALIDATION_ERROR` with ' +
    '`message: "cursor must be a valid opaque pagination token"` before any database access. ' +
    'Discard the cursor and restart from page 1.',
  tags: ['streams'],
  request: {
    query: z.object({
      limit: z.string().optional().openapi({
        example: '20',
        description: 'Page size (1–100, default 20).',
      }),
      cursor: z.string().optional().openapi({
        description:
          'Opaque cursor from the previous page\'s `next_cursor`. ' +
          'Omit to request the first page. ' +
          'Treated as a black box — do not construct manually.',
        example: 'eyJ2IjoxLCJsYXN0SWQiOiJzdHJlYW0tYWJjMTIzIn0',
      }),
      status: z.string().optional().openapi({ example: 'active' }),
      sender: z.string().optional().openapi({
        description: 'Filter by sender Stellar address.',
        example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      }),
      recipient: z.string().optional().openapi({
        description: 'Filter by recipient Stellar address.',
        example: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
      }),
      include_total: z.enum(['true', 'false']).optional().openapi({
        description: 'When "true", include total count of matching rows in the response.',
      }),
    }),
  },
  responses: {
    '200': {
      description:
        'Paginated stream list ordered by `id` ASC. ' +
        'Check `has_more` to determine whether additional pages exist.',
      content: {
        'application/json': {
          schema: successSchema(StreamListPage),
          examples: {
            firstPage: {
              summary: 'First page (no cursor supplied)',
              description: 'Omit `cursor` to request the first page. `has_more: true` means more pages follow.',
              value: {
                success: true,
                data: {
                  streams: [
                    {
                      id: 'stream-aaa111',
                      sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
                      recipient: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
                      depositAmount: '1000000.0000000',
                      ratePerSecond: '0.0000116',
                      startTime: 1700000000,
                      endTime: 0,
                      status: 'active',
                    },
                  ],
                  has_more: true,
                  next_cursor: 'eyJ2IjoxLCJsYXN0SWQiOiJzdHJlYW0tYWFhMTExIn0',
                },
                meta: { timestamp: '2026-01-01T00:00:00.000Z', requestId: 'req_abc123' },
              },
            },
            nextPage: {
              summary: 'Middle page (cursor from previous page)',
              description:
                'Pass `next_cursor` from the previous response as the `cursor` query param. ' +
                'The result set starts exclusively after the last id from the previous page.',
              value: {
                success: true,
                data: {
                  streams: [
                    {
                      id: 'stream-bbb222',
                      sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
                      recipient: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
                      depositAmount: '500000.0000000',
                      ratePerSecond: '0.0000058',
                      startTime: 1700001000,
                      endTime: 0,
                      status: 'active',
                    },
                  ],
                  has_more: true,
                  next_cursor: 'eyJ2IjoxLCJsYXN0SWQiOiJzdHJlYW0tYmJiMjIyIn0',
                },
                meta: { timestamp: '2026-01-01T00:01:00.000Z', requestId: 'req_bcd234' },
              },
            },
            lastPage: {
              summary: 'Last page (has_more=false, next_cursor=null)',
              description:
                'When `has_more` is `false`, `next_cursor` is `null` — stop iterating. ' +
                'The `streams` array may be empty if no rows remain after the cursor.',
              value: {
                success: true,
                data: {
                  streams: [
                    {
                      id: 'stream-zzz999',
                      sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
                      recipient: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
                      depositAmount: '250000.0000000',
                      ratePerSecond: '0.0000029',
                      startTime: 1700002000,
                      endTime: 1800000000,
                      status: 'completed',
                    },
                  ],
                  has_more: false,
                  next_cursor: null,
                },
                meta: { timestamp: '2026-01-01T00:02:00.000Z', requestId: 'req_cde345' },
              },
            },
          },
        },
      },
    },
    '400': {
      description:
        'Validation error. Also returned for an invalid or expired cursor — ' +
        '`error.code` will be `"VALIDATION_ERROR"` and ' +
        '`error.message` will be `"cursor must be a valid opaque pagination token"`. ' +
        'Discard the cursor and restart pagination from page 1 (omit `cursor`).',
      content: {
        'application/json': {
          schema: ErrorEnvelope,
          examples: {
            invalidCursor: {
              summary: 'Invalid or expired cursor',
              value: {
                success: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'cursor must be a valid opaque pagination token',
                },
              },
            },
            invalidLimit: {
              summary: 'Limit out of range',
              value: {
                success: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'limit must be at most 100',
                },
              },
            },
          },
        },
      },
    },
    '503': errorResponses['503'],
  },
});

registry.registerPath({
  method: 'get', path: '/api/streams/{id}',
  summary: 'Get stream by ID',
  tags: ['streams'],
  request: { params: z.object({ id: z.string().openapi({ example: 'stream-abc123' }) }) },
  responses: {
    '200': {
      description: 'Stream record',
      content: { 'application/json': { schema: successSchema(z.object({ stream: StreamObject })) } },
    },
    '404': errorResponses['404'],
    '503': errorResponses['503'],
  },
});

registry.registerPath({
  method: 'head', path: '/api/streams/{id}',
  summary: 'Check whether a stream exists',
  tags: ['streams'],
  request: { params: z.object({ id: z.string().openapi({ example: 'stream-abc123' }) }) },
  responses: {
    '200': {
      description: 'Stream exists',
    },
    '404': errorResponses['404'],
    '503': errorResponses['503'],
  },
});

registry.registerPath({
  method: 'post', path: '/api/streams',
  summary: 'Create stream',
  tags: ['streams'],
  security: [{ bearerAuth: [] }],
  request: {
    headers: z.object({ 'Idempotency-Key': z.string().openapi({ description: 'Unique key (1–128 chars) to prevent duplicate creation', example: 'my-key-001' }) }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            sender: StellarAddress,
            recipient: StellarAddress,
            depositAmount: DecimalString,
            ratePerSecond: DecimalString,
            startTime: z.number().int().optional().openapi({ example: 1700000000 }),
            endTime: z.number().int().optional().openapi({ example: 0 }),
          }),
          example: {
            sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
            recipient: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
            depositAmount: '1000000.0000000',
            ratePerSecond: '0.0000116',
            startTime: 1700000000,
          },
        },
      },
    },
  },
  responses: {
    '201': {
      description: 'Stream created',
      content: { 'application/json': { schema: successSchema(StreamObject) } },
    },
    '400': errorResponses['400'],
    '401': errorResponses['401'],
    '409': errorResponses['409'],
    '503': errorResponses['503'],
  },
});

registry.registerPath({
  method: 'delete', path: '/api/streams/{id}',
  summary: 'Cancel stream',
  tags: ['streams'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().openapi({ example: 'stream-abc123' }) }) },
  responses: {
    '200': {
      description: 'Stream cancelled',
      content: { 'application/json': { schema: successSchema(z.object({ message: z.string(), id: z.string() })) } },
    },
    '401': errorResponses['401'],
    '404': errorResponses['404'],
    '409': errorResponses['409'],
    '503': errorResponses['503'],
  },
});

registry.registerPath({
  method: 'patch', path: '/api/streams/{id}/status',
  summary: 'Transition stream status',
  tags: ['streams'],
  request: {
    params: z.object({ id: z.string().openapi({ example: 'stream-abc123' }) }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ status: StreamStatus }),
          example: { status: 'paused' },
        },
      },
    },
  },
  responses: {
    '200': { description: 'Updated stream', content: { 'application/json': { schema: successSchema(StreamObject) } } },
    '400': errorResponses['400'],
    '404': errorResponses['404'],
    '409': errorResponses['409'],
    '503': errorResponses['503'],
  },
});

// ── Auth ──────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post', path: '/api/auth/session',
  summary: 'Create session (get JWT)',
  tags: ['auth'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            address: z.string().optional().openapi({ example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' }),
            role: z.enum(['operator', 'viewer']).optional().openapi({ example: 'viewer' }),
            idToken: z.string().optional().openapi({ description: 'External OIDC ID token' }),
          }),
        },
      },
    },
  },
  responses: {
    '200': {
      description: 'JWT issued',
      content: {
        'application/json': {
          schema: z.object({ token: z.string(), user: z.object({ address: z.string(), role: z.string() }) }),
          example: { token: 'eyJ...', user: { address: 'GAAZI4...', role: 'viewer' } },
        },
      },
    },
    '400': errorResponses['400'],
    '401': errorResponses['401'],
  },
});

// ── Audit ─────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get', path: '/api/audit',
  summary: 'List audit log entries',
  tags: ['audit'],
  security: [{ bearerAuth: [] }],
  responses: {
    '200': {
      description: 'Audit entries',
      content: {
        'application/json': {
          schema: successSchema(z.object({
            entries: z.array(z.record(z.string(), z.unknown())),
            total: z.number().int(),
          })),
        },
      },
    },
    '401': errorResponses['401'],
    '403': errorResponses['403'],
  },
});

// ── Privacy ───────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get', path: '/api/privacy/policy',
  summary: 'PII policy document',
  tags: ['privacy'],
  responses: {
    '200': { description: 'Full PII policy', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
  },
});

registry.registerPath({
  method: 'get', path: '/api/privacy/retention',
  summary: 'Data retention schedule',
  tags: ['privacy'],
  responses: {
    '200': { description: 'Retention schedule', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
  },
});

// ── Admin ─────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get', path: '/api/admin/status/read-only',
  summary: 'Read pause flags (no auth)',
  tags: ['admin'],
  responses: {
    '200': { description: 'Pause flags', content: { 'application/json': { schema: z.object({ pauseFlags: z.record(z.string(), z.boolean()) }) } } },
  },
});

registry.registerPath({
  method: 'get', path: '/api/admin/status',
  summary: 'Admin status (pause flags + reindex state)',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  responses: {
    '200': { description: 'Admin status', content: { 'application/json': { schema: z.object({ pauseFlags: z.record(z.string(), z.boolean()), reindex: z.record(z.string(), z.unknown()) }) } } },
    '401': errorResponses['401'],
  },
});

registry.registerPath({
  method: 'get', path: '/api/admin/pause',
  summary: 'Get pause flags',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  responses: {
    '200': { description: 'Pause flags', content: { 'application/json': { schema: z.record(z.string(), z.boolean()) } } },
    '401': errorResponses['401'],
  },
});

registry.registerPath({
  method: 'put', path: '/api/admin/pause',
  summary: 'Update pause flags',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            streamCreation: z.boolean().optional(),
            ingestion: z.boolean().optional(),
          }),
          example: { streamCreation: true, ingestion: false },
        },
      },
    },
  },
  responses: {
    '200': { description: 'Updated pause flags', content: { 'application/json': { schema: z.object({ message: z.string(), pauseFlags: z.record(z.string(), z.boolean()) }) } } },
    '400': errorResponses['400'],
    '401': errorResponses['401'],
    '503': errorResponses['503'],
  },
});

registry.registerPath({
  method: 'get', path: '/api/admin/reindex',
  summary: 'Get reindex state',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  responses: {
    '200': { description: 'Reindex state', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    '401': errorResponses['401'],
  },
});

registry.registerPath({
  method: 'post', path: '/api/admin/reindex',
  summary: 'Trigger reindex',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  responses: {
    '202': { description: 'Reindex started', content: { 'application/json': { schema: z.object({ message: z.string(), reindex: z.record(z.string(), z.unknown()) }) } } },
    '401': errorResponses['401'],
    '409': errorResponses['409'],
  },
});

registry.registerPath({
  method: 'get', path: '/api/admin/api-keys',
  summary: 'List API keys (hashes only)',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  responses: {
    '200': { description: 'API key list', content: { 'application/json': { schema: z.object({ apiKeys: z.array(z.record(z.string(), z.unknown())) }) } } },
    '401': errorResponses['401'],
  },
});

registry.registerPath({
  method: 'post', path: '/api/admin/api-keys',
  summary: 'Create API key',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: z.object({ name: z.string().openapi({ example: 'my-service' }) }) } } },
  },
  responses: {
    '201': { description: 'API key created (raw key returned once)', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    '400': errorResponses['400'],
    '401': errorResponses['401'],
  },
});

registry.registerPath({
  method: 'post', path: '/api/admin/api-keys/{id}/rotate',
  summary: 'Rotate API key',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    '200': { description: 'New raw key returned once', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    '401': errorResponses['401'],
    '404': errorResponses['404'],
  },
});

registry.registerPath({
  method: 'delete', path: '/api/admin/api-keys/{id}',
  summary: 'Revoke API key',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    '204': { description: 'Key revoked' },
    '401': errorResponses['401'],
    '404': errorResponses['404'],
  },
});

// ── DLQ ───────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get', path: '/admin/dlq',
  summary: 'List dead-letter queue entries',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.string().optional().openapi({ example: '50' }),
      offset: z.string().optional().openapi({ example: '0' }),
      topic: z.string().optional(),
    }),
  },
  responses: {
    '200': { description: 'DLQ entries', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    '400': errorResponses['400'],
    '401': errorResponses['401'],
    '403': errorResponses['403'],
  },
});

registry.registerPath({
  method: 'get', path: '/admin/dlq/{id}',
  summary: 'Get DLQ entry',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    '200': { description: 'DLQ entry', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    '401': errorResponses['401'],
    '403': errorResponses['403'],
    '404': errorResponses['404'],
  },
});

registry.registerPath({
  method: 'delete', path: '/admin/dlq/{id}',
  summary: 'Delete DLQ entry',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    '200': { description: 'Entry deleted', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    '401': errorResponses['401'],
    '403': errorResponses['403'],
    '404': errorResponses['404'],
  },
});

registry.registerPath({
  method: 'post', path: '/admin/dlq/{id}/retry',
  summary: 'Retry DLQ entry',
  tags: ['admin'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    '200': { description: 'Retry queued', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    '401': errorResponses['401'],
    '403': errorResponses['403'],
    '404': errorResponses['404'],
  },
});

// ── Rate limits ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get', path: '/api/rate-limits',
  summary: "Caller's current rate-limit status",
  tags: ['rate-limits'],
  responses: {
    '200': { description: 'Rate-limit status', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
  },
});

registry.registerPath({
  method: 'get', path: '/api/rate-limits/config',
  summary: 'Active rate-limit config (admin)',
  tags: ['rate-limits'],
  security: [{ bearerAuth: [] }],
  responses: {
    '200': { description: 'Rate-limit config', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    '401': errorResponses['401'],
  },
});

registry.registerPath({
  method: 'put', path: '/api/rate-limits/config',
  summary: 'Update rate-limit config (admin)',
  tags: ['rate-limits'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            ip: z.object({ windowMs: z.number().optional(), max: z.number().optional(), enabled: z.boolean().optional() }).optional(),
            apiKey: z.object({ windowMs: z.number().optional(), max: z.number().optional(), enabled: z.boolean().optional() }).optional(),
            admin: z.object({ windowMs: z.number().optional(), max: z.number().optional(), enabled: z.boolean().optional() }).optional(),
          }),
          example: { ip: { max: 200 } },
        },
      },
    },
  },
  responses: {
    '200': { description: 'Updated config', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    '400': errorResponses['400'],
    '401': errorResponses['401'],
    '409': errorResponses['409'],
  },
});

// ── Internal indexer ──────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post', path: '/internal/indexer/contract-events',
  summary: 'Ingest contract event batch',
  tags: ['indexer'],
  security: [{ indexerWorkerToken: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ events: z.array(z.record(z.string(), z.unknown())).max(100) }),
          example: { events: [{ eventId: 'evt-001', ledger: 1000, contractId: 'C...', topic: 'stream.created', payload: {} }] },
        },
      },
    },
  },
  responses: {
    '200': { description: 'Batch persisted', content: { 'application/json': { schema: successSchema(z.object({ outcome: z.string(), insertedCount: z.number(), duplicateCount: z.number(), insertedEventIds: z.array(z.string()), duplicateEventIds: z.array(z.string()) })) } } },
    '401': errorResponses['401'],
    '409': errorResponses['409'],
    '413': { description: 'Payload too large', content: { 'application/json': { schema: ErrorEnvelope } } },
    '429': errorResponses['429'],
    '503': errorResponses['503'],
  },
});

registry.registerPath({
  method: 'get', path: '/internal/indexer/events',
  summary: 'List stored contract events',
  tags: ['indexer'],
  security: [{ indexerWorkerToken: [] }],
  request: {
    query: z.object({
      fromLedger: z.string().optional(),
      toledger: z.string().optional(),
      contractId: z.string().optional(),
      topic: z.string().optional(),
      limit: z.string().optional().openapi({ example: '100' }),
      offset: z.string().optional().openapi({ example: '0' }),
    }),
  },
  responses: {
    '200': { description: 'Event list', content: { 'application/json': { schema: successSchema(z.record(z.string(), z.unknown())) } } },
    '401': errorResponses['401'],
  },
});

registry.registerPath({
  method: 'get', path: '/internal/indexer/events/replay',
  summary: 'Cursor-based event replay',
  tags: ['indexer'],
  security: [{ indexerWorkerToken: [] }],
  request: {
    query: z.object({
      afterEventId: z.string().optional().openapi({ description: 'Exclusive cursor; omit to start from beginning' }),
      fromLedger: z.string().optional(),
      toledger: z.string().optional(),
      contractId: z.string().optional(),
      topic: z.string().optional(),
      limit: z.string().optional().openapi({ example: '100' }),
    }),
  },
  responses: {
    '200': { description: 'Cursor-paginated event page', content: { 'application/json': { schema: successSchema(z.record(z.string(), z.unknown())) } } },
    '401': errorResponses['401'],
  },
});

// ── Webhooks ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'post', path: '/internal/webhooks/receive',
  summary: 'Receive and verify an inbound Fluxora webhook',
  tags: ['webhooks'],
  request: {
    headers: z.object({
      'x-fluxora-delivery-id': z.string().openapi({ description: 'Stable delivery ID for deduplication' }),
      'x-fluxora-timestamp': z.string().openapi({ description: 'Unix timestamp in seconds' }),
      'x-fluxora-signature': z.string().openapi({ description: 'HMAC-SHA256 hex signature' }),
      'x-fluxora-event': z.string().optional().openapi({ example: 'stream.created' }),
    }),
    body: { required: true, content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
  },
  responses: {
    '200': { description: 'Webhook verified and accepted', content: { 'application/json': { schema: z.object({ ok: z.literal(true), deliveryId: z.string(), eventType: z.string().nullable(), event: z.unknown() }) } } },
    '400': errorResponses['400'],
    '401': errorResponses['401'],
    '413': { description: 'Payload too large', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

registry.registerPath({
  method: 'post', path: '/internal/webhooks/queue',
  summary: 'Queue a webhook delivery',
  tags: ['webhooks'],
  request: { body: { required: true, content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } } },
  responses: {
    '200': { description: 'Queued', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    '400': errorResponses['400'],
  },
});

// ── Metrics ───────────────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get', path: '/metrics',
  summary: 'Prometheus metrics',
  tags: ['observability'],
  responses: {
    '200': { description: 'Prometheus text format', content: { 'text/plain': { schema: z.string() } } },
  },
});

// ── Generator ─────────────────────────────────────────────────────────────────

/**
 * Build and return the complete OpenAPI 3.1 document.
 * Called once at startup; the result is cached by the docs route.
 */
export function buildOpenApiSpec(): Record<string, unknown> {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Fluxora Backend API',
      version: '0.1.0',
      description:
        'REST API for the Fluxora treasury streaming protocol on Stellar. ' +
        'Covers stream CRUD, health, admin, indexer ingestion, webhook delivery, and observability.',
      contact: { name: 'Fluxora Engineering', url: 'https://github.com/Fluxora-Org/Fluxora-Backend' },
      license: { name: 'MIT' },
    },
    servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
    tags: [
      { name: 'meta', description: 'API metadata' },
      { name: 'health', description: 'Liveness and readiness probes' },
      { name: 'streams', description: 'Treasury stream CRUD' },
      { name: 'auth', description: 'Session / JWT issuance' },
      { name: 'audit', description: 'Audit log' },
      { name: 'privacy', description: 'PII policy and retention' },
      { name: 'admin', description: 'Admin operations (pause, reindex, API keys, DLQ)' },
      { name: 'rate-limits', description: 'Rate-limit status and config' },
      { name: 'indexer', description: 'Internal indexer worker endpoints' },
      { name: 'webhooks', description: 'Webhook receive and queue' },
      { name: 'observability', description: 'Metrics' },
    ],
  }) as unknown as Record<string, unknown>;
}
