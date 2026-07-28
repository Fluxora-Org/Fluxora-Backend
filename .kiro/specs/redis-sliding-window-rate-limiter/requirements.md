# Requirements Document

## Introduction

The current in-memory rate limiter in `src/middleware/rateLimiter.ts` maintains per-process counters that reset on restart and are not shared across Node.js replicas. In a horizontally-scaled cluster, each replica enforces its own limit independently, effectively multiplying the allowed request rate by the replica count. This feature replaces the in-memory counter store with a Redis-backed sliding-window implementation using sorted sets, enforcing a single cluster-wide limit regardless of replica count.

## Glossary

- **RateLimitStore**: The interface that abstracts counter storage, implemented by both the in-memory and Redis backends.
- **SlidingWindowStore**: The Redis implementation of `RateLimitStore` using a sorted-set pipeline (ZADD + ZREMRANGEBYSCORE + ZCARD).
- **InMemoryStore**: The existing in-memory implementation of `RateLimitStore`, retained as a fallback.
- **RateLimiter**: The Express middleware (`src/middleware/rateLimiter.ts`) that enforces per-client request limits.
- **RedisClient**: The IORedis wrapper defined in `src/redis/client.ts`.
- **Identifier**: A string that uniquely identifies a client — either an IP address or an API key.
- **Window**: The rolling time interval (in milliseconds) within which requests are counted.
- **Limit**: The maximum number of requests permitted per Identifier within a Window.
- **X-RateLimit-Limit**: HTTP response header reporting the configured Limit for the current request.
- **X-RateLimit-Remaining**: HTTP response header reporting how many requests remain in the current Window.
- **X-RateLimit-Reset**: HTTP response header reporting the Unix timestamp (seconds) at which the Window resets.
- **Retry-After**: HTTP response header reporting the number of seconds the client must wait before retrying after a 429 response.
- **Pipeline**: An IORedis multi-command batch executed atomically in a single round-trip.
- **Fallback**: Automatic degradation to the InMemoryStore when Redis is unavailable.

---

## Requirements

### Requirement 1: Sliding-Window Store Interface

**User Story:** As a backend engineer, I want a well-defined storage interface for rate-limit counters, so that the Redis and in-memory implementations are interchangeable and testable in isolation.

#### Acceptance Criteria

1. THE RateLimitStore SHALL expose an `increment(key: string, windowMs: number, limit: number): Promise<{ count: number; resetAt: number }>` method.
2. THE RateLimitStore SHALL expose a `getCount(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>` method that returns the current count without incrementing.
3. THE RateLimitStore SHALL expose a `close(): Promise<void>` method for graceful shutdown.
4. WHEN `increment` is called, THE RateLimitStore SHALL return the updated count and the Unix timestamp (milliseconds) at which the current window expires.
5. WHEN `getCount` is called, THE RateLimitStore SHALL return the current count and the window expiry timestamp without modifying any stored state.

---

### Requirement 2: Redis Sliding-Window Implementation

**User Story:** As a platform operator, I want rate-limit counters stored in Redis using a sliding window, so that all replicas share a single consistent view of each client's request count.

#### Acceptance Criteria

1. THE SlidingWindowStore SHALL implement the `RateLimitStore` interface.
2. WHEN `increment` is called with a key and window, THE SlidingWindowStore SHALL execute a Redis Pipeline containing: ZADD (add current timestamp as score and member), ZREMRANGEBYSCORE (remove members older than `now - windowMs`), ZCARD (count remaining members), and PEXPIRE (set TTL equal to `windowMs`).
3. WHEN the Pipeline executes, THE SlidingWindowStore SHALL perform all four commands in a single round-trip to Redis.
4. THE SlidingWindowStore SHALL namespace all Redis keys with the prefix `fluxora:rl:` to avoid collisions with other keys.
5. WHEN `increment` is called, THE SlidingWindowStore SHALL use the current high-resolution timestamp (milliseconds) as both the sorted-set score and the unique member suffix to prevent member collisions within the same millisecond.
6. WHEN `getCount` is called, THE SlidingWindowStore SHALL execute ZCOUNT to read the current window count without writing to Redis.
7. THE SlidingWindowStore SHALL accept a `RedisClient` instance via constructor injection to enable test doubles.

---

### Requirement 3: Fallback to In-Memory Store on Redis Failure

**User Story:** As a platform operator, I want the rate limiter to degrade gracefully when Redis is unavailable, so that the service continues to function rather than rejecting all requests.

#### Acceptance Criteria

1. WHEN a Redis operation throws an error, THE RateLimiter SHALL catch the error, log a warning, and delegate the increment to the InMemoryStore for that request.
2. WHEN operating in fallback mode, THE RateLimiter SHALL add a `X-RateLimit-Store: memory` response header to indicate degraded operation.
3. WHEN Redis is available, THE RateLimiter SHALL add a `X-RateLimit-Store: redis` response header.
4. IF the `REDIS_ENABLED` environment variable is set to `false`, THEN THE RateLimiter SHALL use the InMemoryStore exclusively without attempting to connect to Redis.
5. THE RateLimiter SHALL not propagate Redis errors to the Express error handler; all Redis errors SHALL be handled internally.

---

### Requirement 4: Rate-Limit Headers on Every Response

**User Story:** As an API consumer, I want rate-limit headers on every response, so that I can implement client-side throttling and avoid unexpected 429 errors.

#### Acceptance Criteria

