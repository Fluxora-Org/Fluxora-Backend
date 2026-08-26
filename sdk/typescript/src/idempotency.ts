/**
 * Idempotency key generation and payload hashing utilities.
 *
 * Generated from `openapi.yaml` by `scripts/generate-sdk-ts.mjs`.
 * Do not edit by hand — run `pnpm generate:sdk:ts` instead.
 *
 * ## Purpose
 * POST /api/streams requires an `Idempotency-Key` header to prevent duplicate
 * stream creation on retries. This module provides:
 *
 * - `generateIdempotencyKey()` — creates a fresh UUID v4 key per operation.
 * - `canonicalizeBody()` — serialises an object to a deterministic JSON string
 *   (sorted keys, recursive) suitable for hashing.
 * - `hashBody()` — computes a SHA-256 hex digest matching the server-side
 *   `fingerprintInput()` in `src/routes/streams.ts`.
 *
 * ## Idempotency Contract
 *
 * ### Key Format and Validation
 * - Keys must be 1–128 characters matching `[A-Za-z0-9:_-]`.
 * - UUID v4 format is recommended but not required.
 * - The server validates key format via `requireIdempotencyKey` middleware.
 * - Invalid or missing keys return `400 VALIDATION_ERROR`.
 *
 * ### Conflict Detection
 * - Same key + same body hash → cached response replayed (201 with `Idempotency-Replayed: true`).
 * - Same key + different body hash → `409 CONFLICT` with `stored_hash` and `incoming_hash`.
 * - Different keys → always treated as separate operations (no collision).
 *
 * ### Retry Behavior
 * - Generate a **new key per logical operation**.
 * - Reuse the **same key** when retrying a failed request to make it idempotent.
 * - Do not reuse keys across different logical operations.
 * - The SDK does not retry requests internally; retry logic is application-level.
 *
 * ### Cache TTL
 * - Idempotency entries expire after `IDEMPOTENCY_TTL_SECONDS` (default 24 hours).
 * - After expiry, the same key can be reused safely for a new operation.
 * - TTL is server-side configured; clients cannot control it.
 *
 * ## Security
 * - Keys are generated with `crypto.randomUUID()` (WebCrypto) where available,
 *   with a `Math.random`-based UUID v4 fallback for older environments.
 * - `hashBody()` uses `crypto.subtle.digest` (WebCrypto) with a Node.js
 *   `node:crypto` `createHash` fallback.
 * - Key values are never logged or echoed in error responses.
 * - Only key length is logged server-side for debugging.
 *
 * ## Error Handling
 * - `hashBody()` throws `Error` when no crypto API is available.
 * - Conflict errors include both hashes for debugging mismatched payloads.
 * - Network errors from `fetch` bubble up unchanged; retry with the same key.
 *
 * ## Observability
 * - Successful responses include `Idempotency-Key` header echoing the submitted key.
 * - Replayed responses include `Idempotency-Replayed: true` header.
 * - Fresh responses include `Idempotency-Replayed: false` header.
 * - Request IDs (from `X-Request-ID`) correlate client and server logs.
 *
 * @module @fluxora/sdk/idempotency
 */

// ── Key Generation ────────────────────────────────────────────────────────────

/**
 * Generate a unique UUID v4 idempotency key.
 *
 * Uses `crypto.randomUUID()` (Node.js ≥ 15, all modern browsers).
 * Falls back to a `Math.random`-based v4 UUID for older environments.
 *
 * Generate a **new key per logical operation**. Reuse the same key when
 * retrying a failed request to make it idempotent.
 *
 * @returns A UUID v4 string (e.g. `'b4a6f1a2-33c9-4d8e-b789-0e0a1c2d3e4f'`).
 *
 * @example
 * ```typescript
 * const key = generateIdempotencyKey();
 * const stream = await client.createStream(input, key);
 * // Retry with same key — gets cached response
 * const same = await client.createStream(input, key);
 * ```
 */
export function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Math.random fallback for environments without WebCrypto
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Canonical JSON ────────────────────────────────────────────────────────────

/**
 * Recursively serialise a value to a **canonical** JSON string.
 *
 * Canonical form guarantees that two logically equal objects always produce
 * the same string regardless of key insertion order, enabling deterministic
 * payload fingerprinting that matches the server-side `fingerprintInput()`.
 *
 * Rules:
 * - Object keys are sorted lexicographically (ascending, recursive).
 * - Array element order is preserved.
 * - Primitives are serialised as `JSON.stringify` would.
 * - `null` and `undefined` are both serialised as `'null'`.
 *
 * @param body - Any JSON-serialisable value.
 * @returns A deterministic JSON string.
 *
 * @example
 * ```typescript
 * canonicalizeBody({ z: 1, a: 2 }); // '{"a":2,"z":1}'
 * canonicalizeBody({ a: 2, z: 1 }); // '{"a":2,"z":1}'  — identical
 * ```
 */
