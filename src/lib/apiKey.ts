import { createId } from '@paralleldrive/cuid2';
import { createHash, timingSafeEqual } from 'crypto';
import type { ApiKeyRecord, ApiKeyCreated } from '../db/types.js';

// ---------------------------------------------------------------------------
// In-memory store (replace with DB-backed store when persistence is needed)
// ---------------------------------------------------------------------------
const store = new Map<string, ApiKeyRecord>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function generateRawKey(): string {
  // 32 random bytes → 64-char hex string
  const { randomBytes } = require('crypto') as typeof import('crypto');
  return `flx_${randomBytes(32).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a new API key. Returns the record plus the raw key (shown once).
 */
export function createApiKey(name: string): ApiKeyCreated {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('name is required');
  }

  const raw = generateRawKey();
  const id = createId();
  const now = new Date().toISOString();

  const record: ApiKeyRecord = {
    id,
    name: name.trim(),
    keyHash: sha256hex(raw),
    prefix: raw.slice(0, 8),
    createdAt: now,
    rotatedAt: null,
    active: true,
  };

  store.set(id, record);

  return { id, name: record.name, key: raw, prefix: record.prefix, createdAt: now };
}

/**
 * Rotates an existing key: invalidates the old hash and issues a new raw key.
 * Returns the new raw key (shown once).
 */
export function rotateApiKey(id: string): ApiKeyCreated {
  const record = store.get(id);
  if (!record) throw new Error(`API key not found: ${id}`);
  if (!record.active) throw new Error(`API key is revoked: ${id}`);

  const raw = generateRawKey();
  const now = new Date().toISOString();

  const updated: ApiKeyRecord = {
    ...record,
    keyHash: sha256hex(raw),
    prefix: raw.slice(0, 8),
    rotatedAt: now,
  };

  store.set(id, updated);

  return { id, name: record.name, key: raw, prefix: updated.prefix, createdAt: record.createdAt };
}

/**
 * Revokes an API key so it can no longer authenticate requests.
 */
export function revokeApiKey(id: string): void {
  const record = store.get(id);
  if (!record) throw new Error(`API key not found: ${id}`);

  store.set(id, { ...record, active: false });
}

/**
 * Returns all stored key records (hashes only — raw keys are never stored).
 */
export function listApiKeys(): ApiKeyRecord[] {
  return Array.from(store.values());
}

/**
 * Validates a raw API key against the stored hashes using constant-time comparison.
 */
export function isValidApiKey(rawKey: string): boolean {
  if (!rawKey) return false;

  const hash = sha256hex(rawKey);
  const hashBuf = Buffer.from(hash, 'hex');

  for (const record of store.values()) {
    if (!record.active) continue;
    try {
      const storedBuf = Buffer.from(record.keyHash, 'hex');
      if (storedBuf.length === hashBuf.length && timingSafeEqual(storedBuf, hashBuf)) {
        return true;
      }
    } catch {
      // length mismatch — skip
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

/** Exposed for tests only — clears the in-memory store. */
export function _resetApiKeyStoreForTest(): void {
  store.clear();
}
