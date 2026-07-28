import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { generateToken, verifyToken, UserPayload } from '../../src/lib/auth.js';
import { initializeConfig } from '../../src/config/env.js';
import type { ApiKeyRecord } from '../../src/db/types.js';

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// The apiKey library is exercised against an in-memory fake repository so the
// salted-hash / prefix-lookup logic can be tested without a live database.
// Audit writes are stubbed (asserted separately) so they never hit Postgres.

const fakeRepo = vi.hoisted(() => {
  const store = new Map<string, ApiKeyRecord>();
  return {
    store,
    reset: () => store.clear(),
    insert: vi.fn(async (record: ApiKeyRecord) => {
      store.set(record.id, { ...record });
    }),
    findActiveByPrefix: vi.fn(async (prefix: string) =>
      [...store.values()].filter((r) => r.prefix === prefix && r.active),
    ),
    getById: vi.fn(async (id: string) => {
      const r = store.get(id);
      return r ? { ...r } : undefined;
    }),
    rotate: vi.fn(async (id: string, patch: { keyHash: string; salt: string; prefix: string; rotatedAt: string }) => {
      const r = store.get(id);
      if (!r) return undefined;
      const updated = { ...r, ...patch };
      store.set(id, updated);
      return { ...updated };
    }),
    revoke: vi.fn(async (id: string) => {
      const r = store.get(id);
      if (!r) return undefined;
      const updated = { ...r, active: false };
      store.set(id, updated);
      return { ...updated };
    }),
    listAll: vi.fn(async () => [...store.values()]),
  };
});

const recordAuditEventToDb = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('../../src/db/repositories/apiKeyRepository.js', () => ({
  apiKeyRepository: fakeRepo,
}));

vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEventToDb,
}));

