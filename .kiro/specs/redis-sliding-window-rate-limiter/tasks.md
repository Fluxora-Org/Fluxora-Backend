# Implementation Plan: Redis Sliding-Window Rate Limiter

## Overview

Incrementally replace the in-memory counter store in `src/middleware/rateLimiter.ts` with a Redis-backed sliding-window implementation. Each task builds on the previous one, ending with full wiring, observability, and graceful shutdown.

## Tasks

- [x] 1. Extend `src/types/rateLimit.ts` with the `RateLimitStore` interface and updated `RateLimitStatus`
  - Add `RateLimitStore` interface with `increment`, `getCount`, and `close` methods
  - Add `store` and `degraded` optional fields to `RateLimitStatus`
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 7.3_

- [x] 2. Create `src/redis/rateLimitStore.ts` with `InMemoryStore`, `SlidingWindowStore`, and `HybridStore`
  - [x] 2.1 Implement `InMemoryStore` by extracting the existing counter logic from `rateLimiter.ts` behind the `RateLimitStore` interface
    - Preserve the existing `getOrInitCounter` window-reset behaviour
    - `close()` is a no-op
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ]* 2.2 Write property test for `InMemoryStore` — store contract (Property 1)
    - **Property 1: Store contract — increment and getCount return valid shape**
    - **Validates: Requirements 1.1, 1.2, 1.4**
    - File: `src/redis/rateLimitStore.test.ts`
    - Use `fc.string()`, `fc.integer({ min: 1000 })`, `fc.integer({ min: 1 })`

  - [x] 2.3 Implement `SlidingWindowStore` using IORedis sorted-set pipeline
    - Constructor accepts a `RedisClient` instance (matching `RedisDedupCache` pattern in `dedup.ts`)
    - `increment`: pipeline of ZADD NX, ZREMRANGEBYSCORE, ZCARD, PEXPIRE in a single `multi()` call
    - Member format: `{timestampMs}-{6-char random hex}`
    - Key format: `fluxora:rl:{identifierType}:{sanitisedIdentifier}:{routeKey}`
    - `getCount`: single ZCOUNT (read-only, no pipeline)
    - Sanitise identifier: replace chars outside `[A-Za-z0-9._-]` with `_`, truncate to 256 chars
    - Maintain a `closed` boolean flag; throw `'SlidingWindowStore is closed'` if called after `close()`
    - `close()` calls `this.client.close()`
    - Extend `RedisClient` interface in `src/redis/client.ts` to expose `pipeline()` / `multi()` and `zcount()` as needed
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 8.1, 8.2, 10.1, 10.3_

  - [ ]* 2.4 Write property tests for `SlidingWindowStore` (Properties 2, 3, 4, 10, 13, 14, 17)
    - **Property 2: Round-trip count** — `fc.string()`, `fc.integer({ min: 1, max: 20 })`
    - **Property 3: Redis key format** — `fc.string()`, `fc.constantFrom('ip', 'apikey')`
    - **Property 4: getCount is read-only** — `fc.string()`, `fc.integer({ min: 1000 })`
    - **Property 10: Shared connection produces combined count** — `fc.integer({ min: 1, max: 10 })`
    - **Property 13: Identifier sanitisation** — `fc.string()` (full unicode)
    - **Property 14: API key hashing — raw key never in Redis key** — `fc.string()`
    - **Property 17: Calls after close() are rejected** — `fc.constantFrom('increment', 'getCount')`
    - **Validates: Requirements 2.4, 2.5, 2.6, 5.1, 5.2, 5.3, 6.1, 8.1, 8.2, 8.3, 10.3, 11.1, 11.2**
    - File: `src/redis/rateLimitStore.test.ts`
    - Use `FakeRedisClient` (created in task 3)

  - [x] 2.5 Implement `HybridStore`
    - Constructor: `(primary: RateLimitStore, fallback: RateLimitStore, onError: (err: unknown, op: string) => void)`
    - Wrap primary calls in try/catch; on error call `onError`, then delegate to fallback
    - Track `usingFallback` boolean so callers can read which backend was used
    - `close()` closes both primary and fallback
    - _Requirements: 3.1, 3.2, 3.3, 3.5_

  - [ ]* 2.6 Write property test for `HybridStore` fallback behaviour (Property 5)
    - **Property 5: Fallback on Redis error**
    - **Validates: Requirements 3.1, 3.5**
    - File: `src/redis/rateLimitStore.test.ts`

  - [ ]* 2.7 Write property test for `rate_limit_redis_errors_total` counter (Property 16)
    - **Property 16: rate_limit_redis_errors_total incremented on every Redis error**
    - **Validates: Requirements 9.4**
    - File: `src/redis/rateLimitStore.test.ts`

- [x] 3. Create `src/redis/__test__/fakeRedisClient.ts` — `FakeRedisClient` test double
  - Implement `RedisClient` interface backed by an in-process sorted-set simulation (plain `Map`)
  - Support `zadd`, `zremrangebyscore`, `zcard`, `pexpire`, `zcount` operations needed by `SlidingWindowStore`
  - Expose a `throwOnNext(op: string)` helper to simulate Redis errors in property tests
  - _Requirements: 2.7 (testability)_

