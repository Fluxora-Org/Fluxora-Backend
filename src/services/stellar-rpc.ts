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
} from '../metrics/rpcMetrics.js';

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
}

export interface StellarRpcServiceOptions extends CircuitBreakerOptions, RpcCallOptions {
  /** TTL for last-known-good fallback entries, seconds. Default 300. */
  fallbackCacheTtlSeconds?: number;
  /** Optional cache injection for tests or alternate Redis lifecycle ownership. */
  fallbackCache?: RpcFallbackCache;
  /** XFetch-style beta factor. Set to 0 to disable early-expiry reads. */
  fallbackCacheEarlyExpiryBeta?: number;
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
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = [];
    this.state = 'CLOSED';
  }

  private onFailure(): void {
    this.failures.push(Date.now());
    if (this.failures.length >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      logger.warn('Stellar RPC circuit breaker tripped', undefined, {
        event: 'circuit_open',
        failureCount: this.failures.length,
        windowMs: this.windowMs,
      });
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
  private readonly fallbackCache: RpcFallbackCache;
  private readonly fallbackCacheTtlSeconds: number;
  private readonly fallbackCacheEarlyExpiryBeta: number;
  private readonly earlyRefreshes = new Map<string, Promise<void>>();

  constructor(
    private readonly getClient: () => RawRpcClient,
    opts: StellarRpcServiceOptions = {},
  ) {
    this.breaker = new CircuitBreaker(opts);
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.fallbackCache = opts.fallbackCache ?? new NoOpRpcFallbackCache();
    this.fallbackCacheTtlSeconds = opts.fallbackCacheTtlSeconds ?? 300;
    this.fallbackCacheEarlyExpiryBeta = Math.max(0, opts.fallbackCacheEarlyExpiryBeta ?? 0);
  }

  getCircuitState(): CircuitState { return this.breaker.getState(); }

  /** Reset the circuit breaker (manual recovery). */
  resetCircuit(): void { this.breaker.reset(); }

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
      () => this.getClient().getLatestLedger(),
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
      async () => {
        const client = this.getClient();
        const base = (client.horizonUrl ?? '').replace(/\/$/, '');
        if (!base) {
          throw new RpcProviderError('horizonUrl not configured on RPC client', 'PROVIDER');
        }
        const url = `${base}/accounts/${encodeURIComponent(address)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs) });
        if (res.status === 200) return true;
        if (res.status === 404) return false;
        throw new RpcProviderError(
          `Horizon returned HTTP ${res.status} for account lookup`,
          'PROVIDER',
          res.status,
        );
      },
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

  private async callWithTimeout<T>(
    fn: () => Promise<T>,
    operation: string,
    opts: RpcCallOptions = {},
  ): Promise<T> {
    const start = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
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
    _service = new StellarRpcService(client, {
      failureThreshold: parseInt(process.env.RPC_CB_FAILURE_THRESHOLD ?? '5', 10),
      windowMs: parseInt(process.env.RPC_CB_WINDOW_MS ?? '30000', 10),
      resetTimeoutMs: parseInt(process.env.RPC_CB_RESET_TIMEOUT_MS ?? '60000', 10),
      timeoutMs: parseInt(process.env.RPC_TIMEOUT_MS ?? '5000', 10),
      fallbackCacheTtlSeconds: parseInt(process.env.RPC_FALLBACK_CACHE_TTL_SECONDS ?? '300', 10),
      fallbackCacheEarlyExpiryBeta: parseFloat(process.env.RPC_FALLBACK_CACHE_EARLY_EXPIRY_BETA ?? '0'),
      fallbackCache: redisFallbackCache,
    });
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
