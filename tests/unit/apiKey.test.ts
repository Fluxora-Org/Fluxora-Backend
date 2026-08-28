import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ApiKeyRecord, ApiKeyView } from '../../src/db/types.js';

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
  toApiKeyView,
  DEFAULT_SCOPES,
} from '../../src/lib/apiKey.js';

// ── Safe display field contract ──────────────────────────────────────────────
// These are the ONLY fields that may appear in a serialised API key view.
const SAFE_DISPLAY_FIELDS: Array<keyof ApiKeyView> = [
  'id', 'name', 'prefix', 'createdAt', 'rotatedAt', 'active', 'scopes',
];

// Fields that carry credential material and must NEVER appear in display output.
const FORBIDDEN_FIELDS = ['keyHash', 'salt', 'key'] as const;

function assertSafeView(view: Record<string, unknown>): void {
  for (const field of SAFE_DISPLAY_FIELDS) {
    expect(view, `safe field "${field}" must be present`).toHaveProperty(field);
  }
  for (const field of FORBIDDEN_FIELDS) {
    expect(view, `forbidden field "${field}" must NOT appear`).not.toHaveProperty(field);
  }
}

describe('src/lib/apiKey.ts unit tests', () => {
  beforeEach(() => {
    inMemoryKeys.clear();
  });

  afterEach(() => {
    inMemoryKeys.clear();
  });

  // ── dead code removal ──────────────────────────────────────────────────

  describe('dead code removal', () => {
    it('does not export getApiKeyScopes, hasScope, or _resetApiKeyStoreForTest', () => {
      expect((apiKeyModule as any).getApiKeyScopes).toBeUndefined();
      expect((apiKeyModule as any).hasScope).toBeUndefined();
      expect((apiKeyModule as any)._resetApiKeyStoreForTest).toBeUndefined();
    });
  });

  // ── findRecordByRawKey / getApiKeyRecord aliasing (issue #1063) ────────

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

  // ── toApiKeyView — safe display projection ─────────────────────────────

  describe('toApiKeyView', () => {
    it('is exported from src/lib/apiKey.ts', () => {
      expect(typeof toApiKeyView).toBe('function');
    });

    it('strips keyHash and salt from a full ApiKeyRecord', () => {
      const record: ApiKeyRecord = {
        id: 'test-id',
        name: 'test-key',
        keyHash: 'deadbeef',
        salt: 'cafebabe',
        prefix: 'flx_test',
        createdAt: new Date().toISOString(),
        rotatedAt: null,
        active: true,
        scopes: ['streams:read'],
      };

      const view = toApiKeyView(record) as unknown as Record<string, unknown>;
      assertSafeView(view);
    });

    it('preserves all safe display fields faithfully', () => {
      const now = new Date().toISOString();
      const record: ApiKeyRecord = {
        id: 'abc123',
        name: 'my-service',
        keyHash: 'secret-hash',
        salt: 'secret-salt',
        prefix: 'flx_abcd',
        createdAt: now,
        rotatedAt: null,
        active: true,
        scopes: ['streams:read', 'streams:write'],
      };

      const view = toApiKeyView(record);
      expect(view.id).toBe('abc123');
      expect(view.name).toBe('my-service');
      expect(view.prefix).toBe('flx_abcd');
      expect(view.createdAt).toBe(now);
      expect(view.rotatedAt).toBeNull();
      expect(view.active).toBe(true);
      expect(view.scopes).toEqual(['streams:read', 'streams:write']);
    });

    it('passes through rotatedAt when set', () => {
      const rotatedAt = new Date().toISOString();
      const record: ApiKeyRecord = {
        id: 'r1',
        name: 'rotated-key',
        keyHash: 'hash',
        salt: 'salt',
        prefix: 'flx_rota',
        createdAt: new Date().toISOString(),
        rotatedAt,
        active: true,
        scopes: [],
      };

      expect(toApiKeyView(record).rotatedAt).toBe(rotatedAt);
    });

    it('passes through active=false for revoked keys', () => {
      const record: ApiKeyRecord = {
        id: 'rev1',
        name: 'revoked',
        keyHash: 'hash',
        salt: 'salt',
        prefix: 'flx_rev1',
        createdAt: new Date().toISOString(),
        rotatedAt: null,
        active: false,
        scopes: [],
      };

      expect(toApiKeyView(record).active).toBe(false);
    });

    it('the returned object has exactly the safe display fields — no extras', () => {
      const record: ApiKeyRecord = {
        id: 'e1',
        name: 'exact',
        keyHash: 'h',
        salt: 's',
        prefix: 'flx_exac',
        createdAt: new Date().toISOString(),
        rotatedAt: null,
        active: true,
        scopes: [],
      };

      const view = toApiKeyView(record);
      const keys = Object.keys(view).sort();
      const expected = [...SAFE_DISPLAY_FIELDS].sort();
      expect(keys).toEqual(expected);
    });
  });

  // ── listApiKeys — returns ApiKeyView[] ────────────────────────────────

  describe('listApiKeys — safe display projection', () => {
    it('returns an empty array when no keys exist', async () => {
      const list = await listApiKeys();
      expect(list).toEqual([]);
    });

    it('returns all stored keys', async () => {
      await createApiKey('k1');
      await createApiKey('k2');

      const list = await listApiKeys();
      expect(list).toHaveLength(2);
    });

    it('each item in the list exposes only safe display fields (no keyHash, no salt)', async () => {
      await createApiKey('k1');
      await createApiKey('k2');

      const list = await listApiKeys();
      for (const item of list as unknown as Record<string, unknown>[]) {
        assertSafeView(item);
      }
    });

    it('listApiKeys result does not contain keyHash even if the repository returns it', async () => {
      // The repository fake puts the full ApiKeyRecord (including keyHash/salt)
      // into the store. listApiKeys must project it away before returning.
      await createApiKey('hash-leak-check');

      const list = await listApiKeys();
      expect(list).toHaveLength(1);
      expect((list[0] as unknown as Record<string, unknown>)).not.toHaveProperty('keyHash');
      expect((list[0] as unknown as Record<string, unknown>)).not.toHaveProperty('salt');
    });

    it('revoked keys appear in the list with active=false and no credential leakage', async () => {
      const created = await createApiKey('revocable');
      await revokeApiKey(created.id);

      const list = await listApiKeys();
      expect(list).toHaveLength(1);
      expect(list[0].active).toBe(false);
      assertSafeView(list[0] as unknown as Record<string, unknown>);
    });

    it('rotated keys appear in the list with updated prefix and no credential leakage', async () => {
      const created = await createApiKey('rotatable');
      const rotated = await rotateApiKey(created.id);

      const list = await listApiKeys();
      expect(list).toHaveLength(1);
      // Prefix must reflect the rotated key's prefix.
      expect(list[0].prefix).toBe(rotated.prefix);
      assertSafeView(list[0] as unknown as Record<string, unknown>);
    });
  });

  // ── getApiKeyRecord ────────────────────────────────────────────────────

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

  // ── isValidApiKey ──────────────────────────────────────────────────────

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

  // ── createApiKey ───────────────────────────────────────────────────────

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

    it('creation result does not contain keyHash or salt', async () => {
      const created = await createApiKey('secret-check') as unknown as Record<string, unknown>;
      expect(created).not.toHaveProperty('keyHash');
      expect(created).not.toHaveProperty('salt');
    });
  });

  // ── rotateApiKey ───────────────────────────────────────────────────────

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

    it('rotation result does not contain keyHash or salt', async () => {
      const created = await createApiKey('rotate-secret-check');
      const rotated = await rotateApiKey(created.id) as unknown as Record<string, unknown>;
      expect(rotated).not.toHaveProperty('keyHash');
      expect(rotated).not.toHaveProperty('salt');
    });
  });

  // ── revokeApiKey ───────────────────────────────────────────────────────

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

  // ── getApiKeyFromRequest ───────────────────────────────────────────────

  describe('getApiKeyFromRequest', () => {
    it('extracts key from lower or upper case header and array headers', () => {
      expect(getApiKeyFromRequest({ 'x-api-key': 'key-1' })).toBe('key-1');
      expect(getApiKeyFromRequest({ 'X-API-Key': 'key-2' })).toBe('key-2');
      expect(getApiKeyFromRequest({ 'x-api-key': ['key-3', 'key-4'] })).toBe('key-3');
      expect(getApiKeyFromRequest({})).toBeUndefined();
    });
  });
});
