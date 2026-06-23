/**
 * API key management.
 *
 * Keys are persisted in PostgreSQL (see {@link ../db/repositories/apiKeyRepository})
 * so authentication state survives restarts and is shared across instances.
 *
 * Hardening over the legacy in-memory store:
 * - The raw key is never stored. Only `HMAC-SHA256(pepper, salt || rawKey)` is
 *   persisted, combining a per-key random salt with a server-side pepper so a
 *   leaked table cannot be brute-forced offline (no rainbow tables, no
 *   precomputation without the out-of-band pepper).
 * - Validation resolves candidate rows by an indexed key prefix, so it is
 *   O(log n) rather than a full scan over every active key.
 * - The candidate hash comparison is constant-time.
 *
 * The pepper is read from the validated `API_KEY_PEPPER` env var via config and
 * is never logged.
 */

import { createId } from '@paralleldrive/cuid2';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { getConfig } from '../config/env.js';
import { apiKeyRepository } from '../db/repositories/apiKeyRepository.js';
import { recordAuditEventToDb } from './auditLog.js';
import type { ApiKeyRecord, ApiKeyCreated } from '../db/types.js';
import { authApiKeyLookupDurationSeconds } from '../metrics/businessMetrics.js';

/**
 * Zod schema for the API key creation/rotation response.
 *
 * ⚠️  SECURITY: `key` is the plaintext API key shown **exactly once**.
 * Clients must store it immediately — it is never returned again.
 */
export const ApiKeyCreatedSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Raw key shown exactly once — store it immediately, it cannot be recovered. */
  key: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
});

const KEY_PREFIX = 'flx_';
/** Number of leading characters used as the indexed lookup prefix. */
const PREFIX_LENGTH = 8;
/** Per-key salt size in bytes. */
const SALT_BYTES = 16;
/** Raw key entropy in bytes (rendered as hex). */
const RAW_KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the server-side API-key pepper from configuration.
 *
 * Fails closed: if the pepper is not configured we refuse to hash or validate
 * keys rather than silently degrading to an unpeppered digest. The value is
 * never logged or returned to callers.
 *
 * @throws Error when `API_KEY_PEPPER` is not configured.
 */
function getPepper(): string {
  const pepper = getConfig().apiKeyPepper;
  if (!pepper) {
    throw new Error('API_KEY_PEPPER is required to hash and validate API keys');
  }
  return pepper;
}

/**
 * Derive the stored digest for a raw key.
 *
 * Computes `HMAC-SHA256(pepper, salt || rawKey)` and returns it as hex. The
 * per-key `salt` defeats rainbow tables; the server-side pepper means the
 * database alone is insufficient to brute-force a key offline.
 *
 * @param rawKey - The raw API key (never persisted).
 * @param salt   - Per-key random salt, hex-encoded.
 * @returns Hex-encoded HMAC digest suitable for storage.
 */
function hashKey(rawKey: string, salt: string): string {
  return createHmac('sha256', getPepper()).update(salt).update(rawKey).digest('hex');
}

/** Generate a new random raw key, e.g. `flx_<64 hex chars>`. */
function generateRawKey(): string {
  return `${KEY_PREFIX}${randomBytes(RAW_KEY_BYTES).toString('hex')}`;
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Operates on a single candidate row so authentication time does not leak
 * which (if any) stored hash matched. Length mismatches short-circuit safely.
 */
function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a new API key. Returns the record plus the raw key (shown once).
 *
 * Persists a salted/peppered hash and emits an `API_KEY_CREATED` audit row.
 *
 * @param name          - Human-readable label for the key.
 * @param correlationId - Optional request correlation id for the audit trail.
 */
export async function createApiKey(name: string, correlationId?: string): Promise<ApiKeyCreated> {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('name is required');
  }

  const raw = generateRawKey();
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const id = createId();
  const now = new Date().toISOString();

  const record: ApiKeyRecord = {
    id,
    name: name.trim(),
    keyHash: hashKey(raw, salt),
    salt,
    prefix: raw.slice(0, PREFIX_LENGTH),
    createdAt: now,
    rotatedAt: null,
    active: true,
  };

  await apiKeyRepository.insert(record);
  await recordAuditEventToDb('API_KEY_CREATED', 'api_key', id, correlationId, {
    prefix: record.prefix,
    name: record.name,
  });

  return { id, name: record.name, key: raw, prefix: record.prefix, createdAt: now };
}

