import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ApiKeyRecord } from '../../src/db/types.js';

const timingSafeEqualMock = vi.hoisted(() => vi.fn());
const keys = vi.hoisted(() => new Map<string, ApiKeyRecord>());

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  timingSafeEqualMock.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: timingSafeEqualMock };
});

vi.mock('../../src/config/env.js', () => ({
  getConfig: () => ({ apiKeyPepper: 'test-pepper-32-chars-long-secret-key-pepper!' }),
}));

vi.mock('../../src/db/repositories/apiKeyRepository.js', () => ({
  apiKeyRepository: {
    insert: vi.fn(async (record: ApiKeyRecord) => keys.set(record.id, record)),
    findActiveByPrefix: vi.fn(async (prefix: string) =>
      [...keys.values()].filter((record) => record.prefix === prefix && record.active),
    ),
    revoke: vi.fn(async (id: string) => {
      const record = keys.get(id);
      if (!record) return undefined;
      const revoked = { ...record, active: false };
      keys.set(id, revoked);
      return revoked;
    }),
    listAll: vi.fn(async () => [...keys.values()]),
  },
}));

vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEventToDb: vi.fn(async () => {}),
}));

import {
  createApiKey,
  isValidApiKey,
  listApiKeys,
  revokeApiKey,
} from '../../src/lib/apiKey.js';

describe('API key security properties', () => {
  beforeEach(() => {
    keys.clear();
    timingSafeEqualMock.mockClear();
  });

  it('persists only a salted hash and returns plaintext only at creation', async () => {
    const created = await createApiKey('security-test');
    const stored = (await listApiKeys())[0]!;

    expect(stored.keyHash).not.toContain(created.key);
    expect(stored.keyHash).not.toBe(created.key);
    expect(stored.salt).toHaveLength(32);
    expect(created.key).toMatch(/^flx_[0-9a-f]{64}$/);
    expect((await listApiKeys()).every((record) => !JSON.stringify(record).includes(created.key))).toBe(true);
  });

  it('uses the constant-time primitive even when digest lengths differ', async () => {
    const created = await createApiKey('timing-test');
    const stored = (await listApiKeys())[0]!;
    stored.keyHash = stored.keyHash.slice(0, -2);

    expect(await isValidApiKey(created.key)).toBe(false);
    expect(timingSafeEqualMock).toHaveBeenCalled();
  });

  it('revokes the key immediately', async () => {
    const created = await createApiKey('revocation-test');
    expect(await isValidApiKey(created.key)).toBe(true);

    await revokeApiKey(created.id);

    expect(await isValidApiKey(created.key)).toBe(false);
  });
});