import {
  createApiKey,
  rotateApiKey,
  revokeApiKey,
  listApiKeys,
  isValidApiKey,
  getApiKeyFromRequest,
} from '../../src/lib/apiKey.js';

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
  beforeAll(() => {
    initializeConfig();
  });

  beforeEach(async () => {
    fakeRepo.reset();
    vi.clearAllMocks();
    // Reset the API key lookup histogram so existing tests don't leak
    // observations into history-aware assertions in the histogram suite.
    const mod = await import('../../src/metrics/businessMetrics.js');
    try {
      mod.authApiKeyLookupDurationSeconds.reset();
    } catch {
      // Metric may not be registered yet on first test run; safe to ignore.
    }
  });

  describe('createApiKey', () => {
    it('returns a raw key and record metadata', async () => {
      const result = await createApiKey('my-service');
      expect(result.key).toMatch(/^flx_[0-9a-f]{64}$/);
      expect(result.name).toBe('my-service');
      expect(result.id).toBeTruthy();
      expect(result.prefix).toBe(result.key.slice(0, 8));
    });

    it('stores a salted hash, never the raw key', async () => {
      const { key, id } = await createApiKey('svc');
      const record = (await listApiKeys()).find((r) => r.id === id)!;
      expect(record.keyHash).not.toBe(key);
      expect(record.keyHash).toHaveLength(64); // hmac-sha256 hex
      expect(record.salt).toHaveLength(32);    // 16 random bytes, hex
    });

    it('uses a distinct salt per key (no shared salt across keys)', async () => {
      const { id: a } = await createApiKey('a');
      const { id: b } = await createApiKey('b');
      const list = await listApiKeys();
      const recA = list.find((r) => r.id === a)!;
      const recB = list.find((r) => r.id === b)!;
      expect(recA.salt).not.toBe(recB.salt);
    });

    it('throws when name is empty', async () => {
      await expect(createApiKey('')).rejects.toThrow('name is required');
    });

    it('emits an API_KEY_CREATED audit row', async () => {
      const { id } = await createApiKey('svc', 'corr-1');
      expect(recordAuditEventToDb).toHaveBeenCalledWith(
        'API_KEY_CREATED', 'api_key', id, 'corr-1', expect.objectContaining({ name: 'svc' }),
      );
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
      expect(await isValidApiKey(key)).toBe(true);
    });

    it('rejects an unknown key', async () => {
      await createApiKey('svc');
      expect(await isValidApiKey('flx_notakey')).toBe(false);
    });

    it('rejects empty string', async () => {
      expect(await isValidApiKey('')).toBe(false);
    });

    it('does a constant-time compare only against the matching-prefix candidate', async () => {
      const { key } = await createApiKey('svc');
      await isValidApiKey(key);
      expect(fakeRepo.findActiveByPrefix).toHaveBeenCalledWith(key.slice(0, 8));
    });

    it('resolves the correct key even on a prefix collision', async () => {
      const { key: keyA } = await createApiKey('a');
      // Force a second key into keyA's prefix bucket to simulate a collision.
      const { id: idB } = await createApiKey('b');
      const recB = fakeRepo.store.get(idB)!;
      fakeRepo.store.set(idB, { ...recB, prefix: keyA.slice(0, 8) });

      // keyA validates despite sharing its bucket with a non-matching candidate.
      expect(await isValidApiKey(keyA)).toBe(true);
      // A forged key with the same prefix but a different body is still rejected.
      expect(await isValidApiKey(keyA.slice(0, 8) + 'deadbeef'.repeat(7))).toBe(false);
    });
  });

  // ── API key lookup histogram (issue #361) ──
  describe('fluxora_auth_apikey_lookup_duration_seconds histogram', () => {
    let histogram: typeof import('../../src/metrics/businessMetrics.js').authApiKeyLookupDurationSeconds;

    beforeEach(async () => {
      const mod = await import('../../src/metrics/businessMetrics.js');
      histogram = mod.authApiKeyLookupDurationSeconds;
      histogram.reset();
    });

    /**
     * Helper: prom-client Histogram `get()` exposes bucket observations
     * (which include `le`) alongside `_count` / `_sum` series (which carry
     * only the metric's declared labels). We assert on the count series to
     * confirm the label set is bounded to `outcome`.
     */
    function findCountSeries(values: any[], outcome: string) {
      return values.find(
        (v) =>
          v.metricName === 'fluxora_auth_apikey_lookup_duration_seconds_count' &&
          (v.labels as Record<string, string>).outcome === outcome,
      );
    }

    it('records outcome=success for a valid key (count series labels limited to outcome)', async () => {
      const { key } = createApiKey('svc');
      expect(isValidApiKey(key)).toBe(true);

      const val = await histogram.get();
      const success = findCountSeries(val.values, 'success');
      expect(success).toBeDefined();
      expect(success?.value).toBeGreaterThanOrEqual(1);
      expect(Object.keys(success!.labels)).toEqual(['outcome']);
    });

    it('records outcome=failure for an unknown key (no credential leak via labels)', async () => {
      createApiKey('svc');
      expect(isValidApiKey('flx_unknown')).toBe(false);

      const val = await histogram.get();
      const failure = findCountSeries(val.values, 'failure');
      expect(failure).toBeDefined();
      expect(failure?.value).toBeGreaterThanOrEqual(1);
      // No credential material ever appears in any labels (bucket or otherwise)
      for (const v of val.values) {
        for (const forbidden of ['keyId', 'prefix', 'keyHash', 'rawKey', 'address']) {
          expect((v.labels as Record<string, unknown>)[forbidden]).toBeUndefined();
        }
      }
    });

    it('records outcome=failure for an empty string input (early-return path still observed)', async () => {
      expect(isValidApiKey('')).toBe(false);

      const val = await histogram.get();
      const failure = findCountSeries(val.values, 'failure');
      expect(failure).toBeDefined();
      expect(failure?.value).toBeGreaterThanOrEqual(1);
    });
  });

  describe('rotateApiKey', () => {
    it('issues a new key and invalidates the old one', async () => {
      const { key: oldKey, id } = await createApiKey('svc');
      const { key: newKey } = await rotateApiKey(id);

      expect(newKey).not.toBe(oldKey);
      expect(await isValidApiKey(oldKey)).toBe(false);
      expect(await isValidApiKey(newKey)).toBe(true);
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

    it('emits an API_KEY_ROTATED audit row', async () => {
      const { id } = await createApiKey('svc');
      await rotateApiKey(id, 'corr-2');
      expect(recordAuditEventToDb).toHaveBeenCalledWith(
        'API_KEY_ROTATED', 'api_key', id, 'corr-2', expect.any(Object),
      );
    });
  });

  describe('revokeApiKey', () => {
    it('marks key inactive and rejects further auth', async () => {
      const { key, id } = await createApiKey('svc');
      await revokeApiKey(id);

      expect(await isValidApiKey(key)).toBe(false);
      const record = (await listApiKeys()).find((r) => r.id === id)!;
      expect(record.active).toBe(false);
    });

    it('throws for unknown id', async () => {
      await expect(revokeApiKey('nonexistent')).rejects.toThrow('not found');
    });

    it('emits an API_KEY_REVOKED audit row', async () => {
      const { id } = await createApiKey('svc');
      await revokeApiKey(id, 'corr-3');
      expect(recordAuditEventToDb).toHaveBeenCalledWith(
        'API_KEY_REVOKED', 'api_key', id, 'corr-3', expect.any(Object),
      );
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

  describe('getApiKeyFromRequest', () => {
    it('reads the x-api-key header', () => {
      expect(getApiKeyFromRequest({ 'x-api-key': 'flx_abc' })).toBe('flx_abc');
    });

    it('unwraps array-valued headers', () => {
      expect(getApiKeyFromRequest({ 'x-api-key': ['flx_first', 'flx_second'] })).toBe('flx_first');
    });

    it('returns undefined when absent', () => {
      expect(getApiKeyFromRequest({})).toBeUndefined();
    });
  });
});
