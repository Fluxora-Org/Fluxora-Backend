/**
 * Tests for API key scope enforcement & getApiKeyRecord.
 * 
 * Covers:
 * - API key creation with custom scopes
 * - Backward compatibility with default scopes
 * - Scope validation on protected routes
 * - Missing/insufficient scope errors
 * - API key revocation
 * - getApiKeyRecord async lookup and dead code removal regression tests
 */

import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initializeConfig } from '../../src/config/env.js';
import { generateToken } from '../../src/lib/auth.js';
import type { ApiKeyRecord } from '../../src/db/types.js';

// Deliberately does NOT mock '../../src/config/env.js': app.ts's createApp()
// needs the real loadConfig() (not just getConfig()) to build a working
// Express app, and tests/setup.ts already seeds API_KEY_PEPPER and friends
// for every test process. A partial mock here previously replaced the whole
// module and broke `loadConfig`, which silently took this entire suite
// offline (see issue #1063).
const inMemoryKeys = new Map<string, ApiKeyRecord>();

vi.mock('../../src/db/repositories/apiKeyRepository.js', () => ({
  apiKeyRepository: {
    insert: vi.fn(async (record: ApiKeyRecord) => {
      inMemoryKeys.set(record.id, record);
    }),
    findActiveByPrefix: vi.fn(async (prefix: string) => {
      return Array.from(inMemoryKeys.values()).filter(
        (k) => k.prefix === prefix && k.active,
      );
    }),
    getById: vi.fn(async (id: string) => {
      return inMemoryKeys.get(id);
    }),
    rotate: vi.fn(),
    revoke: vi.fn(async (id: string) => {
      const existing = inMemoryKeys.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, active: false };
      inMemoryKeys.set(id, updated);
      return updated;
    }),
    listAll: vi.fn(async () => Array.from(inMemoryKeys.values())),
  },
}));

vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEventToDb: vi.fn(async () => {}),
}));

import app from '../../src/app.js';
import * as apiKeyModule from '../../src/lib/apiKey.js';
import {
  createApiKey,
  getApiKeyRecord,
  revokeApiKey,
  DEFAULT_SCOPES,
} from '../../src/lib/apiKey.js';

