/**
 * Redis-backed idempotency store for POST /api/streams.
 *
 * Stores the full HTTP response (status code + body) keyed by the
 * caller-supplied Idempotency-Key so that replayed requests return the
 * exact same response without re-executing the business logic.
 *
 * Graceful degradation
 * --------------------
 * If Redis is unavailable (get/set throws), the store logs a warning and
 * returns null / silently skips the write.  The optional `onStateChange`
 * callback is invoked with `false` on error and `true` on recovery so that
 * callers can flip an upstream dependency-health flag (→ 503 rather than
 * silently losing idempotency guarantees).
 *
 * Security notes
 * --------------
 * - Keys are namespaced under `fluxora:idempotency:` to avoid collisions.
 * - The raw Idempotency-Key value is never logged; only its length is.
 * - Stored fingerprints are SHA-256 of the normalised request body, so a
 *   different payload under the same key cannot silently overwrite a cached
 *   response — it produces a 409 CONFLICT instead.
 * - TTL is enforced by Redis EX so entries are automatically evicted after
 *   the configured window (default 86 400 s / 24 h).
 * - The stored value is JSON-serialised; no eval or dynamic code paths.
 *
 * @module redis/idempotencyStore
 */

import type { RedisClient } from './client.js';
import { logger as defaultLogger } from '../logging/logger.js';
import { correlationStore } from '../tracing/middleware.js';

export const IDEMPOTENCY_KEY_PREFIX = 'fluxora:idempotency:';

/**
 * Monotonically increasing integer that identifies the envelope schema.
 * Bump this constant whenever the shape of {@link IdempotentEntry} changes
 * in a backward-incompatible way.  Stored entries whose `version` field
 * does not equal this value are treated as absent (recomputed).
 */
export const ENVELOPE_VERSION = 1;

/**
 * Shape stored in Redis for each idempotency entry.
 *
 * All stored Redis data is treated as **untrusted input**: the envelope is
 * schema-validated before use so a corrupt, stale, or cross-service value
 * cannot crash callers or produce incorrect idempotency decisions.
 */
export interface IdempotentEntry<T = unknown> {
  /** Envelope schema version — must equal {@link ENVELOPE_VERSION}. */
  version: number;
  /** SHA-256 hex digest of the normalised request body. */
  requestFingerprint: string;
  /** HTTP status code of the original response. */
  statusCode: number;
  /** Full response body as returned to the client. */
  body: T;
}

/**
 * Parse raw Redis JSON and validate it against the expected envelope schema.
 *
 * Returns the validated entry, or `null` when:
 * - `raw` is not valid JSON
 * - required fields are missing or have wrong types
 * - `version` does not match {@link ENVELOPE_VERSION}
 *
 * Callers receive a reason string for structured warning logs.
 */
function parseAndValidateEnvelope<T>(
  raw: string,
): { entry: IdempotentEntry<T>; invalidReason?: never } | { entry?: never; invalidReason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { invalidReason: 'invalid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { invalidReason: 'envelope is not an object' };
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['requestFingerprint'] !== 'string') {
    return { invalidReason: 'missing or invalid requestFingerprint' };
  }
  if (typeof obj['statusCode'] !== 'number') {
    return { invalidReason: 'missing or invalid statusCode' };
  }
  if (!('body' in obj)) {
    return { invalidReason: 'missing body' };
  }
  if (typeof obj['version'] !== 'number') {
    return { invalidReason: 'missing version field' };
  }
  if (obj['version'] !== ENVELOPE_VERSION) {
    return { invalidReason: `version mismatch: got ${obj['version']}, expected ${ENVELOPE_VERSION}` };
  }

  return { entry: obj as unknown as IdempotentEntry<T> };
}

export interface IdempotencyStore<T = unknown> {
  /**
   * Retrieve a previously stored response.
   * Returns null on cache miss or Redis unavailability.
   */
  get(key: string): Promise<IdempotentEntry<T> | null>;

  /**
   * Persist a response for future replays.
   * Silently no-ops on Redis unavailability.
   */
  set(key: string, entry: IdempotentEntry<T>, ttlSeconds: number): Promise<void>;

