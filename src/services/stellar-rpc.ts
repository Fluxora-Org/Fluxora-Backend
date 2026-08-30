/**
 * Stellar RPC service with circuit breaker, AbortController-based cancellation,
 * and structured failure classification.
 *
 * Circuit breaker states:
 *   CLOSED   — normal operation; calls pass through
 *   OPEN     — tripped; calls fail immediately without hitting the RPC
 *   HALF_OPEN — one probe call allowed to test recovery
 *
 * Trips when: failureCount >= failureThreshold within windowMs.
 * Resets after: resetTimeoutMs of being OPEN.
 *
 * Failure kinds:
 *   TIMEOUT      — call exceeded timeoutMs
 *   NETWORK      — connection-level error (ECONNREFUSED, ENOTFOUND, etc.)
 *   PROVIDER     — RPC returned an error response (4xx/5xx)
 *   CIRCUIT_OPEN — breaker is OPEN; call was not attempted
 *   CANCELLED    — caller aborted via AbortSignal
 */

import { AsyncLocalStorage } from 'async_hooks';
import { logger } from '../lib/logger.js';
import { recordCircuitBreakerTransition } from '../tracing/hooks.js';
import { getActiveTraceContext, buildTraceparent } from '../tracing/middleware.js';
import {
  NoOpRpcFallbackCache,
  RedisRpcFallbackCache,
  hashCachePart,
  type RpcFallbackCache,
  type RpcFallbackCacheEntry,
} from '../redis/rpcFallbackCache.js';
import { createRedisClient } from '../redis/client.js';
import {
  rpcCircuitOpenFallbackHitsTotal,
  rpcCircuitOpenFallbackMissesTotal,
  rpcFallbackCacheEarlyRefreshesTotal,
  rpcFallbackCacheHitsTotal,
  rpcFallbackCacheMissesTotal,
  rpcProviderHealthyGauge,
  rpcProviderHealthCheckFailuresTotal,
} from '../metrics/rpcMetrics.js';
import { withJitteredRetry } from '../lib/retry.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Structured classification of every RPC failure. */
export type RpcFailureKind = 'TIMEOUT' | 'NETWORK' | 'PROVIDER' | 'CIRCUIT_OPEN' | 'CANCELLED';

export interface CircuitBreakerOptions {
  /** Number of failures within windowMs that trips the breaker. Default 5. */
  failureThreshold?: number;
  /** Rolling window for counting failures, ms. Default 30_000. */
  windowMs?: number;
  /** How long to stay OPEN before allowing a probe, ms. Default 60_000. */
  resetTimeoutMs?: number;
}

export interface RpcCallOptions {
  /** Timeout for a single RPC call, ms. Default 5_000. */
  timeoutMs?: number;
  /** Optional AbortSignal to cancel the call externally. */
  signal?: AbortSignal;
  /** Max retries for RPC calls. Default 3. */
  maxRetries?: number;
  /** Base delay for retries. Default 1000ms. */
  retryDelayMs?: number;
}

export interface StellarRpcServiceOptions extends CircuitBreakerOptions, RpcCallOptions {
  /** TTL for last-known-good fallback entries, seconds. Default 300. */
  fallbackCacheTtlSeconds?: number;
  /** Optional cache injection for tests or alternate Redis lifecycle ownership. */
  fallbackCache?: RpcFallbackCache;
  /** XFetch-style beta factor. Set to 0 to disable early-expiry reads. */
  fallbackCacheEarlyExpiryBeta?: number;
  /** Interval (ms) for the background provider health-check loop. 0 disables it. */
  healthCheckIntervalMs?: number;
  /** Consecutive health-check failures before the provider is marked unhealthy. */
  healthCheckFailureThreshold?: number;
  /** Stable provider label for metrics (default "primary"). */
  providerLabel?: string;
  /**
   * Per-operation timeout overrides, in milliseconds. Keys are operation names
   * (e.g. `"getLatestLedger"`, `"accountExists"`). When an operation is listed
   * here its deadline takes precedence over the global `timeoutMs`. Callers can
   * still override on a per-call basis via `RpcCallOptions.timeoutMs`.
   *
   * Example:
   * ```ts
   * operationDeadlines: {
   *   getLatestLedger: 2_000,  // fast — used by health checks
   *   accountExists:   8_000,  // generous — Horizon lookup
   * }
   * ```
   */
  operationDeadlines?: Record<string, number>;
}

