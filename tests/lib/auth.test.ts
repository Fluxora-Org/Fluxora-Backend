import { describe, it, expect, beforeEach } from 'vitest';
import { generateToken, verifyToken, UserPayload } from '../../src/lib/auth.js';
import {
  createApiKey,
  rotateApiKey,
  revokeApiKey,
  listApiKeys,
  isValidApiKey,
  _resetApiKeyStoreForTest,
} from '../../src/lib/apiKey.js';

// ─── JWT ──────────────────────────────────────────────────────────────────────

describe('Auth Module', () => {
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
    });

    it('stores the key as a hash (raw key not in store)', () => {
      const { key, id } = createApiKey('svc');
      const records = listApiKeys();
      const record = records.find((r) => r.id === id)!;
      expect(record.keyHash).not.toBe(key);
      expect(record.keyHash).toHaveLength(64); // sha256 hex
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
