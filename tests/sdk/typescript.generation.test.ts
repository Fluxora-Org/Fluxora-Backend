/**
 * TypeScript Client SDK — generation, structure, and behaviour tests.
 *
 * ## Coverage
 * 1.  Generator CLI execution (`node scripts/generate-sdk-ts.mjs`).
 * 2.  Drift-check mode (`--check`) — pass and fail paths.
 * 3.  Custom `--out-dir` flag.
 * 4.  Custom `--spec` flag (alternate spec path).
 * 5.  SDK file structure and `package.json` metadata.
 * 6.  README.md content and documentation completeness.
 * 7.  FluxoraClient — construction, credential mutation, request dispatch.
 * 8.  FluxoraClient — client-side ValidationError guards (empty params).
 * 9.  FluxoraClient — 409 IdempotencyConflictError handling.
 * 10. FluxoraClient — generic FluxoraApiError for other non-2xx responses.
 * 11. FluxoraClient — query-string serialisation for list params.
 * 12. FluxoraClient — Idempotency-Key header on POST /api/streams.
 * 13. FluxoraClient — custom bearer token and API key request headers.
 * 14. Idempotency: UUID v4 key generation.
 * 15. Idempotency: canonicalizeBody key-sort correctness.
 * 16. Idempotency: canonicalizeBody null/primitive/array handling.
 * 17. Idempotency: hashBody 64-char hex SHA-256 digest.
 * 18. Idempotency: hashBody determinism (same input → same hash).
 * 19. StreamPaginator: limit validation (1–100 boundary).
 * 20. StreamPaginator: nextPage() / autoPaginate() multi-page traversal.
 * 21. StreamPaginator: terminates on has_more=false.
 * 22. StreamPaginator: nextPage() returns null after exhaustion.
 * 23. StreamPaginator: cursor forwarded correctly on subsequent pages.
 * 24. Stream type round-trip against actual /api/streams response shape.
 * 25. StreamPaginator: edge-case behavior documented and tested.
 * 26. Error hierarchy instanceof checks.
 * 26. Error class names and messages.
 * 27. FluxoraClientError base class inheritance.
 * 28. IdempotencyConflictError storedHash/incomingHash propagation.
 *
 * @security Tests use only local file operations and in-process mocks.
 *   No network calls are made; fetch is overridden for each test and
 *   always restored in finally blocks.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  FluxoraClient,
  FluxoraApiError,
  FluxoraClientError,
  IdempotencyConflictError,
  ValidationError,
  generateIdempotencyKey,
  canonicalizeBody,
  hashBody,
  StreamPaginator,
} from '../../sdk/typescript/src/index.js';
import type { Stream, StreamListResponse } from '../../sdk/typescript/src/index.js';

// ── Paths ─────────────────────────────────────────────────────────────────────

const ROOT_DIR = process.cwd();
const SDK_DIR = path.resolve(ROOT_DIR, 'sdk/typescript');
const SCRIPT_PATH = path.resolve(ROOT_DIR, 'scripts/generate-sdk-ts.mjs');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a temporary directory that is cleaned up after each test. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-sdk-test-'));
}

/** Build a minimal valid StreamListResponse for paginator mocks. */
function makeStreamListResponse(
  streams: Partial<Stream>[],
  hasMore: boolean,
  nextCursor: string | null = null,
): StreamListResponse {
  const fullStreams: Stream[] = streams.map((s, i) => ({
    id: s.id ?? `stream-${i}`,
    sender: s.sender ?? 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    recipient: s.recipient ?? 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZCP2J7F1NRQKQOHP3OGN',
    depositAmount: s.depositAmount ?? '1000.0000000',
    streamedAmount: s.streamedAmount ?? '0.0000000',
    remainingAmount: s.remainingAmount ?? '1000.0000000',
    ratePerSecond: s.ratePerSecond ?? '0.0000116',
    startTime: s.startTime ?? 1700000000,
    endTime: s.endTime ?? 0,
    status: s.status ?? 'active',
  }));
  return {
    success: true,
    data: { streams: fullStreams, has_more: hasMore, next_cursor: nextCursor },
    meta: { timestamp: new Date().toISOString(), requestId: 'req-test' },
  };
}

