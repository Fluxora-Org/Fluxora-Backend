/**
 * Process-wide state for the streams routes: dependency health toggles and
 * the idempotency store used by POST /api/streams.
 *
 * Everything here is injectable so app startup can wire Redis and tests can
 * simulate outages without module reloading.
 *
 * @module routes/streams/state
 */
import {
  InMemoryIdempotencyStore,
  type IdempotencyStore,
} from '../../redis/idempotencyStore.js';
import type { SuccessEnvelope } from '../../utils/response.js';
import type { Stream } from '../../serialization/stream.js';

export type DependencyState = 'healthy' | 'unavailable';

type StreamIdempotencyStore = IdempotencyStore<SuccessEnvelope<Stream>>;

const streamListingDependency = { state: 'healthy' as DependencyState };
const idempotencyDependency = { state: 'healthy' as DependencyState };

// Starts as InMemoryIdempotencyStore; replaced at startup by
// wireIdempotencyStore() in app.ts with a RedisIdempotencyStore when Redis is
// available (REDIS_ENABLED=true).
let idempotencyStore: StreamIdempotencyStore = new InMemoryIdempotencyStore();

// TTL for idempotency entries — overridden in tests and set from config at startup.
let idempotencyTtlSeconds = 86400;

export function setStreamListingDependencyState(state: DependencyState): void {
  streamListingDependency.state = state;
}

export function setIdempotencyDependencyState(state: DependencyState): void {
  idempotencyDependency.state = state;
}

export function isStreamListingHealthy(): boolean {
  return streamListingDependency.state === 'healthy';
}

export function isIdempotencyHealthy(): boolean {
  return idempotencyDependency.state === 'healthy';
}

export function getIdempotencyStore(): StreamIdempotencyStore {
  return idempotencyStore;
}

export function getIdempotencyTtlSeconds(): number {
  return idempotencyTtlSeconds;
}

/**
 * Reset the idempotency store to a fresh in-memory instance.
 * Used in tests to get a clean slate with full idempotency semantics
 * (no Redis required).
 */
export function resetStreamIdempotencyStore(): void {
  idempotencyStore = new InMemoryIdempotencyStore();
}

/**
 * Replace the idempotency store implementation.
 * Called at startup with a RedisIdempotencyStore, and in tests with a
 * FakeRedisClient-backed store or a NoOpIdempotencyStore.
 *
 * The parameter is typed as `IdempotencyStore<unknown>` so callers do not
 * need to import the route's `Stream` envelope type. The cast is safe because
 * the create handler always stores and reads values of the correct shape.
 */
export function setIdempotencyStore(
  store: IdempotencyStore<unknown>,
  ttlSeconds?: number,
): void {
  idempotencyStore = store as StreamIdempotencyStore;
  if (ttlSeconds !== undefined) idempotencyTtlSeconds = ttlSeconds;
}