1. THE RateLimiter SHALL set the `X-RateLimit-Limit` header to the effective limit for the current request on every non-exempt response.
2. THE RateLimiter SHALL set the `X-RateLimit-Remaining` header to `max(0, limit - count)` on every non-exempt response.
3. THE RateLimiter SHALL set the `X-RateLimit-Reset` header to the Unix timestamp in seconds at which the current window expires on every non-exempt response.
4. WHEN a request is rejected with HTTP 429, THE RateLimiter SHALL also set the `Retry-After` header to the number of whole seconds until the window resets.
5. THE RateLimiter SHALL set all four headers before calling `next()` or sending a 429 response, so that downstream middleware and error handlers can read them.

---

### Requirement 5: Cluster-Wide Limit Enforcement

**User Story:** As a platform operator, I want rate limits enforced across all replicas, so that a client cannot exceed the configured limit by distributing requests across instances.

#### Acceptance Criteria

1. WHEN multiple RateLimiter instances share the same Redis connection, THE SlidingWindowStore SHALL produce a combined count that reflects requests from all instances.
2. WHEN a client sends N requests concurrently to different replicas, THE SlidingWindowStore SHALL count all N requests against the same Identifier key.
3. THE SlidingWindowStore SHALL use the same key-construction logic as the RateLimiter middleware to ensure all replicas write to the same Redis key for the same Identifier.

---

### Requirement 6: Per-Route and Per-Identifier Key Isolation

**User Story:** As a platform operator, I want rate-limit counters scoped to both the client identifier and the route budget, so that exhausting one route's limit does not affect other routes.

#### Acceptance Criteria

1. THE SlidingWindowStore SHALL construct Redis keys in the format `fluxora:rl:{identifierType}:{identifier}:{routeKey}` where `routeKey` is derived from the route path.
2. WHEN a client exhausts the limit for one route, THE RateLimiter SHALL continue to allow requests from the same client to other routes that have remaining capacity.
3. THE RateLimiter SHALL apply route-specific limits (from `ROUTE_BUDGETS`) when a matching route configuration exists, falling back to the global limit otherwise.
4. THE RateLimiter SHALL apply write-method limits (POST, PUT, PATCH, DELETE) when a `writeLimit` is configured for the matched route.

---

### Requirement 7: GET /api/rate-limits Reflects Redis Counters

**User Story:** As an API consumer, I want the `GET /api/rate-limits` endpoint to report accurate cluster-wide counts, so that the status I receive reflects the true remaining capacity.

#### Acceptance Criteria

1. WHEN `GET /api/rate-limits` is called, THE RateLimiter SHALL query the SlidingWindowStore for the current count for the requesting client's Identifier.
2. THE RateLimits route handler SHALL return `remaining` values computed from the live Redis count, not from a local in-memory snapshot.
3. WHEN Redis is unavailable, THE RateLimits route handler SHALL return counts from the InMemoryStore fallback and include a `degraded: true` field in the response body.

---

### Requirement 8: Security — Key Sanitisation

**User Story:** As a security engineer, I want Redis keys to be sanitised before use, so that a malicious client cannot inject arbitrary Redis key patterns via the `x-api-key` header or IP address.

#### Acceptance Criteria

1. THE SlidingWindowStore SHALL sanitise the Identifier by replacing any character outside `[A-Za-z0-9._-]` with an underscore before constructing the Redis key.
2. THE SlidingWindowStore SHALL truncate the sanitised Identifier to a maximum of 256 characters before constructing the Redis key.
3. THE RateLimiter SHALL hash API key identifiers using SHA-256 before passing them to the SlidingWindowStore, so that raw API key material is never written to Redis.

---

### Requirement 9: Observability — Metrics and Logging

**User Story:** As a platform operator, I want rate-limit events logged and metered, so that I can detect abuse and capacity issues without inspecting individual requests.

#### Acceptance Criteria

1. WHEN a request is rejected with HTTP 429, THE RateLimiter SHALL emit a structured log entry at `warn` level containing: identifier (masked), route, method, limit, and window.
2. WHEN a Redis error triggers fallback, THE RateLimiter SHALL emit a structured log entry at `warn` level containing the error message and the affected key prefix.
3. THE RateLimiter SHALL increment a Prometheus counter `rate_limit_rejected_total` with labels `{identifier_type, route}` for every 429 response.
4. THE RateLimiter SHALL increment a Prometheus counter `rate_limit_redis_errors_total` with label `{operation}` for every Redis error that triggers fallback.

---

### Requirement 10: Graceful Shutdown

**User Story:** As a platform operator, I want the Redis connection used by the rate limiter to close cleanly on shutdown, so that in-flight pipelines complete and no connections are leaked.

#### Acceptance Criteria

1. THE SlidingWindowStore SHALL expose a `close()` method that calls `RedisClient.close()`.
2. WHEN the application receives a shutdown signal, THE RateLimiter SHALL call `SlidingWindowStore.close()` before the process exits.
3. WHEN `close()` is called, THE SlidingWindowStore SHALL not accept new `increment` or `getCount` calls; IF such a call is made after `close()`, THEN THE SlidingWindowStore SHALL reject the call with an error.

---

### Requirement 11: Round-Trip Serialisation of Rate-Limit State

**User Story:** As a developer, I want the rate-limit state written to and read from Redis to be consistent, so that a count written by one replica is correctly interpreted by all other replicas.

#### Acceptance Criteria

1. FOR ALL valid Identifier and window combinations, a count written by `SlidingWindowStore.increment` SHALL be correctly read back by `SlidingWindowStore.getCount` on the same or a different instance sharing the same Redis connection (round-trip property).
2. WHEN the same Identifier increments N times within a window, `SlidingWindowStore.getCount` SHALL return a count of N.
3. WHEN the window expires, `SlidingWindowStore.getCount` SHALL return a count of 0 for the expired Identifier.