- [x] 4. Add Prometheus counters to `src/metrics.ts`
  - Add `rateLimitRejectedTotal` counter with labels `['identifier_type', 'route']`
  - Add `rateLimitRedisErrorsTotal` counter with labels `['operation']`
  - Register both on the existing `registry`
  - _Requirements: 9.3, 9.4_

- [x] 5. Update `src/middleware/rateLimiter.ts` to delegate to `RateLimitStore`
  - [x] 5.1 Update `RateLimiter` interface: add `store: RateLimitStore` and `close(): Promise<void>` properties; make `getStatus` async
    - _Requirements: 1.3, 10.2_

  - [x] 5.2 Update `createRateLimiter` factory signature to accept optional `store?: RateLimitStore`
    - When `store` is not provided and `REDIS_ENABLED !== 'false'`: build `SlidingWindowStore` + `InMemoryStore` + `HybridStore`
    - When `REDIS_ENABLED === 'false'` or Redis client creation fails: use plain `InMemoryStore`, log a `warn`
    - _Requirements: 3.4, 3.5_

  - [x] 5.3 Replace inline counter maps with `store.increment` calls in the request handler
    - Hash API key identifiers with SHA-256 before passing to the store (raw key must not reach Redis)
    - Set `X-RateLimit-Store: redis` or `X-RateLimit-Store: memory` based on `HybridStore.usingFallback`
    - Emit structured `warn` log on 429 (identifier masked, route, method, limit, window)
    - Increment `rateLimitRejectedTotal` on every 429
    - _Requirements: 3.2, 3.3, 8.3, 9.1, 9.3_

  - [x] 5.4 Update `getStatus` to call `store.getCount` (now async)
    - _Requirements: 7.1, 7.2_

  - [ ]* 5.5 Write property tests for middleware header behaviour (Properties 6, 7, 8, 9, 11, 12, 15)
    - **Property 6: Rate-limit headers present on every non-exempt response** — `fc.string()`, `fc.webUrl()`
    - **Property 7: X-RateLimit-Remaining equals max(0, limit − count)** — `fc.integer({ min: 0 })`, `fc.integer({ min: 1 })`
    - **Property 8: X-RateLimit-Reset is a valid future Unix timestamp** — `fc.string()`
    - **Property 9: 429 response includes Retry-After header** — `fc.integer({ min: 1 })`
    - **Property 11: Route isolation** — `fc.string()`, route pairs
    - **Property 12: Route-specific and write-method limits applied correctly** — `fc.constantFrom(...ROUTE_BUDGETS)`
    - **Property 15: rate_limit_rejected_total incremented on every 429** — `fc.integer({ min: 1 })`
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 6.2, 6.3, 6.4, 9.3**
    - File: `src/middleware/rateLimiter.test.ts`

- [x] 6. Checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Update `src/routes/rateLimits.ts` to query live store counters
  - Make the `GET /` handler async; call `await limiter.store.getCount(key, windowMs)` for the live count
  - Hash API key before calling `getCount` (consistent with middleware)
  - Include `degraded: true` in the response body when `HybridStore.usingFallback` is true
  - _Requirements: 7.1, 7.2, 7.3_

- [x] 8. Register shutdown hook for `store.close()` in `src/index.ts`
  - Call `addShutdownHook(() => limiter.close())` after `createRateLimiter` returns
  - _Requirements: 10.1, 10.2_

- [x] 9. Write integration and unit tests in `tests/middleware/rateLimit.redis.test.ts`
  - Test `SlidingWindowStore` with `FakeRedisClient` — increment N times, assert `getCount` returns N
  - Test `HybridStore` with a mock primary that throws — assert fallback is used and error counter incremented
  - Test `createRateLimiter` with `REDIS_ENABLED=false` — assert no Redis client is created
  - Test `GET /api/rate-limits` with a mock store — assert `degraded: true` when fallback is active
  - Test shutdown hook — assert `store.close()` is called when `gracefulShutdown` runs
  - Test header values on allowed and rejected requests using `supertest`
  - _Requirements: 3.4, 7.3, 10.2_

- [x] 10. Add documentation in `docs/rate-limiting.md`
  - Document the `RateLimitStore` interface and the three implementations
  - Document environment variables (`REDIS_ENABLED`, `REDIS_URL`, `RATE_LIMIT_*`)
  - Document Redis key format and sorted-set member format
  - Document fallback behaviour and the `X-RateLimit-Store` header
  - Document the `degraded` field in `GET /api/rate-limits` responses
  - _Requirements: 2.4, 3.2, 3.3, 3.4, 7.3_

- [x] 11. Final checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Property tests use **fast-check** (add as a dev dependency: `pnpm add -D fast-check`)
- Each property test must include a comment: `// Feature: redis-sliding-window-rate-limiter, Property N: <text>`
- Each property test runs a minimum of 100 iterations
- `FakeRedisClient` (task 3) must be created before property tests in task 2.4 can run
- The `RedisClient` interface in `src/redis/client.ts` needs sorted-set method additions to support `SlidingWindowStore`
- `getStatus` becomes async — update all call sites in `src/routes/rateLimits.ts` accordingly