interface RpcRequestMetadata {
  cacheStatus?: 'stale';
}

const rpcRequestMetadata = new AsyncLocalStorage<RpcRequestMetadata>();

export function runWithRpcRequestMetadata<T>(fn: () => T): T {
  return rpcRequestMetadata.run({}, fn);
}

export function getRpcRequestCacheStatus(): 'stale' | undefined {
  return rpcRequestMetadata.getStore()?.cacheStatus;
}

function markStaleRpcCacheResponse(): void {
  const store = rpcRequestMetadata.getStore();
  if (store) {
    store.cacheStatus = 'stale';
  }
}

export class RpcProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: RpcFailureKind,
    public readonly statusCode?: number,
    public readonly durationMs?: number,
  ) {
    super(message);
    this.name = 'RpcProviderError';
  }
}

export class CircuitOpenError extends Error {
  public readonly kind: RpcFailureKind = 'CIRCUIT_OPEN';
  constructor() {
    super('Stellar RPC circuit breaker is OPEN — calls suspended during cool-off period');
    this.name = 'CircuitOpenError';
  }
}

// ── Failure classifier ────────────────────────────────────────────────────────

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED',
]);

function classifyError(err: unknown): RpcFailureKind {
  if (err instanceof RpcProviderError) return err.kind;
  if (err instanceof CircuitOpenError) return 'CIRCUIT_OPEN';

  const code = (err as { code?: string }).code;
  if (code && NETWORK_ERROR_CODES.has(code)) return 'NETWORK';

  const status = (err as { statusCode?: number; status?: number }).statusCode
    ?? (err as { status?: number }).status;
  if (status !== undefined) return 'PROVIDER';

  const message = err instanceof Error ? err.message : String(err);
  if (/timed? ?out/i.test(message)) return 'TIMEOUT';
  if (/network|connection|socket/i.test(message)) return 'NETWORK';

  return 'PROVIDER';
}

/**
 * Retryable-status classification for errors already raised as
 * {@link RpcProviderError} by our own call sites (e.g. the config-validation
 * and HTTP-status checks inside `accountExists`).
 *
 * Retries must not paper over permanent errors, and permanent errors must
 * not pay the full jittered-backoff delay before surfacing. Only failures
 * that are plausibly transient are retried:
 *
 *   - TIMEOUT / NETWORK          — connection-level hiccups, safe to retry.
 *   - PROVIDER with status 429   — rate limited; retry with backoff.
 *   - PROVIDER with status >=500 — upstream server error; retry.
 *   - everything else            — permanent: a 4xx client/request error, a
 *     malformed response, or a config error (e.g. a missing horizonUrl) —
 *     and is surfaced immediately without consuming retry budget.
 *
 * `getLatestLedger` and `accountExists` are both read-only, idempotent
 * operations, so retrying them carries no duplicate-submission risk — this
 * only needs to decide whether a retry can plausibly *succeed*, not whether
 * it is safe to attempt.
 *
 * Errors that have not yet been classified into an `RpcProviderError` (i.e.
 * raw transport errors thrown directly by a `RawRpcClient` implementation)
 * are intentionally left to the outer per-call timeout/classification in
 * {@link StellarRpcService.callWithTimeout} rather than retried here, so a
 * single call's overall timeout budget cannot be silently multiplied by
 * per-attempt backoff sleeps.
 */
export function isRetryableRpcError(err: unknown): boolean {
  if (!(err instanceof RpcProviderError)) return false;
  if (err.kind === 'TIMEOUT' || err.kind === 'NETWORK') return true;
  if (err.kind !== 'PROVIDER') return false;

  if (err.statusCode === 429) return true;
  if (err.statusCode !== undefined && err.statusCode >= 500) return true;
  return false;
}

