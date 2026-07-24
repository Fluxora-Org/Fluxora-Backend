import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT_DIR = process.cwd();
const SDK_DIR = path.resolve(ROOT_DIR, 'sdk/python');
const SCRIPT_PATH = path.resolve(ROOT_DIR, 'scripts/generate-sdk-python.mjs');

describe('Python Client SDK Generator (scripts/generate-sdk-python.mjs)', () => {
  beforeAll(() => {
    // Ensure SDK is freshly generated before testing
    execSync(`node "${SCRIPT_PATH}"`, { stdio: 'pipe' });
  });

  describe('Generator CLI & Drift Check', () => {
    it('passes drift check (--check) when files match freshly generated output', () => {
      const output = execSync(`node "${SCRIPT_PATH}" --check`, { encoding: 'utf8' });
      expect(output).toContain('[DRIFT CHECK PASSED]');
    });

    it('fails drift check (--check) when a generated file is altered', () => {
      const targetFile = path.resolve(SDK_DIR, 'fluxora/exceptions.py');
      const originalContent = fs.readFileSync(targetFile, 'utf8');

      try {
        // Temporarily append a comment to trigger drift
        fs.writeFileSync(targetFile, `${originalContent}\n# Temp drift comment`, 'utf8');

        expect(() => {
          execSync(`node "${SCRIPT_PATH}" --check`, { encoding: 'utf8', stdio: 'pipe' });
        }).toThrow();
      } finally {
        // Restore original content
        fs.writeFileSync(targetFile, originalContent, 'utf8');
      }
    });

    it('fails drift check (--check) when a required file is missing', () => {
      const tempDir = path.resolve(ROOT_DIR, 'tmp_test_sdk_missing');
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        expect(() => {
          execSync(`node "${SCRIPT_PATH}" --check --out-dir "${tempDir}"`, { encoding: 'utf8', stdio: 'pipe' });
        }).toThrow();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('supports custom output directory (--out-dir)', () => {
      const customDir = path.resolve(ROOT_DIR, 'tmp_test_sdk_custom');
      try {
        execSync(`node "${SCRIPT_PATH}" --out-dir "${customDir}"`, { encoding: 'utf8' });
        expect(fs.existsSync(path.resolve(customDir, 'pyproject.toml'))).toBe(true);
        expect(fs.existsSync(path.resolve(customDir, 'fluxora/client.py'))).toBe(true);
      } finally {
        fs.rmSync(customDir, { recursive: true, force: true });
      }
    });
  });

  describe('SDK File Structure & Package Metadata', () => {
    it('generates all expected Python package files', () => {
      const expectedFiles = [
        'pyproject.toml',
        'README.md',
        'fluxora/__init__.py',
        'fluxora/exceptions.py',
        'fluxora/idempotency.py',
        'fluxora/pagination.py',
        'fluxora/models.py',
        'fluxora/client.py',
      ];

      for (const relativePath of expectedFiles) {
        const fullPath = path.resolve(SDK_DIR, relativePath);
        expect(fs.existsSync(fullPath), `Missing generated file: ${relativePath}`).toBe(true);
      }
    });

    it('generates valid pyproject.toml package metadata', () => {
      const content = fs.readFileSync(path.resolve(SDK_DIR, 'pyproject.toml'), 'utf8');
      expect(content).toContain('name = "fluxora-sdk"');
      expect(content).toContain('build-backend = "flit.core.buildapi"');
      expect(content).toContain('requires-python = ">=3.8"');
    });

    it('generates comprehensive README.md documentation', () => {
      const content = fs.readFileSync(path.resolve(SDK_DIR, 'README.md'), 'utf8');
      expect(content).toContain('# Fluxora Python Client SDK');
      expect(content).toContain('StreamPaginator');
      expect(content).toContain('IdempotencyConflictError');
      expect(content).toContain('generate_idempotency_key()');
    });
  });

  describe('Python Client Implementation (fluxora/client.py)', () => {
    let clientContent: string;

    beforeAll(() => {
      clientContent = fs.readFileSync(path.resolve(SDK_DIR, 'fluxora/client.py'), 'utf8');
    });

    it('defines FluxoraClient class with proper initialization defaults', () => {
      expect(clientContent).toContain('class FluxoraClient:');
      expect(clientContent).toContain('def __init__(');
      expect(clientContent).toContain('base_url: str = "http://localhost:3000"');
      expect(clientContent).toContain('User-Agent": "FluxoraPythonSDK/0.1.0"');
    });

    it('implements System endpoints', () => {
      expect(clientContent).toContain('def get_root(self)');
      expect(clientContent).toContain('def get_health(self)');
      expect(clientContent).toContain('def get_health_ready(self)');
      expect(clientContent).toContain('def get_health_live(self)');
    });

    it('implements Auth endpoints', () => {
      expect(clientContent).toContain('def create_session(');
      expect(clientContent).toContain('def set_bearer_token(');
    });

    it('implements Stream endpoints with Idempotency-Key header support', () => {
      expect(clientContent).toContain('def create_stream(');
      expect(clientContent).toContain('"Idempotency-Key": key');
      expect(clientContent).toContain('def list_streams(');
      expect(clientContent).toContain('def get_stream(');
      expect(clientContent).toContain('def poll_stream_events(');
      expect(clientContent).toContain('def cancel_stream(');
    });

    it('implements Webhook endpoints', () => {
      expect(clientContent).toContain('def queue_webhook(');
      expect(clientContent).toContain('def get_webhook_delivery(');
      expect(clientContent).toContain('def list_outbox(');
      expect(clientContent).toContain('def list_dlq(');
      expect(clientContent).toContain('def retry_dlq(');
      expect(clientContent).toContain('def get_circuit_breakers(');
      expect(clientContent).toContain('def reset_circuit_breaker(');
      expect(clientContent).toContain('def get_metrics(');
    });

    it('implements Internal endpoints', () => {
      expect(clientContent).toContain('def trigger_indexer_sync(');
      expect(clientContent).toContain('def start_indexer_replay(');
    });

    it('handles HTTP 409 Idempotency Conflict responses', () => {
      expect(clientContent).toContain('IdempotencyConflictError(');
      expect(clientContent).toContain('stored_hash');
      expect(clientContent).toContain('incoming_hash');
    });
  });

  describe('Exceptions & Error Handling (fluxora/exceptions.py)', () => {
    let exceptionsContent: string;

    beforeAll(() => {
      exceptionsContent = fs.readFileSync(path.resolve(SDK_DIR, 'fluxora/exceptions.py'), 'utf8');
    });

    it('defines base FluxoraError', () => {
      expect(exceptionsContent).toContain('class FluxoraError(Exception):');
    });

    it('defines ApiError with status_code, code, message, details, and request_id', () => {
      expect(exceptionsContent).toContain('class ApiError(FluxoraError):');
      expect(exceptionsContent).toContain('self.status_code = status_code');
      expect(exceptionsContent).toContain('self.code = code');
      expect(exceptionsContent).toContain('self.message = message');
      expect(exceptionsContent).toContain('self.details = details');
      expect(exceptionsContent).toContain('self.request_id = request_id');
    });

    it('defines IdempotencyConflictError inheriting from ApiError', () => {
      expect(exceptionsContent).toContain('class IdempotencyConflictError(ApiError):');
      expect(exceptionsContent).toContain('self.stored_hash = stored_hash');
      expect(exceptionsContent).toContain('self.incoming_hash = incoming_hash');
    });

    it('defines ValidationError', () => {
      expect(exceptionsContent).toContain('class ValidationError(FluxoraError):');
    });
  });

  describe('Idempotency Utilities (fluxora/idempotency.py)', () => {
    let idempotencyContent: string;

    beforeAll(() => {
      idempotencyContent = fs.readFileSync(path.resolve(SDK_DIR, 'fluxora/idempotency.py'), 'utf8');
    });

    it('implements UUID v4 generator', () => {
      expect(idempotencyContent).toContain('def generate_idempotency_key()');
      expect(idempotencyContent).toContain('str(uuid.uuid4())');
    });

    it('implements recursive JSON body canonicalization matching src/middleware/idempotency.ts', () => {
      expect(idempotencyContent).toContain('def canonicalize_body(');
      expect(idempotencyContent).toContain('sorted_keys = sorted(body.keys())');
    });

    it('implements SHA-256 body hashing matching src/middleware/idempotency.ts', () => {
      expect(idempotencyContent).toContain('def hash_body(');
      expect(idempotencyContent).toContain('hashlib.sha256(');
    });
  });

  describe('Pagination Semantics (fluxora/pagination.py)', () => {
    let paginationContent: string;

    beforeAll(() => {
      paginationContent = fs.readFileSync(path.resolve(SDK_DIR, 'fluxora/pagination.py'), 'utf8');
    });

    it('implements StreamPaginator matching paginationSchema.ts', () => {
      expect(paginationContent).toContain('class StreamPaginator(');
      expect(paginationContent).toContain('limit must be an integer between 1 and 100');
      expect(paginationContent).toContain('def __next__(self)');
      expect(paginationContent).toContain('def auto_paginate(self)');
    });
  });
});
