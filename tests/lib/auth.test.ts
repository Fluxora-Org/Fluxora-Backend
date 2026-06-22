import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { generateToken, verifyToken, UserPayload } from '../../src/lib/auth.js';
import { initializeConfig } from '../../src/config/env.js';
import type { ApiKeyRecord, ApiKeyStoredRecord } from '../../src/db/types.js';
import type { ApiKeyStore } from '../../src/lib/apiKey.js';
import {
  createApiKey,
  rotateApiKey,
  revokeApiKey,
  listApiKeys,
  isValidApiKey,
  _resetApiKeyStoreForTest,
  hashApiKeyLookupPrefix,
  setApiKeyStoreForTest,
} from '../../src/lib/apiKey.js';

function publicRecord(record: ApiKeyStoredRecord): ApiKeyRecord {
  return {
    id: record.id,
    name: record.name,
    keyHash: record.keyHash,
    prefix: record.prefix,
    createdAt: record.createdAt,
    rotatedAt: record.rotatedAt,
    revokedAt: record.revokedAt,
    active: record.active,
  };
}

function createMemoryApiKeyStore(): ApiKeyStore & { records: Map<string, ApiKeyStoredRecord> } {
  const records = new Map<string, ApiKeyStoredRecord>();
  return {
    records,
    async create(input) {
      const record: ApiKeyStoredRecord = { ...input, revokedAt: null, active: true };
      records.set(record.id, record);
      return publicRecord(record);
    },
    async findById(id) {
      const record = records.get(id);
      return record ? publicRecord(record) : undefined;
    },
    async findActiveByLookupHash(lookupHash) {
      return [...records.values()].filter((record) => record.active && record.lookupHash === lookupHash);
    },
    async list() {
      return [...records.values()].map(publicRecord);
    },
    async rotate(id, input) {
      const current = records.get(id);
      if (!current || !current.active) return undefined;
      const next = { ...current, ...input };
      records.set(id, next);
      return publicRecord(next);
    },
    async revoke(id, revokedAt) {
      const current = records.get(id);
      if (!current) return undefined;
      const next = { ...current, revokedAt, active: false };
      records.set(id, next);
      return publicRecord(next);
    },
    async deleteAllForTest() {
      records.clear();
    },
  };
}

// JWT
describe('Auth Module', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'a-very-long-secret-key-for-testing-only-12345';
    initializeConfig();
  });

  const payload: UserPayload = {
    address: 'GCSX2...',
    role: 'operator',
  };

  it('should generate a valid token', () => {
    const token = generateToken(payload);
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
  });

  it('should verify a valid token', () => {
    const token = generateToken(payload);
    const decoded = verifyToken(token);
    expect(decoded.address).toBe(payload.address);
    expect(decoded.role).toBe(payload.role);
  });

  it('should throw for an invalid token', () => {
    expect(() => verifyToken('invalid-token')).toThrow();
  });

  it('should throw for an expired token or tampered token', () => {
    const token = generateToken(payload);
    const tamperedToken = token + 'a';
    expect(() => verifyToken(tamperedToken)).toThrow();
  });
});

// API Key Management
describe('API Key Management', () => {
  let memoryStore: ReturnType<typeof createMemoryApiKeyStore>;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.API_KEY_PEPPER = 'test-pepper-for-api-key-unit-tests-12345';
    memoryStore = createMemoryApiKeyStore();
    setApiKeyStoreForTest(memoryStore);
    await _resetApiKeyStoreForTest();
  });

  describe('createApiKey', () => {
    it('returns a raw key and record metadata', async () => {
      const result = await createApiKey('my-service');
      expect(result.key).toMatch(/^flx_[0-9a-f]{64}$/);
      expect(result.name).toBe('my-service');
      expect(result.id).toBeTruthy();
      expect(result.prefix).toBe(result.key.slice(0, 8));
    });

    it('stores the key as a salted peppered hash without raw key material', async () => {
      const { key, id } = await createApiKey('svc');
      const records = await listApiKeys();
      const record = records.find((r) => r.id === id)!;
      const internal = memoryStore.records.get(id)!;

      expect(record.keyHash).not.toBe(key);
      expect(record.keyHash).toHaveLength(64);
      expect(internal.keySalt).toHaveLength(32);
      expect(internal.lookupHash).toBe(hashApiKeyLookupPrefix(key.slice(0, 8)));
    });

    it('throws when name is empty', async () => {
      await expect(createApiKey('')).rejects.toThrow('name is required');
    });

    it('multiple keys are independent', async () => {
      const a = await createApiKey('a');
      const b = await createApiKey('b');
      expect(a.id).not.toBe(b.id);
      expect(a.key).not.toBe(b.key);
    });
  });

  describe('isValidApiKey', () => {
    it('accepts a freshly created key', async () => {
      const { key } = await createApiKey('svc');
      await expect(isValidApiKey(key)).resolves.toBe(true);
    });

    it('rejects an unknown key without scanning unrelated prefixes', async () => {
      await createApiKey('svc');
      await expect(isValidApiKey('flx_notakey')).resolves.toBe(false);
    });

    it('rejects empty string', async () => {
      await expect(isValidApiKey('')).resolves.toBe(false);
    });
  });

  describe('rotateApiKey', () => {
    it('issues a new key and invalidates the old one', async () => {
      const { key: oldKey, id } = await createApiKey('svc');
      const { key: newKey } = await rotateApiKey(id);

      expect(newKey).not.toBe(oldKey);
      await expect(isValidApiKey(oldKey)).resolves.toBe(false);
      await expect(isValidApiKey(newKey)).resolves.toBe(true);
    });

    it('updates rotatedAt timestamp', async () => {
      const { id } = await createApiKey('svc');
      await rotateApiKey(id);
      const record = (await listApiKeys()).find((r) => r.id === id)!;
      expect(record.rotatedAt).not.toBeNull();
    });

    it('throws for unknown id', async () => {
      await expect(rotateApiKey('nonexistent')).rejects.toThrow('not found');
    });

    it('throws when key is already revoked', async () => {
      const { id } = await createApiKey('svc');
      await revokeApiKey(id);
      await expect(rotateApiKey(id)).rejects.toThrow('revoked');
    });
  });

  describe('revokeApiKey', () => {
    it('marks key inactive and rejects further auth', async () => {
      const { key, id } = await createApiKey('svc');
      await revokeApiKey(id);

      await expect(isValidApiKey(key)).resolves.toBe(false);
      const record = (await listApiKeys()).find((r) => r.id === id)!;
      expect(record.active).toBe(false);
      expect(record.revokedAt).not.toBeNull();
    });

    it('throws for unknown id', async () => {
      await expect(revokeApiKey('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('listApiKeys', () => {
    it('returns all records including revoked ones', async () => {
      const { id: id1 } = await createApiKey('a');
      const { id: id2 } = await createApiKey('b');
      await revokeApiKey(id2);

      const list = await listApiKeys();
      expect(list).toHaveLength(2);
      expect(list.find((r) => r.id === id1)!.active).toBe(true);
      expect(list.find((r) => r.id === id2)!.active).toBe(false);
    });
  });
});