// ── Circuit breaker ───────────────────────────────────────────────────────────

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures: number[] = []; // timestamps of recent failures
  private openedAt = 0;

  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly resetTimeoutMs: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.windowMs = opts.windowMs ?? 30_000;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 60_000;
  }

  getState(): CircuitState { return this.state; }

  /** Number of failures currently in the rolling window. */
  getFailureCount(): number {
    this.evictOldFailures();
    return this.failures.length;
  }

  /** Epoch ms when the breaker last tripped to OPEN, or 0 if never. */
  getOpenedAt(): number { return this.openedAt; }

  /** Execute fn through the breaker. Throws CircuitOpenError if OPEN. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.evictOldFailures();

    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        // OPEN → HALF_OPEN: probe window has elapsed
        recordCircuitBreakerTransition('OPEN', 'HALF_OPEN', this.failures.length);
        this.state = 'HALF_OPEN';
      } else {
        throw new CircuitOpenError();
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    const prev = this.state;
    this.failures = [];
    this.state = 'CLOSED';
    // Only emit when there is an actual state change (HALF_OPEN → CLOSED recovery).
    // Steady-state CLOSED successes produce no event.
    if (prev !== 'CLOSED') {
      recordCircuitBreakerTransition(prev, 'CLOSED', 0);
    }
  }

  private onFailure(err?: unknown): void {
    this.failures.push(Date.now());
    if (this.failures.length >= this.failureThreshold) {
      const prev = this.state;
      this.state = 'OPEN';
      this.openedAt = Date.now();
      logger.warn('Stellar RPC circuit breaker tripped', undefined, {
        event: 'circuit_open',
        failureCount: this.failures.length,
        windowMs: this.windowMs,
      });
      // CLOSED → OPEN or HALF_OPEN → OPEN
      const failureKind = err !== undefined ? classifyError(err) : undefined;
      recordCircuitBreakerTransition(prev, 'OPEN', this.failures.length, failureKind);
    }
  }

  private evictOldFailures(): void {
    const cutoff = Date.now() - this.windowMs;
    this.failures = this.failures.filter((t) => t >= cutoff);
  }

  /** Reset to CLOSED (for testing / manual recovery). */
  reset(): void {
    this.state = 'CLOSED';
    this.failures = [];
    this.openedAt = 0;
  }
}

// ── RPC client wrapper ────────────────────────────────────────────────────────

export interface RawRpcClient {
  getLatestLedger(): Promise<{ sequence: number }>;
  /** Horizon base URL used for account existence checks. */
  horizonUrl?: string;
}

export class StellarRpcService {
  private readonly breaker: CircuitBreaker;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly operationDeadlines: Record<string, number>;
  private readonly fallbackCache: RpcFallbackCache;
  private readonly fallbackCacheTtlSeconds: number;
  private readonly fallbackCacheEarlyExpiryBeta: number;
  private readonly earlyRefreshes = new Map<string, Promise<void>>();

  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private healthy = true;
  private lastHealthyAt: number | null = null;
  private lastHealthError: string | null = null;
  private consecutiveHealthFailures = 0;
  private readonly healthCheckIntervalMs: number;
  private readonly healthCheckFailureThreshold: number;
  private readonly providerLabel: string;

  constructor(
    private readonly getClient: () => RawRpcClient,
    opts: StellarRpcServiceOptions = {},
  ) {
    this.breaker = new CircuitBreaker(opts);
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 1_000;
    this.operationDeadlines = opts.operationDeadlines ?? {};
    this.fallbackCache = opts.fallbackCache ?? new NoOpRpcFallbackCache();
    this.fallbackCacheTtlSeconds = opts.fallbackCacheTtlSeconds ?? 300;
    this.fallbackCacheEarlyExpiryBeta = Math.max(0, opts.fallbackCacheEarlyExpiryBeta ?? 0);
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 0;
    this.healthCheckFailureThreshold = Math.max(1, opts.healthCheckFailureThreshold ?? 3);
    this.providerLabel = opts.providerLabel ?? 'primary';
  }

  getCircuitState(): CircuitState { return this.breaker.getState(); }

  /** Reset the circuit breaker (manual recovery). */
  resetCircuit(): void { this.breaker.reset(); }

  /**
   * Snapshot of the background health-check posture, consumed by callers and
   * the health endpoint to decide whether the provider should be used.
   */
  getProviderHealth(): {
    healthy: boolean;
    lastHealthyAt: number | null;
    lastError: string | null;
    consecutiveFailures: number;
  } {
    return {
      healthy: this.healthy,
      lastHealthyAt: this.lastHealthyAt,
      lastError: this.lastHealthError,
      consecutiveFailures: this.consecutiveHealthFailures,
    };
  }

