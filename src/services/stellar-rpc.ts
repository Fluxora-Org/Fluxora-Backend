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

import { logger } from '../lib/logger.js';

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
}

export class StellarRpcService {
  private readonly breaker: CircuitBreaker;
  private readonly timeoutMs: number;

  constructor(
    private readonly getClient: () => RawRpcClient,
    opts: CircuitBreakerOptions & RpcCallOptions = {},
  ) {
    this.breaker = new CircuitBreaker(opts);
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  getCircuitState(): CircuitState { return this.breaker.getState(); }

  /** Reset the circuit breaker (manual recovery). */
  resetCircuit(): void { this.breaker.reset(); }

  async getLatestLedger(opts: RpcCallOptions = {}): Promise<{ sequence: number }> {
    return this.breaker.call(() => this.callWithTimeout(
      () => this.getClient().getLatestLedger(),
      'getLatestLedger',
      opts,
    ));
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

let _service: StellarRpcService | null = null;

export function getStellarRpcService(getClient?: () => RawRpcClient): StellarRpcService {
  if (!_service) {
    const client = getClient ?? (() => {
      throw new RpcProviderError('No Stellar RPC client configured', 'PROVIDER');
    });
    _service = new StellarRpcService(client, {
      failureThreshold: parseInt(process.env.RPC_CB_FAILURE_THRESHOLD ?? '5', 10),
      windowMs: parseInt(process.env.RPC_CB_WINDOW_MS ?? '30000', 10),
      resetTimeoutMs: parseInt(process.env.RPC_CB_RESET_TIMEOUT_MS ?? '60000', 10),
      timeoutMs: parseInt(process.env.RPC_TIMEOUT_MS ?? '5000', 10),
    });
  }
  return _service;
}

export function setStellarRpcService(svc: StellarRpcService | null): void {
  _service = svc;
}
