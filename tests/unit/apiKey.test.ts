import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ApiKeyRecord } from '../../src/db/types.js';

vi.mock('../../src/config/env.js', () => ({
  getConfig: () => ({
    apiKeyPepper: 'test-pepper-32-chars-long-secret-key-pepper!',
  }),
}));

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
    rotate: vi.fn(async (id: string, patch: any) => {
      const existing = inMemoryKeys.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch };
      inMemoryKeys.set(id, updated);
      return updated;
    }),
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

import * as apiKeyModule from '../../src/lib/apiKey.js';
import {
  createApiKey,
  rotateApiKey,
  revokeApiKey,
  listApiKeys,
  getApiKeyRecord,
  findRecordByRawKey,
  isValidApiKey,
  getApiKeyFromRequest,
  DEFAULT_SCOPES,
} from '../../src/lib/apiKey.js';

describe('src/lib/apiKey.ts unit tests', () => {
  beforeEach(() => {
    inMemoryKeys.clear();
  });

  afterEach(() => {
    inMemoryKeys.clear();
  });

  describe('dead code removal', () => {
    it('does not export getApiKeyScopes, hasScope, or _resetApiKeyStoreForTest', () => {
      expect((apiKeyModule as any).getApiKeyScopes).toBeUndefined();
      expect((apiKeyModule as any).hasScope).toBeUndefined();
      expect((apiKeyModule as any)._resetApiKeyStoreForTest).toBeUndefined();
    });
  });

  // Regression coverage for issue #1063: `src/middleware/auth.ts` imports
  // `findRecordByRawKey`, while other callers/tests still use the older
  // `getApiKeyRecord` name. Both names must resolve to the exact same
  // repository-boundary lookup so the two call sites can never drift apart
  // again the way they did when this broke (import said one name, the call
  // site referenced the other, and neither was actually exported).
  describe('findRecordByRawKey / getApiKeyRecord aliasing (issue #1063)', () => {
    it('exports findRecordByRawKey as a function', () => {
      expect(typeof findRecordByRawKey).toBe('function');
    });

    it('getApiKeyRecord is the exact same function reference as findRecordByRawKey', () => {
      expect(getApiKeyRecord).toBe(findRecordByRawKey);
    });

    it('both names resolve an active key to an identical record', async () => {
      const created = await createApiKey('alias-check', ['streams:read']);

      const viaOldName = await getApiKeyRecord(created.key);
      const viaNewName = await findRecordByRawKey(created.key);

      expect(viaOldName).toEqual(viaNewName);
      expect(viaOldName?.id).toBe(created.id);
    });
  });

  describe('getApiKeyRecord', () => {
    it('returns ApiKeyRecord for valid raw key', async () => {
      const created = await createApiKey('service-1', ['streams:read', 'admin:reindex']);
      const record = await getApiKeyRecord(created.key);

      expect(record).toBeDefined();
      expect(record?.id).toBe(created.id);
      expect(record?.name).toBe('service-1');
      expect(record?.scopes).toEqual(['streams:read', 'admin:reindex']);
    });

    it('returns undefined for non-existent raw key', async () => {
      const record = await getApiKeyRecord('flx_nonexistent_1234567890');
      expect(record).toBeUndefined();
    });

    it('returns undefined for empty/invalid inputs', async () => {
      expect(await getApiKeyRecord('')).toBeUndefined();
      expect(await getApiKeyRecord(null as any)).toBeUndefined();
      expect(await getApiKeyRecord(undefined as any)).toBeUndefined();
    });

    it('returns undefined for revoked key', async () => {
      const created = await createApiKey('revoked-key');
      await revokeApiKey(created.id);

      const record = await getApiKeyRecord(created.key);
      expect(record).toBeUndefined();
    });
  });

  describe('isValidApiKey', () => {
    it('validates active API keys correctly', async () => {
      const created = await createApiKey('valid-key');
      expect(await isValidApiKey(created.key)).toBe(true);
      expect(await isValidApiKey('flx_invalid_key')).toBe(false);
    });

    it('returns false for empty or non-string inputs', async () => {
      expect(await isValidApiKey('')).toBe(false);
      expect(await isValidApiKey(null as any)).toBe(false);
      expect(await isValidApiKey(undefined as any)).toBe(false);
    });
  });

  describe('createApiKey', () => {
    it('defaults scopes when none provided', async () => {
      const created = await createApiKey('default-scopes-key');
      const record = await getApiKeyRecord(created.key);
      expect(record?.scopes).toEqual(DEFAULT_SCOPES);
    });

    it('throws when name is missing or invalid', async () => {
      await expect(createApiKey('')).rejects.toThrow('name is required');
      await expect(createApiKey('   ')).rejects.toThrow('name is required');
      await expect(createApiKey(null as any)).rejects.toThrow('name is required');
    });
  });

  describe('rotateApiKey', () => {
    it('rotates existing active key', async () => {
      const created = await createApiKey('rotate-test', ['streams:read']);
      const rotated = await rotateApiKey(created.id);

      expect(rotated.id).toBe(created.id);
      expect(rotated.key).not.toBe(created.key);

      expect(await isValidApiKey(created.key)).toBe(false);
      expect(await isValidApiKey(rotated.key)).toBe(true);
    });

    it('throws error for non-existent or revoked key', async () => {
      await expect(rotateApiKey('non-existent-id')).rejects.toThrow('API key not found');

      const created = await createApiKey('key-to-revoke');
      await revokeApiKey(created.id);
      await expect(rotateApiKey(created.id)).rejects.toThrow('API key is revoked');
    });
  });

  describe('revokeApiKey', () => {
    it('revokes an existing key', async () => {
      const created = await createApiKey('to-revoke');
      await revokeApiKey(created.id);
      expect(await isValidApiKey(created.key)).toBe(false);
    });

    it('throws for non-existent key', async () => {
      await expect(revokeApiKey('bad-id')).rejects.toThrow('API key not found');
    });
  });

  describe('listApiKeys', () => {
    it('lists all stored keys', async () => {
      await createApiKey('k1');
      await createApiKey('k2');

      const list = await listApiKeys();
      expect(list).toHaveLength(2);
    });
  });

  describe('getApiKeyFromRequest', () => {
    it('extracts key from lower or upper case header and array headers', () => {
      expect(getApiKeyFromRequest({ 'x-api-key': 'key-1' })).toBe('key-1');
      expect(getApiKeyFromRequest({ 'X-API-Key': 'key-2' })).toBe('key-2');
      expect(getApiKeyFromRequest({ 'x-api-key': ['key-3', 'key-4'] })).toBe('key-3');
      expect(getApiKeyFromRequest({})).toBeUndefined();
    });
  });
});