  isProviderHealthy(): boolean {
    return this.healthy;
  }

  /**
   * Start the background health-check loop. Every `healthCheckIntervalMs` the
   * service pings `getLatestLedger` directly (bypassing the cache and circuit
   * breaker so an OPEN breaker does not mask provider recovery). After
   * `healthCheckFailureThreshold` consecutive failures the provider is marked
   * unhealthy; a single successful ping flips it back to healthy. Passing 0
   * (the default) disables the loop.
   */
  startHealthCheck(intervalMs: number = this.healthCheckIntervalMs): void {
    this.stopHealthCheck();
    if (intervalMs <= 0) return;

    const tick = async (): Promise<void> => {
      try {
        await this.getClient().getLatestLedger();
        this.consecutiveHealthFailures = 0;
        this.healthy = true;
        this.lastHealthyAt = Date.now();
        this.lastHealthError = null;
        rpcProviderHealthyGauge.set({ provider: this.providerLabel }, 1);
      } catch (err) {
        this.consecutiveHealthFailures += 1;
        this.lastHealthError = err instanceof Error ? err.message : String(err);
        const kind = classifyError(err);
        rpcProviderHealthCheckFailuresTotal.inc({ provider: this.providerLabel, reason: kind });
        if (this.consecutiveHealthFailures >= this.healthCheckFailureThreshold) {
          if (this.healthy) {
            logger.warn('Stellar RPC provider marked unhealthy by health check', undefined, {
              event: 'rpc_provider_unhealthy',
              consecutiveFailures: this.consecutiveHealthFailures,
              error: this.lastHealthError,
            });
          }
          this.healthy = false;
          rpcProviderHealthyGauge.set({ provider: this.providerLabel }, 0);
        }
      }
    };

    // Probe once immediately so health is known without waiting a full interval.
    void tick();
    this.healthCheckTimer = setInterval(() => void tick(), intervalMs);
  }