describe('API Key Scopes & getApiKeyRecord', () => {
  beforeAll(() => {
    // createApiKey()/isValidApiKey() read the API_KEY_PEPPER via getConfig(),
    // which requires the singleton config to have been initialized once per
    // test file (tests/setup.ts seeds the env var, but does not itself call
    // initializeConfig()).
    initializeConfig();
  });

  beforeEach(() => {
    inMemoryKeys.clear();
  });

  afterEach(() => {
    inMemoryKeys.clear();
  });

  describe('Regression - Dead code removal', () => {
    it('should not export dead functions (getApiKeyScopes, hasScope, _resetApiKeyStoreForTest)', () => {
      expect((apiKeyModule as any).getApiKeyScopes).toBeUndefined();
      expect((apiKeyModule as any).hasScope).toBeUndefined();
      expect((apiKeyModule as any)._resetApiKeyStoreForTest).toBeUndefined();
    });
  });

  describe('getApiKeyRecord', () => {
    it('should return record including scopes for a valid key', async () => {
      const created = await createApiKey('record-test', ['streams:read', 'admin:reindex']);
      const record = await getApiKeyRecord(created.key);

      expect(record).toBeDefined();
      expect(record?.id).toBe(created.id);
      expect(record?.name).toBe('record-test');
      expect(record?.scopes).toEqual(['streams:read', 'admin:reindex']);
    });

    it('should return undefined for non-existent raw key', async () => {
      const record = await getApiKeyRecord('flx_nonexistent_key_1234567890');
      expect(record).toBeUndefined();
    });

    it('should return undefined for empty or invalid raw key input', async () => {
      expect(await getApiKeyRecord('')).toBeUndefined();
      expect(await getApiKeyRecord(null as any)).toBeUndefined();
      expect(await getApiKeyRecord(undefined as any)).toBeUndefined();
    });

    it('should not return revoked keys', async () => {
      const created = await createApiKey('revoked-test');
      await revokeApiKey(created.id);

      const record = await getApiKeyRecord(created.key);
      expect(record).toBeUndefined();
    });
  });

  describe('createApiKey with scopes', () => {
    it('should create a key with default scopes if none provided', async () => {
      const result = await createApiKey('test-key');
      expect(result.key).toBeDefined();
      expect(result.key).toMatch(/^flx_/);
    });

    it('should create a key with custom scopes', async () => {
      const result = await createApiKey('read-only-key', ['streams:read']);
      expect(result.key).toBeDefined();
      expect(result.id).toBeDefined();

      const record = await getApiKeyRecord(result.key);
      expect(record?.scopes).toEqual(['streams:read']);
    });

    it('should fall back to default scopes for empty scope array', async () => {
      const result = await createApiKey('test-key', []);
      expect(result.key).toBeDefined();
      const record = await getApiKeyRecord(result.key);
      expect(record?.scopes).toEqual(DEFAULT_SCOPES);
    });
  });

  describe('GET /api/streams with API key', () => {
    it('should allow request with valid API key with streams:read scope', async () => {
      const apiKey = await createApiKey('read-key', ['streams:read']);
      
      const response = await request(app)
        .get('/api/streams')
        .set('X-API-Key', apiKey.key)
        .query({ limit: 10 });

      expect(response.status).not.toBe(403);
    });

    it('should deny request with API key missing streams:read scope', async () => {
      const apiKey = await createApiKey('write-only-key', ['streams:write']);
      
      const response = await request(app)
        .get('/api/streams')
        .set('X-API-Key', apiKey.key)
        .query({ limit: 10 });

      expect(response.status).toBe(403);
      expect(response.body.error?.code).toBe('FORBIDDEN');
      expect(response.body.error?.message).toContain('scopes');
    });

    it('should deny a fully anonymous request (no API key, no JWT)', async () => {
      // requireScope() rejects before any controller logic runs when neither
      // an API key (`req.keyId`) nor a JWT (`req.user`) principal is present
      // — scoped routes never fall open to anonymous callers.
      const response = await request(app)
        .get('/api/streams')
        .query({ limit: 10 });

      expect(response.status).toBe(401);
      expect(response.body.error?.code).toBe('UNAUTHORIZED');
    });

    it('should deny request with invalid API key', async () => {
      const response = await request(app)
        .get('/api/streams')
        .set('X-API-Key', 'flx_invalid_key_that_does_not_exist')
        .query({ limit: 10 });

      expect(response.status).toBe(401);
      expect(response.body.error?.code).toBe('UNAUTHORIZED');
    });
  });

  describe('POST /api/streams with API key', () => {
    it('should deny request with API key missing streams:write scope', async () => {
      // POST is gated by both `requireAuth` (a JWT principal) and
      // `requireScope('streams:write')`. Attach an operator JWT so the
      // request clears `requireAuth` and actually reaches the scope check —
      // requireScope() prefers API-key scopes over JWT permissions once a
      // key is present, so the read-only key is what triggers the 403 here.
      const jwt = generateToken({ address: 'GOPERATOR000000000000000000000000000000000000', role: 'operator' });
      const apiKey = await createApiKey('read-only-key', ['streams:read']);

      const response = await request(app)
        .post('/api/streams')
        .set('Authorization', `Bearer ${jwt}`)
        .set('X-API-Key', apiKey.key)
        .set('Idempotency-Key', 'test-key-1')
        .send({
          sender: 'GAAAA...',
          recipient: 'GBBBB...',
          amount: '1000.00',
          rate_per_second: '10.50',
          start_time: Math.floor(Date.now() / 1000),
          end_time: Math.floor(Date.now() / 1000) + 86400,
        });

      expect(response.status).toBe(403);
      expect(response.body.error?.code).toBe('FORBIDDEN');
      expect(response.body.error?.message).toContain('scopes');
    });

    it('should allow request with API key having streams:write scope', async () => {
      const apiKey = await createApiKey('write-key', ['streams:write']);
      
      const response = await request(app)
        .post('/api/streams')
        .set('X-API-Key', apiKey.key)
        .set('Idempotency-Key', 'test-key-2')
        .send({
          sender: 'GAAAA...',
          recipient: 'GBBBB...',
          amount: '1000.00',
          rate_per_second: '10.50',
          start_time: Math.floor(Date.now() / 1000),
          end_time: Math.floor(Date.now() / 1000) + 86400,
        });

      expect(response.status).not.toBe(403);
    });
  });

  describe('DELETE /api/streams/:id with API key', () => {
    it('should deny request with API key missing streams:write scope', async () => {
      // Same reasoning as the POST case above: DELETE also requires
      // `requireAuth`, so a JWT is needed to reach the scope check at all.
      const jwt = generateToken({ address: 'GOPERATOR000000000000000000000000000000000000', role: 'operator' });
      const apiKey = await createApiKey('read-only-key', ['streams:read']);

      const response = await request(app)
        .delete('/api/streams/stream-123')
        .set('Authorization', `Bearer ${jwt}`)
        .set('X-API-Key', apiKey.key);

      expect(response.status).toBe(403);
      expect(response.body.error?.code).toBe('FORBIDDEN');
    });

    it('should allow request with API key having streams:write scope', async () => {
      const apiKey = await createApiKey('write-key', ['streams:write']);
      
      const response = await request(app)
        .delete('/api/streams/stream-123')
        .set('X-API-Key', apiKey.key);

      expect(response.status).not.toBe(403);
    });
  });

  describe('GET /api/streams/:id/events with API key', () => {
    it('should deny request with API key missing streams:read scope', async () => {
      const apiKey = await createApiKey('write-only-key', ['streams:write']);
      
      const response = await request(app)
        .get('/api/streams/stream-123/events')
        .set('X-API-Key', apiKey.key);

      expect(response.status).toBe(403);
      expect(response.body.error?.code).toBe('FORBIDDEN');
    });
  });

  describe('scope validation edge cases', () => {
    it('should handle API key with multiple scopes', async () => {
      const apiKey = await createApiKey('multi-scope-key', [
        'streams:read',
        'streams:write',
        'admin:pause',
      ]);
      
      const readResponse = await request(app)
        .get('/api/streams')
        .set('X-API-Key', apiKey.key)
        .query({ limit: 10 });

      expect(readResponse.status).not.toBe(403);
    });

    it('should require at least one matching scope', async () => {
      const apiKey = await createApiKey('write-key', ['streams:write']);
      
      const response = await request(app)
        .get('/api/streams')
        .set('X-API-Key', apiKey.key)
        .query({ limit: 10 });

      expect(response.status).toBe(403);
    });
  });

  describe('backward compatibility', () => {
    it('should default to DEFAULT_SCOPES for keys created without explicit scopes', () => {
      expect(DEFAULT_SCOPES).toContain('streams:read');
      expect(DEFAULT_SCOPES).toContain('streams:write');
    });

    it('should allow full access with default scopes', async () => {
      const apiKey = await createApiKey('default-scope-key');
      
      const readResponse = await request(app)
        .get('/api/streams')
        .set('X-API-Key', apiKey.key)
        .query({ limit: 10 });

      expect(readResponse.status).not.toBe(403);
    });
  });
});