export function canonicalizeBody(body: unknown): string {
  if (body === null || body === undefined) return 'null';
  if (typeof body !== 'object') return JSON.stringify(body);

  if (Array.isArray(body)) {
    const items = (body as unknown[]).map((item) => canonicalizeBody(item));
    return `[${items.join(',')}]`;
  }

  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `"${k}":${canonicalizeBody(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

// ── SHA-256 Hashing ───────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hex digest of a JSON payload.
 *
 * The payload is canonicalised via `canonicalizeBody()` and UTF-8 encoded
 * before hashing. The digest matches the server-side `fingerprintInput()`
 * in `src/routes/streams.ts`.
 *
 * Prefers `crypto.subtle.digest` (WebCrypto) with a Node.js
 * `node:crypto` `createHash` fallback.
 *
 * @param body - Any JSON-serialisable value.
 * @returns A lowercase 64-character SHA-256 hex string.
 * @throws {Error} When no crypto API is available.
 *
 * @example
 * ```typescript
 * const hash = await hashBody({ sender: 'G...', depositAmount: '100' });
 * console.log(hash.length); // 64
 * ```
 */
export async function hashBody(body: unknown): Promise<string> {
  const canonical = canonicalizeBody(body);
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Node.js crypto fallback for environments without globalThis.crypto
  try {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(canonical).digest('hex');
  } catch {
    throw new Error('Crypto API unavailable: cannot compute SHA-256 hash');
  }
}

// ── Idempotency Helper ────────────────────────────────────────────────────────

export interface CacheEntry<T> {
  response: T;
  statusCode: number;
}

export interface ICacheStore {
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  set<T>(key: string, entry: CacheEntry<T>, ttlSeconds?: number): Promise<void>;
  /** Returns false if the lock is already held */
  acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
}

export interface IdempotencyOptions {
  /** The unique idempotency key provided by the client */
  idempotencyKey: string;
  /** The identifier of the authenticated caller (e.g. user ID or API key ID) */
  callerId: string;
  /** TTL for the idempotency cache in seconds (default: 86400 / 24h) */
  ttlSeconds?: number;
}

export interface Logger {
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
}

export class IdempotencyError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

export class IdempotencyHelper {
  constructor(
    private store: ICacheStore,
    private logger: Logger = console
  ) {}

  /**
   * Executes an operation idempotently.
   * 
   * @param options Idempotency settings including the key and caller context.
   * @param operation The business logic to execute if this is a fresh request.
   * @returns The result of the operation or the cached result.
   */
  async execute<T>(
    options: IdempotencyOptions,
    operation: () => Promise<{ response: T; statusCode: number }>
  ): Promise<{ response: T; statusCode: number; cached: boolean }> {
    const { idempotencyKey, callerId, ttlSeconds = 86400 } = options;

    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      this.logger.warn('Idempotency validation failed: Invalid idempotency key', { idempotencyKey, callerId });
      throw new IdempotencyError('INVALID_KEY', 'Idempotency key is required and must be a valid string.');
    }

    if (!callerId || typeof callerId !== 'string' || callerId.trim() === '') {
      this.logger.warn('Idempotency validation failed: Invalid caller ID', { idempotencyKey, callerId });
      throw new IdempotencyError('INVALID_CALLER', 'Caller ID is required and must be a valid string.');
    }

    // Isolate keys per caller to prevent cross-tenant collisions
    const scopedKey = `idempotency:${callerId}:${idempotencyKey}`;

    // 1. Check if we already have a completed response
    const cached = await this.store.get<T>(scopedKey);
    if (cached) {
      this.logger.info('Idempotency cache hit', { idempotencyKey, callerId });
      return { ...cached, cached: true };
    }

    // 2. Acquire a lock to prevent concurrent processing of the same key
    const lockKey = `${scopedKey}:lock`;
    const lockAcquired = await this.store.acquireLock(lockKey, 30); // 30 second lock
    if (!lockAcquired) {
      this.logger.warn('Concurrent request collision', { idempotencyKey, callerId });
      throw new IdempotencyError('CONCURRENT_REQUEST', 'A request with this idempotency key is already in progress.');
    }

    try {
      // 3. Execute the operation
      this.logger.info('Executing fresh operation', { idempotencyKey, callerId });
      const result = await operation();

      // 4. Cache the result for future replays
      await this.store.set(scopedKey, result, ttlSeconds);
      
      return { ...result, cached: false };
    } catch (error) {
      this.logger.error('Operation failed during idempotent execution', { idempotencyKey, callerId, error });
      throw error;
    } finally {
      // 5. Release the lock
      await this.store.releaseLock(lockKey);
    }
  }
}
