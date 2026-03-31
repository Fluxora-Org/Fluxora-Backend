/**
 * Stellar RPC service with circuit breaker.
 *
 * Circuit breaker states:
 *   CLOSED   — normal operation; calls pass through
 *   OPEN     — tripped; calls fail immediately without hitting the RPC
 *   HALF_OPEN — one probe call allowed to test recovery
 *
 * Trips when: failureCount >= failureThreshold within windowMs.
 * Resets after: resetTimeoutMs of being OPEN.
 *
 * Every failure emits a structured warn log with the error code and duration.
 */

import { logger } from '../lib/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

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
}

export class RpcProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly durationMs?: number,
  ) {
    super(message);
    this.name = 'RpcProviderError';
  }
}

export class CircuitOpenError extends Error {
  constructor() {
    super('Stellar RPC circuit breaker is OPEN — calls suspended during cool-off period');
    this.name = 'CircuitOpenError';
  }
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

  async getLatestLedger(): Promise<{ sequence: number }> {
    return this.breaker.call(() => this.callWithTimeout(
      () => this.getClient().getLatestLedger(),
      'getLatestLedger',
    ));
  }

  private async callWithTimeout<T>(
    fn: () => Promise<T>,
    operation: string,
  ): Promise<T> {
    const start = Date.now();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new RpcProviderError(`${operation} timed out`, undefined, this.timeoutMs)), this.timeoutMs),
    );

    try {
      const result = await Promise.race([fn(), timeout]);
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const statusCode = (err as { statusCode?: number }).statusCode;
      const message = err instanceof Error ? err.message : String(err);

      logger.warn('Stellar RPC call failed', undefined, {
        event: 'rpc_failure',
        operation,
        errorCode: statusCode,
        durationMs,
        error: message,
      });

      if (err instanceof RpcProviderError || err instanceof CircuitOpenError) throw err;
      throw new RpcProviderError(message, statusCode, durationMs);
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _service: StellarRpcService | null = null;

export function getStellarRpcService(getClient?: () => RawRpcClient): StellarRpcService {
  if (!_service) {
    const client = getClient ?? (() => {
      throw new RpcProviderError('No Stellar RPC client configured');
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