  /** Stop the background health-check loop, if running. */
  stopHealthCheck(): void {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Snapshot of the current degradation posture, consumed by the
   * `rpcDegradationMiddleware` to decide whether requests should be served
   * normally, with a staleness warning, or rejected outright.
   */
  getDegradationSnapshot(): {
    circuitState: CircuitState;
    degraded: boolean;
    failureCount: number;
    openedAt: number | null;
    timestamp: string;
  } {
    const circuitState = this.breaker.getState();
    const openedAtRaw = this.breaker.getOpenedAt();
    return {
      circuitState,
      degraded: circuitState !== 'CLOSED',
      failureCount: this.breaker.getFailureCount(),
      // Surface 0 as `null` so callers can use `openedAt != null` as a
      // "circuit has ever been open" predicate.
      openedAt: openedAtRaw === 0 ? null : openedAtRaw,
      timestamp: new Date().toISOString(),
    };
  }

  async getLatestLedger(opts: RpcCallOptions = {}): Promise<{ sequence: number }> {
    return this.callWithFallbackCache(
      'getLatestLedger',
      [],
      () => withJitteredRetry(
        () => this.getClient().getLatestLedger(),
        {
          baseDelayMs: this.retryDelayMs,
          maxDelayMs: this.retryDelayMs * 5,
          maxAttempts: this.maxRetries + 1,
        },
        isRetryableRpcError
      ),
      opts,
    );
  }

  /**
   * Check whether a Stellar account exists on-chain via the Horizon REST API.
   *
   * Returns true if the account is found (HTTP 200), false if not found
   * (HTTP 404). Any other error (network, timeout, circuit open) is re-thrown
   * so callers can decide whether to fail-open or fail-closed.
   *
   * Security note: the address is URL-encoded before interpolation to prevent
   * path traversal via crafted key values.
   */
  async accountExists(address: string, opts: RpcCallOptions = {}): Promise<boolean> {
    return this.callWithFallbackCache(
      'accountExists',
      [hashCachePart(address)],
      () => withJitteredRetry(
        async () => {
          const client = this.getClient();
          const base = (client.horizonUrl ?? '').replace(/\/$/, '');
          if (!base) {
            throw new RpcProviderError('horizonUrl not configured on RPC client', 'PROVIDER');
          }
          const url = `${base}/accounts/${encodeURIComponent(address)}`;
          // Attach outbound W3C traceparent so Stellar RPC / Horizon can
          // continue the distributed trace.  The header is only added when an
          // active trace context exists in the current async scope.
          const rpcHeaders: Record<string, string> = {};
          const activeTrace = getActiveTraceContext();
          if (activeTrace) {
            // Outbound parent ID = upstream parentId so the outbound span
            // shares the same parent as this service's span.
            rpcHeaders['traceparent'] = buildTraceparent(
              activeTrace.traceId,
              activeTrace.parentId,
              activeTrace.sampled,
            );
          }
          const res = await fetch(url, {
            signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
            headers: rpcHeaders,
          });          if (res.status === 200) return true;
          if (res.status === 404) return false;
          throw new RpcProviderError(
            `Horizon returned HTTP ${res.status} for account lookup`,
            'PROVIDER',
            res.status,
          );
        },
        {
          baseDelayMs: this.retryDelayMs,
          maxDelayMs: this.retryDelayMs * 5,
          maxAttempts: this.maxRetries + 1,
        },
        isRetryableRpcError
      ),
      opts,
    );
  }

  private async callWithFallbackCache<T>(
    operation: string,
    cacheParts: readonly string[],
    fn: () => Promise<T>,
    opts: RpcCallOptions = {},
  ): Promise<T> {
    if (this.breaker.getState() === 'CLOSED' && this.fallbackCacheEarlyExpiryBeta > 0) {
      const cached = await this.getClosedCircuitCacheEntry<T>(operation, cacheParts);
      if (cached !== null) {
        rpcFallbackCacheHitsTotal.inc({ operation });
        if (shouldEarlyRefresh(cached, this.fallbackCacheEarlyExpiryBeta)) {
          this.startEarlyRefresh(operation, cacheParts, fn, opts);
        }
        return cached.value;
      }
      rpcFallbackCacheMissesTotal.inc({ operation });
    }

    try {
      const refreshStartedAt = Date.now();
      const result = await this.breaker.call(() => this.callWithTimeout(fn, operation, opts));
      await this.writeFallbackCache(operation, result, cacheParts, Date.now() - refreshStartedAt);
      return result;
    } catch (err) {
      if (!(err instanceof CircuitOpenError)) {
        throw err;
      }

      const cached = await this.fallbackCache.get<T>(operation, cacheParts);
      if (cached !== null) {
        markStaleRpcCacheResponse();
        rpcCircuitOpenFallbackHitsTotal.inc({ operation });
        logger.warn('Serving Stellar RPC response from stale fallback cache', undefined, {
          event: 'rpc_circuit_open_fallback_hit',
          operation,
        });
        return cached;
      }

      rpcCircuitOpenFallbackMissesTotal.inc({ operation });
      logger.warn('Stellar RPC fallback cache miss while circuit is OPEN', undefined, {
        event: 'rpc_circuit_open_fallback_miss',
        operation,
      });
      throw err;
    }
  }

  private async getClosedCircuitCacheEntry<T>(
    operation: string,
    cacheParts: readonly string[],
  ): Promise<RpcFallbackCacheEntry<T> | null> {
    if (!this.fallbackCache.getEntry) return null;
    return this.fallbackCache.getEntry<T>(operation, cacheParts);
  }

  private startEarlyRefresh<T>(
    operation: string,
    cacheParts: readonly string[],
    fn: () => Promise<T>,
    opts: RpcCallOptions,
  ): void {
    const refreshKey = buildRefreshKey(operation, cacheParts);
    if (this.earlyRefreshes.has(refreshKey)) return;

    rpcFallbackCacheEarlyRefreshesTotal.inc({ operation });
    const refreshStartedAt = Date.now();
    const refresh = this.breaker.call(() => this.callWithTimeout(fn, operation, opts))
      .then((result) => this.writeFallbackCache(operation, result, cacheParts, Date.now() - refreshStartedAt))
      .catch((err: unknown) => {
        logger.warn('Stellar RPC fallback cache early refresh failed', undefined, {
          event: 'rpc_fallback_cache_early_refresh_failed',
          operation,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.earlyRefreshes.delete(refreshKey);
      });

    this.earlyRefreshes.set(refreshKey, refresh);
  }

  private async writeFallbackCache<T>(
    operation: string,
    value: T,
    cacheParts: readonly string[],
    refreshDurationMs: number = 1,
  ): Promise<void> {
    if (this.fallbackCache.setEntry) {
      await this.fallbackCache.setEntry(operation, value, this.fallbackCacheTtlSeconds, cacheParts, {
        refreshDurationMs,
      });
      return;
    }

    await this.fallbackCache.set(operation, value, this.fallbackCacheTtlSeconds, cacheParts);
  }

  /**
   * Resolve the effective deadline for an operation, in priority order:
   *   1. Per-call override (`RpcCallOptions.timeoutMs`)
   *   2. Per-operation default (`operationDeadlines[operation]`)
   *   3. Global default (`this.timeoutMs`)
   */
  resolveDeadline(operation: string, opts: RpcCallOptions = {}): number {
    return opts.timeoutMs ?? this.operationDeadlines[operation] ?? this.timeoutMs;
  }

  private async callWithTimeout<T>(
    fn: () => Promise<T>,
    operation: string,
    opts: RpcCallOptions = {},
  ): Promise<T> {
    const start = Date.now();
    const timeoutMs = this.resolveDeadline(operation, opts);
    const signal = opts.signal;

    // Reject immediately if already aborted
    if (signal?.aborted) {
      throw new RpcProviderError(`${operation} was cancelled`, 'CANCELLED', undefined, 0);
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        action();
      };

      const timer = setTimeout(() => {
        const durationMs = Date.now() - start;
        settle(() => {
          const err = new RpcProviderError(
            `${operation} timed out after ${timeoutMs}ms`,
            'TIMEOUT',
            undefined,
            durationMs,
          );
          logFailure(operation, err, durationMs);
          reject(err);
        });
      }, timeoutMs);

      const onAbort = () => {
        const durationMs = Date.now() - start;
        settle(() => {
          const err = new RpcProviderError(
            `${operation} was cancelled`,
            'CANCELLED',
            undefined,
            durationMs,
          );
          logFailure(operation, err, durationMs);
          reject(err);
        });
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      fn().then(
        (result) => settle(() => resolve(result)),
        (err: unknown) => {
          const durationMs = Date.now() - start;
          settle(() => {
            const kind = classifyError(err);
            const statusCode = (err as { statusCode?: number }).statusCode;
            const message = err instanceof Error ? err.message : String(err);
            const wrapped = err instanceof RpcProviderError
              ? err
              : new RpcProviderError(message, kind, statusCode, durationMs);
            logFailure(operation, wrapped, durationMs);
            reject(wrapped);
          });
        },
      );
    });
  }
}

function logFailure(operation: string, err: RpcProviderError, durationMs: number): void {
  logger.warn('Stellar RPC call failed', undefined, {
    event: 'rpc_failure',
    operation,
    kind: err.kind,
    statusCode: err.statusCode,
    durationMs,
    error: err.message,
  });
}

/**
 * Parse a JSON string of per-operation deadlines into a typed map.
 * Returns an empty object when the input is undefined, empty, or invalid.
 * Each value is clamped to a minimum of 1 ms.
 */
export function parseOperationDeadlines(
  raw: string | undefined,
): Record<string, number> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && value >= 1) {
        result[key] = Math.floor(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

function buildRefreshKey(operation: string, cacheParts: readonly string[]): string {
  return `${operation}::${cacheParts.join('::')}`;
}

/**
 * XFetch-style probabilistic early expiry. As the Redis TTL boundary nears,
 * this becomes more likely to return true. The caller still serves the cached
 * response and starts a single background refresh so concurrent requests do not
 * stampede the Stellar RPC provider.
 */
function shouldEarlyRefresh<T>(
  entry: RpcFallbackCacheEntry<T>,
  beta: number,
  nowMs: number = Date.now(),
  random: () => number = Math.random,
): boolean {
  if (beta <= 0) return false;
  if (entry.expiresAt <= nowMs) return true;

  const refreshDurationMs = Math.max(1, entry.refreshDurationMs);
  const uniform = Math.max(Number.EPSILON, Math.min(1, random()));
  return nowMs - beta * refreshDurationMs * Math.log(uniform) >= entry.expiresAt;
}

let _service: StellarRpcService | null = null;

export function getStellarRpcService(getClient?: () => RawRpcClient): StellarRpcService {
  if (!_service) {
    const client = getClient ?? (() => {
      throw new RpcProviderError('No Stellar RPC client configured', 'PROVIDER');
    });
    const redisFallbackCache = createConfiguredRpcFallbackCache();
    const operationDeadlines = parseOperationDeadlines(
      process.env.STELLAR_RPC_OPERATION_DEADLINES,
    );
    _service = new StellarRpcService(client, {
      failureThreshold: parseInt(process.env.RPC_CB_FAILURE_THRESHOLD ?? '5', 10),
      windowMs: parseInt(process.env.RPC_CB_WINDOW_MS ?? '30000', 10),
      resetTimeoutMs: parseInt(process.env.RPC_CB_RESET_TIMEOUT_MS ?? '60000', 10),
      timeoutMs: parseInt(process.env.RPC_TIMEOUT_MS ?? '5000', 10),
      maxRetries: parseInt(process.env.STELLAR_RPC_MAX_RETRIES ?? '3', 10),
      retryDelayMs: parseInt(process.env.STELLAR_RPC_RETRY_DELAY ?? '1000', 10),
      operationDeadlines,
      fallbackCacheTtlSeconds: parseInt(process.env.RPC_FALLBACK_CACHE_TTL_SECONDS ?? '300', 10),
      fallbackCacheEarlyExpiryBeta: parseFloat(process.env.RPC_FALLBACK_CACHE_EARLY_EXPIRY_BETA ?? '0'),
      fallbackCache: redisFallbackCache,
      healthCheckIntervalMs: parseInt(process.env.RPC_HEALTH_CHECK_INTERVAL_MS ?? '0', 10),
      healthCheckFailureThreshold: parseInt(process.env.RPC_HEALTH_CHECK_FAILURE_THRESHOLD ?? '3', 10),
    });
    const intervalMs = parseInt(process.env.RPC_HEALTH_CHECK_INTERVAL_MS ?? '0', 10);
    if (intervalMs > 0) {
      _service.startHealthCheck(intervalMs);
    }
  }
  return _service;
}

export function setStellarRpcService(svc: StellarRpcService | null): void {
  _service = svc;
}

function createConfiguredRpcFallbackCache(): RpcFallbackCache {
  if (process.env.REDIS_ENABLED === 'false') {
    return new NoOpRpcFallbackCache();
  }

  let cachePromise: Promise<RpcFallbackCache> | null = null;
  const getCache = async (): Promise<RpcFallbackCache> => {
    if (!cachePromise) {
      cachePromise = createRedisClient({
        url: process.env.REDIS_URL ?? 'redis://localhost:6379',
        enabled: true,
      })
        .then((client) => new RedisRpcFallbackCache(client))
        .catch((err) => {
          logger.warn('Failed to initialize Redis RPC fallback cache', undefined, {
            event: 'rpc_fallback_cache_init_failed',
            error: err instanceof Error ? err.message : String(err),
          });
          return new NoOpRpcFallbackCache();
        });
    }
    return cachePromise;
  };

  return {
    async get<T>(operation: string, cacheParts?: readonly string[]): Promise<T | null> {
      return (await getCache()).get<T>(operation, cacheParts);
    },
    async getEntry<T>(operation: string, cacheParts?: readonly string[]) {
      const cache = await getCache();
      return cache.getEntry ? cache.getEntry<T>(operation, cacheParts) : null;
    },
    async set<T>(
      operation: string,
      value: T,
      ttlSeconds: number,
      cacheParts?: readonly string[],
    ): Promise<void> {
      return (await getCache()).set<T>(operation, value, ttlSeconds, cacheParts);
    },
    async setEntry<T>(
      operation: string,
      value: T,
      ttlSeconds: number,
      cacheParts?: readonly string[],
      options?: Parameters<NonNullable<RpcFallbackCache['setEntry']>>[4],
    ): Promise<void> {
      const cache = await getCache();
      if (cache.setEntry) {
        return cache.setEntry<T>(operation, value, ttlSeconds, cacheParts, options);
      }
      return cache.set<T>(operation, value, ttlSeconds, cacheParts);
    },
  };
}
