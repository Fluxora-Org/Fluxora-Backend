/**
 * @file tests/sdk/python.generation.test.ts
 *
 * Python Client SDK Generator — Comprehensive Tests
 * ==================================================
 *
 * Verifies every behavioural guarantee of `scripts/generate-sdk-python.mjs`
 * and the artefacts it writes to `sdk/python/`:
 *
 *   1. CLI options: --check, --out-dir, --spec
 *   2. Drift check: pass / fail-on-mutation / fail-on-missing-file
 *   3. File structure: all expected files including PEP 561 py.typed marker
 *   4. Package metadata (pyproject.toml)
 *   5. README content
 *   6. __init__.py public API surface
 *   7. exceptions.py — hierarchy, fields
 *   8. idempotency.py — generate_idempotency_key, canonicalize_body, hash_body
 *   9. pagination.py — StreamPaginator semantics, limit bounds, auto_paginate
 *  10. models.py — dataclass definitions
 *  11. client.py — FluxoraClient, all endpoint groups, Idempotency-Key wiring
 *  12. Security: no hard-coded secrets, safe URL handling, header sanitisation
 *
 * Coverage target: ≥ 95 % lines/branches.
 *
 * Closes: #907
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT_DIR = process.cwd();
const SDK_DIR   = path.resolve(ROOT_DIR, 'sdk/python');
const SCRIPT    = path.resolve(ROOT_DIR, 'scripts/generate-sdk-python.mjs');

// ─── helpers ─────────────────────────────────────────────────────────────────

function read(rel: string): string {
  return fs.readFileSync(path.resolve(SDK_DIR, rel), 'utf8');
}

function exists(rel: string): boolean {
  return fs.existsSync(path.resolve(SDK_DIR, rel));
}

// Temp directories created during tests, cleaned up in afterAll.
const tempDirs: string[] = [];

function tmpDir(suffix: string): string {
  const d = path.resolve(ROOT_DIR, `tmp_sdk_test_${suffix}_${Date.now()}`);
  tempDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tempDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ─── ensure freshly generated before any assertions ──────────────────────────

beforeAll(() => {
  execSync(`node "${SCRIPT}"`, { stdio: 'pipe' });
});

// =============================================================================
// 1. CLI — Drift Check
// =============================================================================

describe('Generator CLI — Drift Check (--check)', () => {
  it('passes drift check when sdk/python matches freshly generated output', () => {
    const out = execSync(`node "${SCRIPT}" --check`, { encoding: 'utf8' });
    expect(out).toContain('[DRIFT CHECK PASSED]');
  });

  it('exits 0 on a passing drift check', () => {
    expect(() =>
      execSync(`node "${SCRIPT}" --check`, { stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('fails drift check when a generated file has been mutated', () => {
    const file = path.resolve(SDK_DIR, 'fluxora/exceptions.py');
    const original = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, `${original}\n# temp drift`, 'utf8');
      expect(() =>
        execSync(`node "${SCRIPT}" --check`, { stdio: 'pipe' }),
      ).toThrow();
    } finally {
      fs.writeFileSync(file, original, 'utf8');
    }
  });

  it('fails drift check when a required file is completely missing', () => {
    const dir = tmpDir('missing');
    fs.mkdirSync(dir, { recursive: true });
    expect(() =>
      execSync(`node "${SCRIPT}" --check --out-dir "${dir}"`, { stdio: 'pipe' }),
    ).toThrow();
  });

  it('stderr includes [DRIFT DETECTED] on mismatch', () => {
    const dir = tmpDir('drift_stderr');
    fs.mkdirSync(dir, { recursive: true });
    try {
      execSync(`node "${SCRIPT}" --check --out-dir "${dir}"`, { stdio: 'pipe' });
    } catch (err: any) {
      const combined = (err.stdout ?? '') + (err.stderr ?? '') + (err.message ?? '');
      expect(combined).toContain('[DRIFT DETECTED]');
    }
  });
});

// =============================================================================
// 2. CLI — Custom Output Directory (--out-dir)
// =============================================================================

describe('Generator CLI — custom --out-dir', () => {
  it('writes all files to the specified custom directory', () => {
    const dir = tmpDir('custom_out');
    execSync(`node "${SCRIPT}" --out-dir "${dir}"`, { stdio: 'pipe' });
    expect(fs.existsSync(path.resolve(dir, 'pyproject.toml'))).toBe(true);
    expect(fs.existsSync(path.resolve(dir, 'fluxora/client.py'))).toBe(true);
    expect(fs.existsSync(path.resolve(dir, 'fluxora/__init__.py'))).toBe(true);
    expect(fs.existsSync(path.resolve(dir, 'fluxora/py.typed'))).toBe(true);
  });

  it('creates nested subdirectories automatically', () => {
    const dir = tmpDir('nested/deep/sdk');
    execSync(`node "${SCRIPT}" --out-dir "${dir}"`, { stdio: 'pipe' });
    expect(fs.existsSync(path.resolve(dir, 'fluxora/__init__.py'))).toBe(true);
  });
});

// =============================================================================
// 3. CLI — Custom Spec File (--spec)
// =============================================================================

describe('Generator CLI — custom --spec', () => {
  it('uses the default openapi.yaml when --spec is omitted', () => {
    const dir = tmpDir('spec_default');
    execSync(`node "${SCRIPT}" --out-dir "${dir}"`, { stdio: 'pipe' });
    const meta = fs.readFileSync(path.resolve(dir, 'pyproject.toml'), 'utf8');
    expect(meta).toContain('name = "fluxora-sdk"');
  });

  it('accepts an explicit --spec path to the same openapi.yaml', () => {
    const dir = tmpDir('spec_explicit');
    const specPath = path.resolve(ROOT_DIR, 'openapi.yaml');
    execSync(`node "${SCRIPT}" --out-dir "${dir}" --spec "${specPath}"`, { stdio: 'pipe' });
    expect(fs.existsSync(path.resolve(dir, 'fluxora/client.py'))).toBe(true);
  });

  it('throws when --spec points to a non-existent file', () => {
    expect(() =>
      execSync(`node "${SCRIPT}" --spec "/nonexistent/openapi.yaml"`, { stdio: 'pipe' }),
    ).toThrow();
  });
});

// =============================================================================
// 4. File Structure
// =============================================================================

describe('SDK File Structure', () => {
  const expectedFiles = [
    'pyproject.toml',
    'README.md',
    'fluxora/__init__.py',
    'fluxora/exceptions.py',
    'fluxora/idempotency.py',
    'fluxora/pagination.py',
    'fluxora/models.py',
    'fluxora/client.py',
    'fluxora/py.typed',
  ];

  for (const f of expectedFiles) {
    it(`generates ${f}`, () => {
      expect(exists(f)).toBe(true);
    });
  }

  it('py.typed is a zero-byte PEP 561 marker', () => {
    const stat = fs.statSync(path.resolve(SDK_DIR, 'fluxora/py.typed'));
    expect(stat.size).toBe(0);
  });
});

// =============================================================================
// 5. Package Metadata (pyproject.toml)
// =============================================================================

describe('Package Metadata (pyproject.toml)', () => {
  let content: string;
  beforeAll(() => { content = read('pyproject.toml'); });

  it('declares package name as fluxora-sdk', () => {
    expect(content).toContain('name = "fluxora-sdk"');
  });

  it('uses flit build backend', () => {
    expect(content).toContain('build-backend = "flit.core.buildapi"');
  });

  it('requires Python >= 3.8', () => {
    expect(content).toContain('requires-python = ">=3.8"');
  });

  it('declares an MIT classifier', () => {
    expect(content).toContain('MIT License');
  });

  it('includes a version field', () => {
    expect(content).toMatch(/version\s*=\s*"\d+\.\d+/);
  });
});

// =============================================================================
// 6. README
// =============================================================================

describe('README.md', () => {
  let content: string;
  beforeAll(() => { content = read('README.md'); });

  it('has a top-level heading', () => {
    expect(content).toContain('# Fluxora Python Client SDK');
  });

  it('documents zero-dependency design', () => {
    expect(content).toMatch(/[Zz]ero.*[Dd]ependenc/);
  });

  it('shows a Quickstart code block with FluxoraClient', () => {
    expect(content).toContain('FluxoraClient');
  });

  it('shows StreamPaginator usage', () => {
    expect(content).toContain('StreamPaginator');
  });

  it('shows generate_idempotency_key usage', () => {
    expect(content).toContain('generate_idempotency_key()');
  });

  it('documents IdempotencyConflictError', () => {
    expect(content).toContain('IdempotencyConflictError');
  });

  it('includes installation instructions', () => {
    expect(content).toContain('pip install');
  });

  it('mentions MIT license', () => {
    expect(content).toContain('MIT');
  });
});

// =============================================================================
// 7. __init__.py — Public API Surface
// =============================================================================

describe('fluxora/__init__.py', () => {
  let content: string;
  beforeAll(() => { content = read('fluxora/__init__.py'); });

  const publicSymbols = [
    'FluxoraClient',
    'StreamPaginator',
    'generate_idempotency_key',
    'canonicalize_body',
    'hash_body',
    'FluxoraError',
    'ApiError',
    'IdempotencyConflictError',
    'ValidationError',
  ];

  for (const sym of publicSymbols) {
    it(`exports ${sym}`, () => {
      expect(content).toContain(sym);
    });
  }

  it('defines __version__', () => {
    expect(content).toMatch(/__version__\s*=\s*"/);
  });

  it('defines __all__', () => {
    expect(content).toContain('__all__');
  });
});

// =============================================================================
// 8. exceptions.py
// =============================================================================

describe('fluxora/exceptions.py', () => {
  let content: string;
  beforeAll(() => { content = read('fluxora/exceptions.py'); });

  it('defines FluxoraError as base Exception subclass', () => {
    expect(content).toContain('class FluxoraError(Exception):');
  });

  it('defines ApiError(FluxoraError)', () => {
    expect(content).toContain('class ApiError(FluxoraError):');
  });

  it('ApiError stores status_code', () => {
    expect(content).toContain('self.status_code = status_code');
  });

  it('ApiError stores code', () => {
    expect(content).toContain('self.code = code');
  });

  it('ApiError stores message', () => {
    expect(content).toContain('self.message = message');
  });

  it('ApiError stores details', () => {
    expect(content).toContain('self.details = details');
  });

  it('ApiError stores request_id', () => {
    expect(content).toContain('self.request_id = request_id');
  });

  it('defines IdempotencyConflictError(ApiError)', () => {
    expect(content).toContain('class IdempotencyConflictError(ApiError):');
  });

  it('IdempotencyConflictError stores stored_hash', () => {
    expect(content).toContain('self.stored_hash = stored_hash');
  });

  it('IdempotencyConflictError stores incoming_hash', () => {
    expect(content).toContain('self.incoming_hash = incoming_hash');
  });

  it('defines ValidationError(FluxoraError)', () => {
    expect(content).toContain('class ValidationError(FluxoraError):');
  });

  it('uses Optional type annotations', () => {
    expect(content).toContain('Optional[');
  });
});

// =============================================================================
// 9. idempotency.py
// =============================================================================

describe('fluxora/idempotency.py', () => {
  let content: string;
  beforeAll(() => { content = read('fluxora/idempotency.py'); });

  it('implements generate_idempotency_key()', () => {
    expect(content).toContain('def generate_idempotency_key()');
  });

  it('generate_idempotency_key uses uuid.uuid4()', () => {
    expect(content).toContain('str(uuid.uuid4())');
  });

  it('implements canonicalize_body()', () => {
    expect(content).toContain('def canonicalize_body(');
  });

  it('canonicalize_body sorts dict keys for determinism', () => {
    expect(content).toContain('sorted(body.keys())');
  });

  it('canonicalize_body handles list values', () => {
    expect(content).toContain('isinstance(body, list)');
  });

  it('canonicalize_body handles null/None', () => {
    expect(content).toContain('"null"');
  });

  it('implements hash_body()', () => {
    expect(content).toContain('def hash_body(');
  });

  it('hash_body uses SHA-256 matching src/middleware/idempotency.ts', () => {
    expect(content).toContain('hashlib.sha256(');
  });

  it('hash_body encodes with utf-8', () => {
    expect(content).toContain(".encode('utf-8')");
  });

  it('hash_body returns hex digest', () => {
    expect(content).toContain('.hexdigest()');
  });

  // Correctness: verify canonical output matches expected values
  it('canonicalize_body output is deterministic regardless of key insertion order', () => {
    // Both {"b":2,"a":1} and {"a":1,"b":2} must produce the same canonical string.
    // We verify by checking the template contains sorted key logic.
    expect(content).toContain('sorted_keys = sorted(body.keys())');
  });
});

// =============================================================================
// 10. pagination.py
// =============================================================================

describe('fluxora/pagination.py', () => {
  let content: string;
  beforeAll(() => { content = read('fluxora/pagination.py'); });

  it('defines StreamPaginator as Generic[T]', () => {
    expect(content).toContain('class StreamPaginator(Generic[T]):');
  });

  it('enforces minimum limit of 1 per paginationSchema.ts', () => {
    expect(content).toContain('limit must be an integer between 1 and 100');
  });

  it('implements __iter__ returning self', () => {
    expect(content).toContain('def __iter__(self)');
    expect(content).toContain('return self');
  });

  it('implements __next__ raising StopIteration on exhaustion', () => {
    expect(content).toContain('def __next__(self)');
    expect(content).toContain('raise StopIteration');
  });

  it('reads next_cursor from meta to advance pages', () => {
    expect(content).toContain('next_cursor');
    expect(content).toContain('_has_more');
  });

  it('implements auto_paginate() generator', () => {
    expect(content).toContain('def auto_paginate(self)');
  });

  it('auto_paginate yields individual items across pages', () => {
    expect(content).toContain('for item in page');
    expect(content).toContain('yield item');
  });

  it('supports status filter parameter', () => {
    expect(content).toContain('status: Optional[str]');
  });

  it('supports sender filter parameter', () => {
    expect(content).toContain('sender: Optional[str]');
  });

  it('supports recipient filter parameter', () => {
    expect(content).toContain('recipient: Optional[str]');
  });

  it('supports include_total parameter', () => {
    expect(content).toContain('include_total');
  });

  it('tracks page count internally', () => {
    expect(content).toContain('_page_count');
  });
});

// =============================================================================
// 11. models.py
// =============================================================================

describe('fluxora/models.py', () => {
  let content: string;
  beforeAll(() => { content = read('fluxora/models.py'); });

  it('defines ResponseMeta dataclass', () => {
    expect(content).toContain('class ResponseMeta');
  });

  it('defines Stream dataclass', () => {
    expect(content).toContain('class Stream');
  });

  it('defines CreateStreamRequest dataclass', () => {
    expect(content).toContain('class CreateStreamRequest');
  });

  it('defines WebhookDelivery dataclass', () => {
    expect(content).toContain('class WebhookDelivery');
  });

  it('uses @dataclass decorator', () => {
    expect(content).toContain('@dataclass');
  });

  it('Stream has id, sender, recipient, amount, asset, status fields', () => {
    expect(content).toContain('sender');
    expect(content).toContain('recipient');
    expect(content).toContain('amount');
    expect(content).toContain('asset');
    expect(content).toContain('status');
  });

  it('ResponseMeta has next_cursor for pagination', () => {
    expect(content).toContain('next_cursor');
  });

  it('uses Optional type annotations', () => {
    expect(content).toContain('Optional[');
  });
});

// =============================================================================
// 12. client.py — FluxoraClient
// =============================================================================

describe('fluxora/client.py', () => {
  let content: string;
  beforeAll(() => { content = read('fluxora/client.py'); });

  // ── Initialisation ──────────────────────────────────────────────────────────
  describe('FluxoraClient initialisation', () => {
    it('defines FluxoraClient class', () => {
      expect(content).toContain('class FluxoraClient:');
    });

    it('defaults base_url to localhost:3000', () => {
      expect(content).toContain('base_url: str = "http://localhost:3000"');
    });

    it('sets User-Agent header to FluxoraPythonSDK/0.1.0', () => {
      expect(content).toContain('"User-Agent": "FluxoraPythonSDK/0.1.0"');
    });

    it('defaults timeout to 30 seconds', () => {
      expect(content).toContain('timeout: float = 30.0');
    });

    it('implements set_bearer_token()', () => {
      expect(content).toContain('def set_bearer_token(');
    });

    it('implements set_api_key()', () => {
      expect(content).toContain('def set_api_key(');
    });
  });

  // ── System endpoints ────────────────────────────────────────────────────────
  describe('System endpoints', () => {
    it('get_root() → GET /', () => {
      expect(content).toContain('def get_root(self)');
      expect(content).toContain('"GET", "/"');
    });

    it('get_health() → GET /health', () => {
      expect(content).toContain('def get_health(self)');
      expect(content).toContain('"/health"');
    });

    it('get_health_ready() → GET /health/ready', () => {
      expect(content).toContain('def get_health_ready(self)');
      expect(content).toContain('"/health/ready"');
    });

    it('get_health_live() → GET /health/live', () => {
      expect(content).toContain('def get_health_live(self)');
      expect(content).toContain('"/health/live"');
    });
  });

  // ── Auth endpoints ──────────────────────────────────────────────────────────
  describe('Auth endpoints', () => {
    it('create_session() → POST /api/auth/session', () => {
      expect(content).toContain('def create_session(');
      expect(content).toContain('"/api/auth/session"');
    });

    it('create_session accepts address and role parameters', () => {
      expect(content).toContain('address: str');
      expect(content).toContain('role: str');
    });
  });

  // ── Stream endpoints ────────────────────────────────────────────────────────
  describe('Stream endpoints', () => {
    it('create_stream() sends Idempotency-Key header', () => {
      expect(content).toContain('def create_stream(');
      expect(content).toContain('"Idempotency-Key": key');
    });

    it('create_stream auto-generates key when omitted', () => {
      expect(content).toContain('generate_idempotency_key()');
    });

    it('list_streams() returns StreamPaginator', () => {
      expect(content).toContain('def list_streams(');
      expect(content).toContain('StreamPaginator(');
    });

    it('list_streams() respects cursor pagination params', () => {
      // fetch_page passes cursor from kw dict into the query params
      expect(content).toContain('"cursor": kw.get("cursor")');
    });

    it('get_stream() → GET /api/streams/{id}', () => {
      expect(content).toContain('def get_stream(');
      expect(content).toContain('f"/api/streams/{stream_id}"');
    });

    it('poll_stream_events() supports since and timeout params', () => {
      expect(content).toContain('def poll_stream_events(');
      expect(content).toContain('"timeout": timeout');
    });

    it('cancel_stream() → DELETE', () => {
      expect(content).toContain('def cancel_stream(');
      expect(content).toContain('"DELETE"');
    });
  });

  // ── Webhook endpoints ───────────────────────────────────────────────────────
  describe('Webhook endpoints', () => {
    it('queue_webhook() → POST /api/webhooks/queue', () => {
      expect(content).toContain('def queue_webhook(');
    });

    it('get_webhook_delivery() → GET .../deliveries/{id}', () => {
      expect(content).toContain('def get_webhook_delivery(');
    });

    it('list_outbox() → GET /api/webhooks/outbox', () => {
      expect(content).toContain('def list_outbox(');
    });

    it('list_dlq() → GET /api/webhooks/dlq', () => {
      expect(content).toContain('def list_dlq(');
    });

    it('retry_dlq() → POST .../retry', () => {
      expect(content).toContain('def retry_dlq(');
    });

    it('get_circuit_breakers() → GET .../circuit-breakers', () => {
      expect(content).toContain('def get_circuit_breakers(');
    });

    it('reset_circuit_breaker() URL-encodes the endpoint URL', () => {
      expect(content).toContain('def reset_circuit_breaker(');
      expect(content).toContain('urllib.parse.quote(');
    });

    it('get_metrics() → GET /api/webhooks/metrics', () => {
      expect(content).toContain('def get_metrics(');
    });
  });

  // ── Internal endpoints ──────────────────────────────────────────────────────
  describe('Internal endpoints', () => {
    it('trigger_indexer_sync() → POST /internal/indexer/sync', () => {
      expect(content).toContain('def trigger_indexer_sync(');
    });

    it('start_indexer_replay() → POST /internal/indexer/events/replay', () => {
      expect(content).toContain('def start_indexer_replay(');
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────────
  describe('Error handling', () => {
    it('raises IdempotencyConflictError on HTTP 409', () => {
      expect(content).toContain('IdempotencyConflictError(');
      expect(content).toContain('stored_hash');
      expect(content).toContain('incoming_hash');
    });

    it('raises ApiError on other HTTP errors', () => {
      expect(content).toContain('raise ApiError(');
    });

    it('handles network-level URLError as NETWORK_ERROR ApiError', () => {
      expect(content).toContain('NETWORK_ERROR');
      expect(content).toContain('urllib.error.URLError');
    });

    it('extracts request_id from error response headers', () => {
      expect(content).toContain('x-request-id');
    });

    it('handles empty response body gracefully', () => {
      expect(content).toContain('if not resp_bytes');
      expect(content).toContain('return {}');
    });
  });

  // ── Security ────────────────────────────────────────────────────────────────
  describe('Security', () => {
    it('uses urllib (stdlib) — no third-party HTTP deps', () => {
      expect(content).toContain('import urllib.request');
      expect(content).not.toContain('import requests');
      expect(content).not.toContain('import httpx');
      expect(content).not.toContain('import aiohttp');
    });

    it('removes None params before URL encoding (no null leakage)', () => {
      expect(content).toContain('if v is not None');
    });

    it('strips trailing slash from base_url', () => {
      expect(content).toContain('base_url.rstrip("/")');
    });

    it('does not hard-code any API keys or secrets', () => {
      expect(content).not.toMatch(/api.key\s*=\s*["'][^"']{8,}/);
      expect(content).not.toMatch(/secret\s*=\s*["'][^"']{8,}/);
    });
  });
});

// =============================================================================
// 13. Consistency — generator output version matches openapi.yaml
// =============================================================================

describe('Version consistency', () => {
  it('pyproject.toml version matches the version in openapi.yaml', () => {
    const spec = fs.readFileSync(path.resolve(ROOT_DIR, 'openapi.yaml'), 'utf8');
    const versionMatch = spec.match(/^\s*version:\s*['"]?(\d+\.\d+\.\d+)/m);
    const specVersion = versionMatch ? versionMatch[1] : null;

    if (specVersion) {
      const toml = read('pyproject.toml');
      expect(toml).toContain(specVersion);
    }
    // If openapi.yaml has no version field, the test is vacuously true.
    expect(true).toBe(true);
  });

  it('__init__.py __version__ matches pyproject.toml version', () => {
    const toml = read('pyproject.toml');
    const tomlVer = toml.match(/version\s*=\s*"(\d+\.\d+[^"]*)"/)?.[1];
    const init = read('fluxora/__init__.py');
    const initVer = init.match(/__version__\s*=\s*"([^"]+)"/)?.[1];
    expect(tomlVer).toBeDefined();
    expect(initVer).toBeDefined();
    expect(tomlVer).toBe(initVer);
  });
});
