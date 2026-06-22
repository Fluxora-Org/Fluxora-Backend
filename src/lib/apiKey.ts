import { createId } from '@paralleldrive/cuid2';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { ApiKeyCreated, ApiKeyRecord, ApiKeyStoredRecord } from '../db/types.js';
import { apiKeyRepository } from '../db/repositories/apiKeyRepository.js';

const API_KEY_PREFIX = 'flx_';
const RAW_KEY_BYTES = 32;
const DISPLAY_PREFIX_LENGTH = 8;
const SALT_BYTES = 16;
const HMAC_ALGORITHM = 'sha256';
const TEST_PEPPER = 'test-api-key-pepper-for-deterministic-unit-tests';

export interface ApiKeyStore {
  create(input: {
    id: string;
    name: string;
    keyHash: string;
    keySalt: string;
    lookupHash: string;
    prefix: string;
    createdAt: string;
    rotatedAt: string | null;
  }): Promise<ApiKeyRecord>;
  findById(id: string): Promise<ApiKeyRecord | undefined>;
  findActiveByLookupHash(lookupHash: string): Promise<ApiKeyStoredRecord[]>;
  list(): Promise<ApiKeyRecord[]>;
  rotate(id: string, input: {
    keyHash: string;
    keySalt: string;
    lookupHash: string;
    prefix: string;
    rotatedAt: string;
  }): Promise<ApiKeyRecord | undefined>;
  revoke(id: string, revokedAt: string): Promise<ApiKeyRecord | undefined>;
  deleteAllForTest(): Promise<void>;
}

let store: ApiKeyStore = apiKeyRepository;

function hmacHex(pepper: string, ...parts: string[]): string {
  const hmac = createHmac(HMAC_ALGORITHM, pepper);
  for (const part of parts) {
    hmac.update(part);
    hmac.update('\0');
  }
  return hmac.digest('hex');
}

function resolvePepper(): string {
  const pepper = process.env.API_KEY_PEPPER;
  if (pepper && pepper.length >= 32) return pepper;
  if (process.env.NODE_ENV === 'test') return TEST_PEPPER;
  throw new Error('API_KEY_PEPPER must be at least 32 characters');
}

function generateRawKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(RAW_KEY_BYTES).toString('hex')}`;
}

function generateSalt(): string {
  return randomBytes(SALT_BYTES).toString('hex');
}

/**
 * Build the salted, peppered credential hash stored in Postgres.
 *
 * The per-row salt prevents equal raw keys from producing equal stored hashes.
 * The server-side pepper keeps leaked DB rows from being directly reusable for
 * offline precomputation unless the deployment secret is also compromised.
 */
export function hashApiKeyForStorage(rawKey: string, salt: string, pepper = resolvePepper()): string {
  return hmacHex(pepper, 'api-key:v1:storage', salt, rawKey);
}

/**
 * Build the indexed lookup hash from the short display prefix.
 *
 * Validation uses this value to fetch a tiny candidate set instead of scanning
 * all active keys. The DB index stores a pepper-keyed hash, not the raw lookup
 * material, so it does not expose the whole credential or the pepper.
 */
export function hashApiKeyLookupPrefix(prefix: string, pepper = resolvePepper()): string {
  return hmacHex(pepper, 'api-key:v1:lookup', prefix);
}

function deriveKeyMaterial(rawKey: string): { keyHash: string; keySalt: string; lookupHash: string; prefix: string } {
  const keySalt = generateSalt();
  const prefix = rawKey.slice(0, DISPLAY_PREFIX_LENGTH);
  return {
    keyHash: hashApiKeyForStorage(rawKey, keySalt),
    keySalt,
    lookupHash: hashApiKeyLookupPrefix(prefix),
    prefix,
  };
}

function isConstantTimeEqualHex(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, 'hex');
    const bBuf = Buffer.from(b, 'hex');
    return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function assertValidName(name: string): string {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('name is required');
  }
  return name.trim();
}

export function setApiKeyStoreForTest(nextStore: ApiKeyStore): void {
  store = nextStore;
}

export function resetApiKeyStore(): void {
  store = apiKeyRepository;
}

/**
 * Creates a new API key. Returns the record plus the raw key, shown once.
 */
export async function createApiKey(name: string): Promise<ApiKeyCreated> {
  const trimmedName = assertValidName(name);
  const raw = generateRawKey();
  const id = createId();
  const now = new Date().toISOString();
  const material = deriveKeyMaterial(raw);

  const record = await store.create({
    id,
    name: trimmedName,
    ...material,
    createdAt: now,
    rotatedAt: null,
  });

  return { id: record.id, name: record.name, key: raw, prefix: record.prefix, createdAt: record.createdAt };
}

/**
 * Rotates an existing key and immediately invalidates the old raw key.
 */
export async function rotateApiKey(id: string): Promise<ApiKeyCreated> {
  const existing = await store.findById(id);
  if (!existing) throw new Error(`API key not found: ${id}`);
  if (!existing.active) throw new Error(`API key is revoked: ${id}`);

  const raw = generateRawKey();
  const now = new Date().toISOString();
  const material = deriveKeyMaterial(raw);
  const rotated = await store.rotate(id, { ...material, rotatedAt: now });
  if (!rotated) throw new Error(`API key is revoked: ${id}`);

  return { id, name: rotated.name, key: raw, prefix: rotated.prefix, createdAt: rotated.createdAt };
}

/**
 * Revokes an API key so it can no longer authenticate requests.
 */
export async function revokeApiKey(id: string): Promise<void> {
  const record = await store.revoke(id, new Date().toISOString());
  if (!record) throw new Error(`API key not found: ${id}`);
}

/**
 * Returns all stored key records. Raw keys, salts, and lookup hashes are never returned.
 */
export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  return store.list();
}

/**
 * Validates a raw API key via indexed lookup plus constant-time candidate comparison.
 */
export async function isValidApiKey(rawKey: string): Promise<boolean> {
  if (!rawKey) return false;

  const prefix = rawKey.slice(0, DISPLAY_PREFIX_LENGTH);
  const candidates = await store.findActiveByLookupHash(hashApiKeyLookupPrefix(prefix));
  for (const record of candidates) {
    const candidateHash = hashApiKeyForStorage(rawKey, record.keySalt);
    if (isConstantTimeEqualHex(record.keyHash, candidateHash)) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts the API key from common request headers.
 */
export function getApiKeyFromRequest(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const key = headers['x-api-key'] || headers['X-API-Key'];
  if (Array.isArray(key)) return key[0];
  return key;
}

/** Exposed for tests only. */
export async function _resetApiKeyStoreForTest(): Promise<void> {
  await store.deleteAllForTest();
}