  /** Release any external resources (e.g. Redis connection) held by this store. */
  close(): Promise<void>;
}

/** Options for {@link RedisIdempotencyStore}. */
export interface RedisIdempotencyStoreOptions {
  /**
   * Called with `true` after every successful Redis operation (indicating
   * the store is healthy) and with `false` after every error (indicating
   * the store is degraded).  Use this to flip an upstream dependency-health
   * flag so that callers can return 503 instead of silently losing guarantees.
   *
   * The callback is never called when the store is not used (e.g. NoOp).
   * Idempotency-Key values are never passed to this callback.
   */
  onStateChange?: (healthy: boolean) => void;

  /**
   * Structured logger instance. Defaults to the application's shared logger.
   * Pass a mock or custom logger in tests or when custom log routing is needed.
   * When omitted, logs are emitted through the default structured logger
   * (JSON lines with automatic PII redaction).
   */
  logger?: typeof defaultLogger;
}

export class RedisIdempotencyStore<T = unknown> implements IdempotencyStore<T> {
  private readonly onStateChange?: (healthy: boolean) => void;
  private readonly logger: typeof defaultLogger;

  /**
   * @param client  The Redis client to use for storage.
   * @param options Optional callbacks for health-state reporting and logger injection.
   */
  constructor(
    private readonly client: RedisClient,
    options?: RedisIdempotencyStoreOptions,
  ) {
    this.onStateChange = options?.onStateChange;
    this.logger = options?.logger ?? defaultLogger;
  }

  private buildKey(key: string): string {
    return `${IDEMPOTENCY_KEY_PREFIX}${key}`;
  }

  async get(key: string): Promise<IdempotentEntry<T> | null> {
    try {
      const raw = await this.client.get(this.buildKey(key));
      this.onStateChange?.(true);
      if (raw === null) return null;

      const result = parseAndValidateEnvelope<T>(raw);
      if (result.invalidReason !== undefined) {
        this.logger.warn('Idempotency store: envelope validation failed — treating as absent', {
          operation: 'get',
          correlationId: correlationStore.getStore(),
          keyLength: key.length,
          reason: result.invalidReason,
        });
        return null;
      }
      return result.entry;
    } catch (err) {
      this.onStateChange?.(false);
      this.logger.warn('Idempotency store: Redis get failed — degrading to pass-through', {
        operation: 'get',
        correlationId: correlationStore.getStore(),
        keyLength: key.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async set(key: string, entry: IdempotentEntry<T>, ttlSeconds: number): Promise<void> {
    try {
      const versioned: IdempotentEntry<T> = { ...entry, version: ENVELOPE_VERSION };
      await this.client.set(this.buildKey(key), JSON.stringify(versioned), { ex: ttlSeconds });
      this.onStateChange?.(true);
    } catch (err) {
      this.onStateChange?.(false);
      this.logger.warn('Idempotency store: Redis set failed — idempotency not persisted', {
        operation: 'set',
        correlationId: correlationStore.getStore(),
        keyLength: key.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * No-op store used when Redis is disabled (`REDIS_ENABLED=false`).
 * Every get() is a miss; every set() is a silent no-op.
 * The route handler degrades gracefully: requests are processed normally
 * but duplicate protection is not enforced across instances or restarts.
 */
export class NoOpIdempotencyStore<T = unknown> implements IdempotencyStore<T> {
  async get(_key: string): Promise<IdempotentEntry<T> | null> {
    return null;
  }
  async set(_key: string, _entry: IdempotentEntry<T>, _ttlSeconds: number): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * In-memory idempotency store for tests and local development.
 * Provides full idempotency semantics without requiring Redis.
 * Not suitable for production (state is lost on restart and not shared
 * across instances).
 */
export class InMemoryIdempotencyStore<T = unknown> implements IdempotencyStore<T> {
  private readonly store = new Map<string, IdempotentEntry<T>>();

  async get(key: string): Promise<IdempotentEntry<T> | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, entry: IdempotentEntry<T>, _ttlSeconds: number): Promise<void> {
    this.store.set(key, entry);
  }

  clear(): void {
    this.store.clear();
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}