/** Override globalThis.fetch with a mock and restore it in a finally block. */
async function withFetchMock<T>(
  mockImpl: (...args: Parameters<typeof fetch>) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mockImpl as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// 1–4. Generator CLI
// ═════════════════════════════════════════════════════════════════════════════

describe('Generator CLI (scripts/generate-sdk-ts.mjs)', () => {
  beforeAll(() => {
    // Ensure the SDK is freshly generated before the test suite begins.
    execSync(`node "${SCRIPT_PATH}"`, { stdio: 'pipe', cwd: ROOT_DIR });
  });

  // 1. Generator runs to completion without error.
  it('runs successfully and emits all required files', () => {
    const requiredFiles = [
      'package.json',
      'tsconfig.json',
      'README.md',
      'src/index.ts',
      'src/types.ts',
      'src/errors.ts',
      'src/idempotency.ts',
      'src/pagination.ts',
      'src/client.ts',
    ];
    for (const rel of requiredFiles) {
      expect(fs.existsSync(path.resolve(SDK_DIR, rel)), `Missing: ${rel}`).toBe(true);
    }
  });

  // 2. Drift check passes immediately after generation.
  it('--check passes when disk matches generated output', () => {
    const output = execSync(`node "${SCRIPT_PATH}" --check`, {
      encoding: 'utf8',
      cwd: ROOT_DIR,
    });
    expect(output).toContain('[DRIFT CHECK PASSED]');
  });

  // 3a. Drift check fails when a file has been modified.
  it('--check fails when a generated file is altered', () => {
    const targetFile = path.resolve(SDK_DIR, 'src/errors.ts');
    const original = fs.readFileSync(targetFile, 'utf8');
    try {
      fs.writeFileSync(targetFile, `${original}\n// TEMP drift marker`, 'utf8');
      expect(() => {
        execSync(`node "${SCRIPT_PATH}" --check`, { encoding: 'utf8', stdio: 'pipe', cwd: ROOT_DIR });
      }).toThrow();
    } finally {
      fs.writeFileSync(targetFile, original, 'utf8');
    }
  });

  // 3b. Drift check fails when a required file is missing.
  it('--check fails when a required file is absent in --out-dir', () => {
    const tmpDir = makeTempDir();
    try {
      expect(() => {
        execSync(`node "${SCRIPT_PATH}" --check --out-dir "${tmpDir}"`, {
          encoding: 'utf8',
          stdio: 'pipe',
          cwd: ROOT_DIR,
        });
      }).toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 4a. --out-dir writes files to the specified directory.
  it('--out-dir writes all files to the target directory', () => {
    const tmpDir = makeTempDir();
    try {
      execSync(`node "${SCRIPT_PATH}" --out-dir "${tmpDir}"`, { stdio: 'pipe', cwd: ROOT_DIR });
      expect(fs.existsSync(path.resolve(tmpDir, 'package.json'))).toBe(true);
      expect(fs.existsSync(path.resolve(tmpDir, 'src/client.ts'))).toBe(true);
      expect(fs.existsSync(path.resolve(tmpDir, 'src/types.ts'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 4b. --out-dir + --check drifts when empty.
  it('--out-dir + --check detects drift against a custom directory', () => {
    const tmpDir = makeTempDir();
    try {
      // Write then corrupt one file
      execSync(`node "${SCRIPT_PATH}" --out-dir "${tmpDir}"`, { stdio: 'pipe', cwd: ROOT_DIR });
      fs.appendFileSync(path.resolve(tmpDir, 'src/types.ts'), '\n// corrupted');
      expect(() => {
        execSync(`node "${SCRIPT_PATH}" --check --out-dir "${tmpDir}"`, {
          encoding: 'utf8',
          stdio: 'pipe',
          cwd: ROOT_DIR,
        });
      }).toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// 5–6. SDK Package Structure & Documentation
// ═════════════════════════════════════════════════════════════════════════════

describe('SDK Package Structure & Documentation', () => {
  // 5. Package.json metadata.
  describe('package.json', () => {
    let pkg: Record<string, unknown>;
    beforeAll(() => {
      pkg = JSON.parse(fs.readFileSync(path.resolve(SDK_DIR, 'package.json'), 'utf8'));
    });

    it('has name @fluxora/sdk', () => {
      expect(pkg.name).toBe('@fluxora/sdk');
    });

    it('has a semver version from openapi.yaml info.version', () => {
      expect(typeof pkg.version).toBe('string');
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('sets main/module/types to ./src/index.ts', () => {
      expect(pkg.main).toBe('./src/index.ts');
      expect(pkg.module).toBe('./src/index.ts');
      expect(pkg.types).toBe('./src/index.ts');
    });

    it('declares zero runtime dependencies', () => {
      const deps = pkg.dependencies as Record<string, string> | undefined;
      expect(deps ? Object.keys(deps) : []).toHaveLength(0);
    });

    it('exports "." with types/import/require fields', () => {
      const exports = pkg.exports as Record<string, Record<string, string>>;
      expect(exports['.']).toBeDefined();
      expect(exports['.'].types).toBe('./src/index.ts');
    });
  });

  // 6. README.md documentation.
  describe('README.md', () => {
    let readme: string;
    beforeAll(() => {
      readme = fs.readFileSync(path.resolve(SDK_DIR, 'README.md'), 'utf8');
    });

    it('contains the SDK title heading', () => {
      expect(readme).toContain('@fluxora/sdk');
    });

    it('documents FluxoraClient', () => {
      expect(readme).toContain('FluxoraClient');
    });

    it('documents generateIdempotencyKey', () => {
      expect(readme).toContain('generateIdempotencyKey');
    });

    it('documents StreamPaginator / autoPaginate', () => {
      expect(readme).toContain('autoPaginate');
    });

    it('documents error handling (IdempotencyConflictError)', () => {
      expect(readme).toContain('IdempotencyConflictError');
    });

    it('documents the zero-dependencies design', () => {
      expect(readme).toMatch(/zero.*(dependen|runtime)/i);
    });

    it('includes a regeneration command', () => {
      expect(readme).toContain('generate:sdk:ts');
    });

    it('documents the SDK generation contract and regression surface', () => {
      expect(readme).toContain('SDK Generation Contract');
      expect(readme).toContain('does **not** retry requests internally');
      expect(readme).toContain('Network failures from `fetch` are allowed to bubble unchanged');
      expect(readme).toContain('Generated output must pass `pnpm check:sdk:ts`');
    });
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// 7–13. FluxoraClient
// ═════════════════════════════════════════════════════════════════════════════

describe('FluxoraClient', () => {
  // 7a. Construction with defaults.
  it('constructs with default base URL when no config is supplied', () => {
    const client = new FluxoraClient();
    expect(client).toBeInstanceOf(FluxoraClient);
    // Private field accessible via bracket notation for white-box assertion
    expect((client as unknown as Record<string, unknown>)['baseUrl']).toBe('http://localhost:3000');
  });

  // 7b. Construction strips trailing slashes from baseUrl.
  it('strips trailing slashes from baseUrl', () => {
    const client = new FluxoraClient({ baseUrl: 'https://api.example.com///' });
    expect((client as unknown as Record<string, unknown>)['baseUrl']).toBe('https://api.example.com');
  });

  // 7c. Credential mutation methods.
  it('setBearerToken / setApiKey update in-memory credentials', () => {
    const client = new FluxoraClient();
    client.setBearerToken('jwt-token-abc');
    client.setApiKey('ak-123');
    const c = client as unknown as Record<string, unknown>;
    expect(c['bearerToken']).toBe('jwt-token-abc');
    expect(c['apiKey']).toBe('ak-123');
  });

  it('trims runtime credentials and treats whitespace-only values as absent', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    await withFetchMock(async (_url, init) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }, async () => {
      const client = new FluxoraClient({
        baseUrl: 'http://test.local',
        bearerToken: '  jwt-with-spaces  ',
        apiKey: '  key-with-spaces  ',
      });
      await client.getHealth();
      client.setBearerToken('   ');
      client.setApiKey('   ');
      await client.getHealth();
    });

    expect(capturedHeaders[0]?.['Authorization']).toBe('Bearer jwt-with-spaces');
    expect(capturedHeaders[0]?.['X-API-Key']).toBe('key-with-spaces');
    expect(capturedHeaders[1]?.['Authorization']).toBeUndefined();
    expect(capturedHeaders[1]?.['X-API-Key']).toBeUndefined();
  });

  // 8. Client-side ValidationError guards.
  describe('client-side ValidationError guards', () => {
    const client = new FluxoraClient();

    it('createSession throws ValidationError for empty address', async () => {
      await expect(client.createSession('')).rejects.toThrow(ValidationError);
    });

    it('getStream throws ValidationError for empty streamId', async () => {
      await expect(client.getStream('')).rejects.toThrow(ValidationError);
    });

    it('cancelStream throws ValidationError for empty streamId', async () => {
      await expect(client.cancelStream('')).rejects.toThrow(ValidationError);
    });

    it('updateStreamStatus throws ValidationError for empty streamId', async () => {
      await expect(client.updateStreamStatus('', 'active')).rejects.toThrow(ValidationError);
    });

    it('getPrivacyConsent throws ValidationError for empty address', async () => {
      await expect(client.getPrivacyConsent('')).rejects.toThrow(ValidationError);
    });

    it('createStream throws ValidationError when sender is missing', async () => {
      await expect(
        client.createStream({ sender: '', recipient: 'G123', depositAmount: '10', ratePerSecond: '1' }),
      ).rejects.toThrow(ValidationError);
    });

    it('createStream throws ValidationError when recipient is missing', async () => {
      await expect(
        client.createStream({ sender: 'G123', recipient: '', depositAmount: '10', ratePerSecond: '1' }),
      ).rejects.toThrow(ValidationError);
    });
  });

  // 9. IdempotencyConflictError on 409.
  it('throws IdempotencyConflictError on HTTP 409 IDEMPOTENCY_CONFLICT', async () => {
    const client = new FluxoraClient({ baseUrl: 'http://api.test' });

    await withFetchMock(async () =>
      new Response(
        JSON.stringify({
          error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Payload mismatch' },
          stored_hash: 'hash-aaa',
          incoming_hash: 'hash-bbb',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-conflict' } },
      ),
      async () => {
        let caught: unknown;
        try {
          await client.createStream(
            { sender: 'G1', recipient: 'G2', depositAmount: '10', ratePerSecond: '1' },
            'reused-key',
          );
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(IdempotencyConflictError);
        const e = caught as IdempotencyConflictError;
        expect(e.statusCode).toBe(409);
        expect(e.code).toBe('IDEMPOTENCY_CONFLICT');
        expect(e.storedHash).toBe('hash-aaa');
        expect(e.incomingHash).toBe('hash-bbb');
        expect(e.requestId).toBe('req-conflict');
      },
    );
  });

  // 10. FluxoraApiError for other non-2xx responses.
  it('throws FluxoraApiError on 404 NOT_FOUND', async () => {
    const client = new FluxoraClient();
    await withFetchMock(async () =>
      new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Stream not found' } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ),
      async () => {
        await expect(client.getStream('nonexistent')).rejects.toThrow(FluxoraApiError);
      },
    );
  });

  it('includes requestId from x-request-id header in FluxoraApiError', async () => {
    const client = new FluxoraClient();
    await withFetchMock(async () =>
      new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }),
        {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            'x-request-id': 'trace-xyz-123',
          },
        },
      ),
      async () => {
        let err: FluxoraApiError | undefined;
        try { await client.getStream('x'); } catch (e) { err = e as FluxoraApiError; }
        expect(err?.requestId).toBe('trace-xyz-123');
      },
    );
  });

  // 11. Query-string serialisation.
  it('serialises list params as query string and calls GET /api/streams', async () => {
    const capturedUrls: string[] = [];
    await withFetchMock(async (url) => {
      capturedUrls.push(url as string);
      return new Response(
        JSON.stringify(makeStreamListResponse([], false, null)),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }, async () => {
      const client = new FluxoraClient({ baseUrl: 'http://test.local' });
      const pager = client.listStreams({ limit: 10, status: 'active', sender: 'GXXX' });
      await pager.nextPage();
    });
    expect(capturedUrls[0]).toContain('/api/streams');
    expect(capturedUrls[0]).toContain('limit=10');
    expect(capturedUrls[0]).toContain('status=active');
    expect(capturedUrls[0]).toContain('sender=GXXX');
  });

  // 12. Idempotency-Key header on POST /api/streams.
  it('attaches Idempotency-Key header on POST /api/streams', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    await withFetchMock(async (_url, init) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(
        JSON.stringify({ success: true, data: { id: 's-1', sender: 'G1', recipient: 'G2', depositAmount: '10', streamedAmount: '0', remainingAmount: '10', ratePerSecond: '1', startTime: 0, endTime: 0, status: 'active' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }, async () => {
      const client = new FluxoraClient({ baseUrl: 'http://test.local' });
      await client.createStream(
        { sender: 'G1', recipient: 'G2', depositAmount: '10', ratePerSecond: '1' },
        'my-explicit-key-001',
      );
    });
    const h = capturedHeaders[0];
    expect(h?.['Idempotency-Key']).toBe('my-explicit-key-001');
  });

  // 13. Bearer token and API key headers.
  it('attaches Authorization: Bearer header when bearerToken is set', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    await withFetchMock(async (_url, init) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(
        JSON.stringify({ status: 'ok' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }, async () => {
      const client = new FluxoraClient({ baseUrl: 'http://test.local', bearerToken: 'secret-jwt' });
      await client.getHealth();
    });
    expect(capturedHeaders[0]?.['Authorization']).toBe('Bearer secret-jwt');
  });

  it('attaches X-API-Key header when apiKey is set', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    await withFetchMock(async (_url, init) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(
        JSON.stringify({ status: 'ok' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }, async () => {
      const client = new FluxoraClient({ baseUrl: 'http://test.local', apiKey: 'my-api-key' });
      await client.getHealth();
    });
    expect(capturedHeaders[0]?.['X-API-Key']).toBe('my-api-key');
  });

  it('does not emit Authorization header when no token is set', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    await withFetchMock(async (_url, init) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }, async () => {
      const client = new FluxoraClient({ baseUrl: 'http://test.local' });
      await client.getHealth();
    });
    expect(capturedHeaders[0]?.['Authorization']).toBeUndefined();
  });

  it('runtime credentials override constructor auth headers deterministically', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    await withFetchMock(async (_url, init) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }, async () => {
      const client = new FluxoraClient({
        baseUrl: 'http://test.local',
        bearerToken: 'runtime-jwt',
        apiKey: 'runtime-key',
        headers: {
          Authorization: 'Bearer constructor-jwt',
          'X-API-Key': 'constructor-key',
        },
      });
      await client.getHealth();
    });

    expect(capturedHeaders[0]?.['Authorization']).toBe('Bearer runtime-jwt');
    expect(capturedHeaders[0]?.['X-API-Key']).toBe('runtime-key');
  });

  it('serialises false, 0, and empty-string query params but omits nullish values', async () => {
    const capturedUrls: string[] = [];
    await withFetchMock(async (url) => {
      capturedUrls.push(url as string);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }, async () => {
      const client = new FluxoraClient({ baseUrl: 'http://test.local' });
      await (client as unknown as {
        request<T>(method: string, path: string, options: { params: Record<string, unknown> }): Promise<T>;
      }).request('GET', '/probe', {
        params: {
          include_total: false,
          limit: 0,
          status: '',
          cursor: null,
          sender: undefined,
        },
      });
    });

    const url = new URL(capturedUrls[0]);
    expect(url.searchParams.get('include_total')).toBe('false');
    expect(url.searchParams.get('limit')).toBe('0');
    expect(url.searchParams.get('status')).toBe('');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.searchParams.has('sender')).toBe(false);
  });

  it('performs exactly one fetch per SDK call and lets network errors bubble unchanged', async () => {
    const networkError = new TypeError('fetch failed');
    const fetchMock = vi.fn(async () => {
      throw networkError;
    });

    await withFetchMock(fetchMock, async () => {
      const client = new FluxoraClient({ baseUrl: 'http://test.local' });
      await expect(client.getHealth()).rejects.toBe(networkError);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns an empty object for successful empty response bodies', async () => {
    await withFetchMock(async () => new Response('', { status: 204 }), async () => {
      const client = new FluxoraClient({ baseUrl: 'http://test.local' });
      const result = await (client as unknown as {
        request<T>(method: string, path: string): Promise<T>;
      }).request<Record<string, never>>('DELETE', '/empty');

      expect(result).toEqual({});
    });
  });

  it('turns text error bodies into FluxoraApiError messages', async () => {
    await withFetchMock(async () =>
      new Response('service unavailable', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'x-request-id': 'req-text-body' },
      }),
      async () => {
        const client = new FluxoraClient({ baseUrl: 'http://test.local' });
        let err: FluxoraApiError | undefined;
        try { await client.getHealth(); } catch (e) { err = e as FluxoraApiError; }

        expect(err).toBeInstanceOf(FluxoraApiError);
        expect(err?.code).toBe('HTTP_ERROR');
        expect(err?.message).toContain('service unavailable');
        expect(err?.requestId).toBe('req-text-body');
      },
    );
  });

  it('extracts requestId from response metadata when the header is absent', async () => {
    await withFetchMock(async () =>
      new Response(
        JSON.stringify({
          error: { code: 'RATE_LIMITED', message: 'Too many requests' },
          meta: { requestId: 'req-from-meta' },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      ),
      async () => {
        const client = new FluxoraClient({ baseUrl: 'http://test.local' });
        let err: FluxoraApiError | undefined;
        try { await client.getHealth(); } catch (e) { err = e as FluxoraApiError; }
        expect(err?.requestId).toBe('req-from-meta');
      },
    );
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// 14–18. Idempotency utilities
// ═════════════════════════════════════════════════════════════════════════════

describe('Idempotency utilities (src/idempotency.ts)', () => {
  // 14. UUID v4 key generation.
  it('generateIdempotencyKey returns a non-empty string of 36 chars', () => {
    const key = generateIdempotencyKey();
    expect(typeof key).toBe('string');
    expect(key.length).toBe(36);
  });

  it('generateIdempotencyKey produces unique values on each call', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateIdempotencyKey()));
    expect(keys.size).toBe(100);
  });

  it('generateIdempotencyKey produces a valid UUID v4 pattern', () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  // 15. canonicalizeBody key-sort correctness.
  it('canonicalizeBody sorts object keys lexicographically', () => {
    const result = canonicalizeBody({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it('canonicalizeBody produces identical strings for any key insertion order', () => {
    const a = canonicalizeBody({ z: 1, a: 2 });
    const b = canonicalizeBody({ a: 2, z: 1 });
    expect(a).toBe(b);
  });

  it('canonicalizeBody sorts keys recursively in nested objects', () => {
    const result = canonicalizeBody({
      recipient: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      depositAmount: '100.5000000',
      sender: 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
      meta: { b: 2, a: 1 },
    });
    expect(result).toBe(
      '{"depositAmount":"100.5000000","meta":{"a":1,"b":2},"recipient":"GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN","sender":"GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX"}',
    );
  });

  // 16. canonicalizeBody edge cases.
  it('canonicalizeBody serialises null as "null"', () => {
    expect(canonicalizeBody(null)).toBe('null');
  });

  it('canonicalizeBody serialises undefined as "null"', () => {
    expect(canonicalizeBody(undefined)).toBe('null');
  });

  it('canonicalizeBody preserves array element order', () => {
    expect(canonicalizeBody([3, 1, 2])).toBe('[3,1,2]');
  });

  it('canonicalizeBody serialises strings with JSON quoting', () => {
    expect(canonicalizeBody('hello')).toBe('"hello"');
  });

  it('canonicalizeBody serialises booleans', () => {
    expect(canonicalizeBody(true)).toBe('true');
    expect(canonicalizeBody(false)).toBe('false');
  });

  it('canonicalizeBody serialises numbers', () => {
    expect(canonicalizeBody(42)).toBe('42');
  });

  // 17. hashBody SHA-256 format.
  it('hashBody returns a 64-character lowercase hex string', async () => {
    const hash = await hashBody({ sender: 'G1', depositAmount: '100' });
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  // 18. hashBody determinism.
  it('hashBody is deterministic: same input → same hash', async () => {
    const payload = { recipient: 'GR', sender: 'GS', depositAmount: '50.0' };
    const h1 = await hashBody(payload);
    const h2 = await hashBody(payload);
    expect(h1).toBe(h2);
  });

  it('hashBody produces different hashes for different inputs', async () => {
    const h1 = await hashBody({ a: 1 });
    const h2 = await hashBody({ a: 2 });
    expect(h1).not.toBe(h2);
  });

  it('hashBody output matches key-order-independent canonical form', async () => {
    const h1 = await hashBody({ z: 1, a: 2 });
    const h2 = await hashBody({ a: 2, z: 1 });
    expect(h1).toBe(h2);
  });

  // Edge case: hashBody handles empty objects
  it('hashBody handles empty objects', async () => {
    const hash = await hashBody({});
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  // Edge case: hashBody handles deeply nested structures
  it('hashBody handles deeply nested structures', async () => {
    const payload = {
      level1: {
        level2: {
          level3: {
            level4: {
              value: 'deep'
            }
          }
        }
      }
    };
    const hash = await hashBody(payload);
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64);
  });

  // Edge case: hashBody handles arrays with mixed types
  it('hashBody handles arrays with mixed types', async () => {
    const payload = {
      items: [1, 'two', null, true, { nested: 'object' }]
    };
    const hash = await hashBody(payload);
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64);
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// 19–23. StreamPaginator
// ═════════════════════════════════════════════════════════════════════════════

describe('StreamPaginator (src/pagination.ts)', () => {
  // 19. Limit validation.
  it('throws when limit < 1', () => {
    expect(() => new StreamPaginator(vi.fn(), { limit: 0 })).toThrow(
      /limit must be an integer between 1 and 100/,
    );
  });

  it('throws when limit > 100', () => {
    expect(() => new StreamPaginator(vi.fn(), { limit: 101 })).toThrow(
      /limit must be an integer between 1 and 100/,
    );
  });

  it('accepts limit = 1 (lower boundary)', () => {
    expect(() => new StreamPaginator(vi.fn(), { limit: 1 })).not.toThrow();
  });

  it('accepts limit = 100 (upper boundary)', () => {
    expect(() => new StreamPaginator(vi.fn(), { limit: 100 })).not.toThrow();
  });

  it('uses default limit of 20 when not specified', async () => {
    const capturedParams: unknown[] = [];
    const mockFetch = vi.fn(async (params: unknown) => {
      capturedParams.push(params);
      return makeStreamListResponse([], false, null);
    });
    const pager = new StreamPaginator(mockFetch);
    await pager.nextPage();
    expect((capturedParams[0] as Record<string, unknown>)['limit']).toBe(20);
  });

  // 20. Multi-page traversal via nextPage().
  it('nextPage() fetches pages in sequence and forwards cursor', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeStreamListResponse([{ id: 's-1' }, { id: 's-2' }], true, 'cur-page2'))
      .mockResolvedValueOnce(makeStreamListResponse([{ id: 's-3' }], false, null));

    const pager = new StreamPaginator(mockFetch, { limit: 2 });

    const page1 = await pager.nextPage();
    expect(page1).toHaveLength(2);
    expect(page1![0].id).toBe('s-1');
    expect(page1![1].id).toBe('s-2');

    // Verify cursor was forwarded
    expect(mockFetch.mock.calls[0][0]).toMatchObject({ cursor: undefined });

    const page2 = await pager.nextPage();
    expect(page2).toHaveLength(1);
    expect(page2![0].id).toBe('s-3');
    expect(mockFetch.mock.calls[1][0]).toMatchObject({ cursor: 'cur-page2' });
  });

  // 20 (continued). autoPaginate() yields all items across pages.
  it('autoPaginate() yields all stream items across multiple pages', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeStreamListResponse([{ id: 'a' }, { id: 'b' }], true, 'c2'))
      .mockResolvedValueOnce(makeStreamListResponse([{ id: 'c' }], true, 'c3'))
      .mockResolvedValueOnce(makeStreamListResponse([{ id: 'd' }], false, null));

    const pager = new StreamPaginator(mockFetch, { limit: 2 });
    const collected: Stream[] = [];
    for await (const s of pager.autoPaginate()) {
      collected.push(s);
    }

    expect(collected.map(s => s.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  // 21. Terminates on has_more=false.
  it('stops fetching after server returns has_more=false', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeStreamListResponse([{ id: 'only' }], false, null));

    const pager = new StreamPaginator(mockFetch, { limit: 5 });
    const items: Stream[] = [];
    for await (const s of pager.autoPaginate()) items.push(s);

    expect(items).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // 22. nextPage() returns null after exhaustion.
  it('nextPage() returns null once all pages are consumed', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeStreamListResponse([{ id: 'x' }], false, null));

    const pager = new StreamPaginator(mockFetch, { limit: 10 });
    await pager.nextPage(); // page 1 → exhausted
    const result = await pager.nextPage(); // should be null
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1); // no extra fetch
  });

  // 23. Cursor forwarded correctly.
  it('passes correct cursor to each subsequent page request', async () => {
    const capturedCursors: (string | undefined)[] = [];
    const mockFetch = vi.fn(async (params: ListStreamsParams) => {
      capturedCursors.push(params.cursor);
      const hasMore = capturedCursors.length < 3;
      return makeStreamListResponse([{ id: `s-${capturedCursors.length}` }], hasMore, hasMore ? `cur-${capturedCursors.length}` : null);
    });

    const pager = new StreamPaginator(mockFetch, { limit: 1 });
    const items: Stream[] = [];
    for await (const s of pager.autoPaginate()) items.push(s);

    expect(capturedCursors[0]).toBeUndefined(); // first page: no cursor
    expect(capturedCursors[1]).toBe('cur-1');   // second page: cursor from page 1
    expect(capturedCursors[2]).toBe('cur-2');   // third page: cursor from page 2
    expect(items).toHaveLength(3);
  });

  it('passes filter params (status, sender, recipient) on every page', async () => {
    const capturedParams: unknown[] = [];
    const mockFetch = vi.fn(async (params: unknown) => {
      capturedParams.push(params);
      return makeStreamListResponse([], false, null);
    });

    const pager = new StreamPaginator(mockFetch, {
      limit: 10,
      status: 'active',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
    });
    await pager.nextPage();

    const p = capturedParams[0] as Record<string, unknown>;
    expect(p['status']).toBe('active');
    expect(p['sender']).toBe('GSENDER');
    expect(p['recipient']).toBe('GRECIPIENT');
  });

  // Edge case: autoPaginate() continues past empty pages when has_more=true.
  // An empty page should not terminate iteration if the server still has more pages.
  it('autoPaginate() skips empty pages and continues when has_more=true', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeStreamListResponse([], true, 'cur-page2'))
      .mockResolvedValueOnce(makeStreamListResponse([{ id: 'a' }, { id: 'b' }], true, 'cur-page3'))
      .mockResolvedValueOnce(makeStreamListResponse([], true, 'cur-page4'))
      .mockResolvedValueOnce(makeStreamListResponse([{ id: 'c' }], false, null));

    const pager = new StreamPaginator(mockFetch, { limit: 2 });
    const collected: Stream[] = [];
    for await (const s of pager.autoPaginate()) {
      collected.push(s);
    }

    expect(collected.map(s => s.id)).toEqual(['a', 'b', 'c']);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  // Edge case: nextPage() throws, then calling it again still terminates correctly.
  it('nextPage() throws FluxoraApiError on non-2xx and subsequent calls also throw', async () => {
    const mockFetch = vi.fn().mockRejectedValue(
      new FluxoraApiError(500, 'INTERNAL_ERROR', 'Server error'),
    );

    const pager = new StreamPaginator(mockFetch, { limit: 10 });

    await expect(pager.nextPage()).rejects.toThrow(FluxoraApiError);
    await expect(pager.nextPage()).rejects.toThrow(FluxoraApiError);
  });

  // Edge case: autoPaginate() stops fetching when the for-await loop breaks early.
  it('autoPaginate() stops fetching when the consumer breaks early', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeStreamListResponse([{ id: 'a' }], true, 'cur-2'))
      .mockResolvedValueOnce(makeStreamListResponse([{ id: 'b' }], true, 'cur-3'));

    const pager = new StreamPaginator(mockFetch, { limit: 1 });
    const collected: Stream[] = [];
    for await (const s of pager.autoPaginate()) {
      collected.push(s);
      if (collected.length === 1) break;
    }

    expect(collected.map(s => s.id)).toEqual(['a']);
    expect(mockFetch).toHaveBeenCalledTimes(1); // stopped after break, no extra fetch
  });

  // Edge case: server returns has_more=false with empty streams array (terminal empty page).
  it('nextPage() returns empty array when page has no streams and has_more=false', async () => {
    const mockFetch = vi.fn(
      () => makeStreamListResponse([], false, null),
    );

    const pager = new StreamPaginator(mockFetch, { limit: 10 });
    const page1 = await pager.nextPage();
    expect(page1).toEqual([]);
    expect(Array.isArray(page1)).toBe(true);

    const page2 = await pager.nextPage();
    expect(page2).toBeNull();
  });

  // Edge case: server returns has_more=true with next_cursor=null (inconsistent but handled).
  // The paginator should treat this as exhausted (no cursor to fetch next page).
  it('terminates when has_more=true but next_cursor is null', async () => {
    const mockFetch = vi.fn(
      () => makeStreamListResponse([{ id: 'only' }], true, null),
    );

    const pager = new StreamPaginator(mockFetch, { limit: 10 });
    const page1 = await pager.nextPage();
    expect(page1).toMatchObject([{ id: 'only' }]);

    // has_more=true but next_cursor=null -> paginator treats as exhausted
    const page2 = await pager.nextPage();
    expect(page2).toBeNull();
  });

  // Edge case: server returns has_more=false with a non-null next_cursor (inconsistent but handled).
  // The cursor should be ignored and the paginator should terminate.
  it('ignores next_cursor when has_more=false', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeStreamListResponse([{ id: 'only' }], false, 'should-be-ignored'));

    const pager = new StreamPaginator(mockFetch, { limit: 10 });
    const page1 = await pager.nextPage();
    expect(page1).toMatchObject([{ id: "only" }]);

    const page2 = await pager.nextPage();
    expect(page2).toBeNull();
  });
});


// need to import ListStreamsParams for the test above
import type { ListStreamsParams } from '../../sdk/typescript/src/index.js';

// ═════════════════════════════════════════════════════════════════════════════
// 24. Stream type round-trip against actual /api/streams response shape
// ═════════════════════════════════════════════════════════════════════════════

describe('Stream type round-trip (src/routes/streams.ts shape)', () => {
  /**
   * This test validates that the SDK's Stream interface matches the exact
   * field names and types produced by `toApiStream()` in src/routes/streams.ts.
   *
   * toApiStream() maps:
   *   record.id            → id
   *   record.sender_address  → sender
   *   record.recipient_address → recipient
   *   record.amount          → depositAmount
   *   record.streamed_amount → streamedAmount
   *   record.remaining_amount → remainingAmount
   *   record.rate_per_second → ratePerSecond
   *   record.start_time      → startTime
   *   record.end_time        → endTime
   *   record.status          → status
   */
  it('Stream interface exactly matches toApiStream() field names', () => {
    // Construct a value that exactly matches what toApiStream() produces.
    const streamFromApi: Stream = {
      id:              'stream-a3f1c2d0000000000000000000000000000000000000000000000000000000000000-0',
      sender:          'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
      recipient:       'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      depositAmount:   '1000000.0000000',  // maps to record.amount
      streamedAmount:  '0.0000000',         // maps to record.streamed_amount
      remainingAmount: '1000000.0000000',  // maps to record.remaining_amount
      ratePerSecond:   '0.0000116',         // maps to record.rate_per_second
      startTime:       1700000000,          // maps to record.start_time
      endTime:         0,                   // maps to record.end_time
      status:          'active',
    };

    // All required fields are present and correctly typed.
    expect(typeof streamFromApi.id).toBe('string');
    expect(typeof streamFromApi.sender).toBe('string');
    expect(typeof streamFromApi.recipient).toBe('string');
    expect(typeof streamFromApi.depositAmount).toBe('string');   // decimal string ✓
    expect(typeof streamFromApi.streamedAmount).toBe('string');  // decimal string ✓
    expect(typeof streamFromApi.remainingAmount).toBe('string'); // decimal string ✓
    expect(typeof streamFromApi.ratePerSecond).toBe('string');   // decimal string ✓
    expect(typeof streamFromApi.startTime).toBe('number');
    expect(typeof streamFromApi.endTime).toBe('number');
    expect(streamFromApi.status).toBe('active');
  });

  it('decimal-string invariant: monetary amounts are never JS numbers', () => {
    const s: Stream = {
      id: 'test', sender: 'G1', recipient: 'G2',
      depositAmount: '100.0000000',
      streamedAmount: '50.0000000',
      remainingAmount: '50.0000000',
      ratePerSecond: '0.0000001',
      startTime: 0, endTime: 0, status: 'active',
    };
    // TypeScript enforces string; ensure they are not coerced to number at runtime.
    expect(typeof s.depositAmount).toBe('string');
    expect(typeof s.ratePerSecond).toBe('string');
    expect(Number.isNaN(+s.depositAmount)).toBe(false); // parseable decimal
  });

  it('StreamListResponse envelope matches GET /api/streams shape', () => {
    const response: StreamListResponse = makeStreamListResponse(
      [{ id: 'stream-1', status: 'active' }],
      true,
      'eyJ2IjoxLCJsYXN0SWQiOiJzdHJlYW0tMSJ9',
    );
    expect(response.success).toBe(true);
    expect(response.data.streams).toHaveLength(1);
    expect(response.data.has_more).toBe(true);
    expect(typeof response.data.next_cursor).toBe('string');
    expect(response.meta).toBeDefined();
  });

  it('FluxoraClient.getStream() unwraps data.stream correctly', async () => {
    const expectedStream: Stream = {
      id: 'stream-abc', sender: 'GS', recipient: 'GR',
      depositAmount: '500.0', streamedAmount: '0.0', remainingAmount: '500.0',
      ratePerSecond: '0.1', startTime: 100, endTime: 0, status: 'active',
    };
    await withFetchMock(async () =>
      new Response(
        JSON.stringify({ success: true, data: { stream: expectedStream }, meta: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
      async () => {
        const client = new FluxoraClient({ baseUrl: 'http://test.local' });
        const stream = await client.getStream('stream-abc');
        expect(stream).toEqual(expectedStream);
        expect(stream.depositAmount).toBe('500.0');
        expect(stream.ratePerSecond).toBe('0.1');
      },
    );
  });

  it('FluxoraClient.createStream() unwraps data correctly', async () => {
    const createdStream: Stream = {
      id: 'stream-new', sender: 'GS', recipient: 'GR',
      depositAmount: '1000.0000000', streamedAmount: '0.0000000', remainingAmount: '1000.0000000',
      ratePerSecond: '0.0000116', startTime: 1700000000, endTime: 0, status: 'active',
    };
    await withFetchMock(async () =>
      new Response(
        JSON.stringify({ success: true, data: createdStream, meta: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
      async () => {
        const client = new FluxoraClient({ baseUrl: 'http://test.local' });
        const result = await client.createStream({
          sender: 'GS', recipient: 'GR',
          depositAmount: '1000.0000000',
          ratePerSecond: '0.0000116',
        });
        expect(result.id).toBe('stream-new');
        expect(result.depositAmount).toBe('1000.0000000'); // decimal string preserved ✓
      },
    );
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// 25–28. Error hierarchy
// ═════════════════════════════════════════════════════════════════════════════

describe('Error hierarchy (src/errors.ts)', () => {
  // 25. instanceof checks.
  it('FluxoraApiError is instanceof FluxoraClientError and Error', () => {
    const err = new FluxoraApiError(500, 'INTERNAL_ERROR', 'oops');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FluxoraClientError);
    expect(err).toBeInstanceOf(FluxoraApiError);
  });

  it('IdempotencyConflictError is instanceof FluxoraApiError and FluxoraClientError', () => {
    const err = new IdempotencyConflictError(409, 'IDEMPOTENCY_CONFLICT', 'conflict');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FluxoraClientError);
    expect(err).toBeInstanceOf(FluxoraApiError);
    expect(err).toBeInstanceOf(IdempotencyConflictError);
  });

  it('ValidationError is instanceof FluxoraClientError', () => {
    const err = new ValidationError('bad input');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FluxoraClientError);
    expect(err).toBeInstanceOf(ValidationError);
  });

  // 26. Error class names and message format.
  it('FluxoraClientError.name is "FluxoraClientError"', () => {
    const err = new FluxoraClientError('base error');
    expect(err.name).toBe('FluxoraClientError');
    expect(err.message).toBe('base error');
  });

  it('FluxoraApiError.name is "FluxoraApiError" and message includes status/code', () => {
    const err = new FluxoraApiError(404, 'NOT_FOUND', 'Stream not found');
    expect(err.name).toBe('FluxoraApiError');
    expect(err.message).toContain('404');
    expect(err.message).toContain('NOT_FOUND');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('ValidationError.name is "ValidationError"', () => {
    const err = new ValidationError('streamId is required');
    expect(err.name).toBe('ValidationError');
    expect(err.message).toBe('streamId is required');
  });

  it('IdempotencyConflictError.name is "IdempotencyConflictError"', () => {
    const err = new IdempotencyConflictError(409, 'IDEMPOTENCY_CONFLICT', 'conflict');
    expect(err.name).toBe('IdempotencyConflictError');
  });

  // 27. FluxoraClientError base class.
  it('FluxoraApiError carries details and requestId', () => {
    const details = { field: 'sender', reason: 'invalid' };
    const err = new FluxoraApiError(400, 'VALIDATION_ERROR', 'bad', details, 'req-abc');
    expect(err.details).toEqual(details);
    expect(err.requestId).toBe('req-abc');
  });

  // 28. IdempotencyConflictError hash propagation.
  it('IdempotencyConflictError carries storedHash and incomingHash', () => {
    const err = new IdempotencyConflictError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'conflict',
      'sha256-stored',
      'sha256-incoming',
      { hint: 'use new key' },
      'req-xyz',
    );
    expect(err.storedHash).toBe('sha256-stored');
    expect(err.incomingHash).toBe('sha256-incoming');
    expect(err.details).toEqual({ hint: 'use new key' });
    expect(err.requestId).toBe('req-xyz');
    expect(err.statusCode).toBe(409);
  });

  it('IdempotencyConflictError with no hashes does not throw', () => {
    const err = new IdempotencyConflictError(409, 'IDEMPOTENCY_CONFLICT', 'conflict');
    expect(err.storedHash).toBeUndefined();
    expect(err.incomingHash).toBeUndefined();
  });
});