/**
 * Rotates an existing key: invalidates the old hash and issues a new raw key.
 * Returns the new raw key (shown once) and emits an `API_KEY_ROTATED` audit row.
 *
 * @param id            - Identifier of the key to rotate.
 * @param correlationId - Optional request correlation id for the audit trail.
 */
export async function rotateApiKey(id: string, correlationId?: string): Promise<ApiKeyCreated> {
  const record = await apiKeyRepository.getById(id);
  if (!record) throw new Error(`API key not found: ${id}`);
  if (!record.active) throw new Error(`API key is revoked: ${id}`);

  const raw = generateRawKey();
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const now = new Date().toISOString();

  const updated = await apiKeyRepository.rotate(id, {
    keyHash: hashKey(raw, salt),
    salt,
    prefix: raw.slice(0, PREFIX_LENGTH),
    rotatedAt: now,
  });
  if (!updated) throw new Error(`API key not found: ${id}`);

  await recordAuditEventToDb('API_KEY_ROTATED', 'api_key', id, correlationId, {
    prefix: updated.prefix,
    name: updated.name,
  });

  return { id, name: updated.name, key: raw, prefix: updated.prefix, createdAt: record.createdAt };
}

/**
 * Revokes an API key so it can no longer authenticate requests.
 * Emits an `API_KEY_REVOKED` audit row.
 *
 * @param id            - Identifier of the key to revoke.
 * @param correlationId - Optional request correlation id for the audit trail.
 */
export async function revokeApiKey(id: string, correlationId?: string): Promise<void> {
  const revoked = await apiKeyRepository.revoke(id);
  if (!revoked) throw new Error(`API key not found: ${id}`);

  await recordAuditEventToDb('API_KEY_REVOKED', 'api_key', id, correlationId, {
    prefix: revoked.prefix,
    name: revoked.name,
  });
}

/**
 * Returns all stored key records (hashes only — raw keys are never stored).
 */
export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  return apiKeyRepository.listAll();
}

/**
 * Validates a raw API key.
 *
 * Resolves candidate active rows by the indexed key prefix (O(log n)) and then
 * performs a constant-time comparison against each candidate's salted/peppered
 * hash. Returns `true` on the first match.
 *
 * Latency is recorded in the `fluxora_auth_apikey_lookup_duration_seconds`
 * histogram, labelled only by `outcome` (`success` | `failure`). No key id,
 * prefix, raw key, or hash value is ever emitted as a metric label. Every code
 * path calls `endTimer` exactly once before returning, so the histogram never
 * observes a partial (timer-started but never-closed) sample.
 *
 * @param rawKey - The raw key presented by the caller.
 */
export async function isValidApiKey(rawKey: string): Promise<boolean> {
  const endTimer = authApiKeyLookupDurationSeconds.startTimer();

  if (!rawKey || typeof rawKey !== 'string') {
    endTimer({ outcome: 'failure' });
    return false;
  }

  const prefix = rawKey.slice(0, PREFIX_LENGTH);
  const candidates = await apiKeyRepository.findActiveByPrefix(prefix);

  let matched = false;
  for (const candidate of candidates) {
    // Compare every candidate (do not early-return) so timing does not reveal
    // which row, if any, matched within a colliding prefix bucket.
    if (hashesMatch(hashKey(rawKey, candidate.salt), candidate.keyHash)) {
      matched = true;
    }
  }
  endTimer({ outcome: matched ? 'success' : 'failure' });
  return matched;
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
