import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { generateToken, verifyToken, UserPayload } from '../../src/lib/auth.js';
import { initializeConfig } from '../../src/config/env.js';
import {
  createApiKey,
  rotateApiKey,
  revokeApiKey,
  listApiKeys,
  findApiKeyRecord,
  isValidApiKey,
  _resetApiKeyStoreForTest,
} from '../../src/lib/apiKey.js';
import { DEFAULT_API_KEY_SCOPES, Permission } from '../../src/lib/permissions.js';

// ─── JWT ──────────────────────────────────────────────────────────────────────

describe('Auth Module', () => {
  // generateToken/verifyToken consult the loaded Config for jwtSecret /
  // jwtExpiresIn, so we must initialise the env-config before exercising them.
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

// ─── API Key Management ───────────────────────────────────────────────────────

describe('API Key Management', () => {
  beforeEach(() => {
    _resetApiKeyStoreForTest();
  });

  describe('createApiKey', () => {
    it('returns a raw key and record metadata', () => {
      const result = createApiKey('my-service');
      expect(result.key).toMatch(/^flx_[0-9a-f]{64}$/);
      expect(result.name).toBe('my-service');
      expect(result.id).toBeTruthy();
      expect(result.prefix).toBe(result.key.slice(0, 8));
      expect(result.scopes).toEqual([...DEFAULT_API_KEY_SCOPES]);
    });

    it('stores the key as a hash (raw key not in store)', () => {
      const { key, id } = createApiKey('svc');
      const records = listApiKeys();
      const record = records.find((r) => r.id === id)!;
      expect(record.keyHash).not.toBe(key);
      expect(record.keyHash).toHaveLength(64); // sha256 hex
      expect(record.scopes).toEqual([...DEFAULT_API_KEY_SCOPES]);
    });

    it('stores explicit scopes for least-privilege keys', () => {
      const result = createApiKey('read-only', [Permission.STREAMS_READ]);
      expect(result.scopes).toEqual([Permission.STREAMS_READ]);
      expect(listApiKeys()[0]!.scopes).toEqual([Permission.STREAMS_READ]);
    });

    it('rejects empty or unknown scopes', () => {
      expect(() => createApiKey('empty', [])).toThrow('at least one permission');
      expect(() => createApiKey('unknown', ['streams:read', 'made-up:scope'])).toThrow('unknown API key scope');
    });

    it('throws when name is empty', () => {
      expect(() => createApiKey('')).toThrow('name is required');
    });

    it('multiple keys are independent', () => {
      const a = createApiKey('a');
      const b = createApiKey('b');
      expect(a.id).not.toBe(b.id);
      expect(a.key).not.toBe(b.key);
    });
  });

  describe('isValidApiKey', () => {
    it('accepts a freshly created key', () => {
      const { key } = createApiKey('svc');
      expect(isValidApiKey(key)).toBe(true);
    });

    it('rejects an unknown key', () => {
      createApiKey('svc');
      expect(isValidApiKey('flx_notakey')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidApiKey('')).toBe(false);
    });

    it('returns the scoped key record for a matching raw key', () => {
      const { key, id } = createApiKey('svc', [Permission.STREAMS_WRITE]);
      const record = findApiKeyRecord(key);
      expect(record?.id).toBe(id);
      expect(record?.scopes).toEqual([Permission.STREAMS_WRITE]);
    });
  });

  describe('rotateApiKey', () => {
    it('issues a new key and invalidates the old one', () => {
      const { key: oldKey, id } = createApiKey('svc');
      const { key: newKey } = rotateApiKey(id);

      expect(newKey).not.toBe(oldKey);
      expect(isValidApiKey(oldKey)).toBe(false);
      expect(isValidApiKey(newKey)).toBe(true);
    });

    it('updates rotatedAt timestamp', () => {
      const { id } = createApiKey('svc');
      rotateApiKey(id);
      const record = listApiKeys().find((r) => r.id === id)!;
      expect(record.rotatedAt).not.toBeNull();
    });

    it('preserves scopes while rotating the raw secret', () => {
      const { id } = createApiKey('svc', [Permission.STREAMS_READ]);
      const rotated = rotateApiKey(id);
      expect(rotated.scopes).toEqual([Permission.STREAMS_READ]);
      expect(listApiKeys().find((r) => r.id === id)!.scopes).toEqual([Permission.STREAMS_READ]);
    });

    it('throws for unknown id', () => {
      expect(() => rotateApiKey('nonexistent')).toThrow('not found');
    });

    it('throws when key is already revoked', () => {
      const { id } = createApiKey('svc');
      revokeApiKey(id);
      expect(() => rotateApiKey(id)).toThrow('revoked');
    });
  });

  describe('revokeApiKey', () => {
    it('marks key inactive and rejects further auth', () => {
      const { key, id } = createApiKey('svc');
      revokeApiKey(id);

      expect(isValidApiKey(key)).toBe(false);
      const record = listApiKeys().find((r) => r.id === id)!;
      expect(record.active).toBe(false);
    });

    it('throws for unknown id', () => {
      expect(() => revokeApiKey('nonexistent')).toThrow('not found');
    });
  });

  describe('listApiKeys', () => {
    it('returns all records including revoked ones', () => {
      const { id: id1 } = createApiKey('a');
      const { id: id2 } = createApiKey('b');
      revokeApiKey(id2);

      const list = listApiKeys();
      expect(list).toHaveLength(2);
      expect(list.find((r) => r.id === id1)!.active).toBe(true);
      expect(list.find((r) => r.id === id2)!.active).toBe(false);
    });
  });
});
