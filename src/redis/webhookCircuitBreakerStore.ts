/**
 * Redis-backed per-consumer-URL circuit breaker for outbound webhook delivery.
 *
 * # State machine
 *
 * State is tracked per **consumer (receiver) URL**, keyed by
 * `webhook_cb:{sha256(url)[0..16]}` so every dispatcher replica and every process
 * restart shares one view of a struggling receiver.
 *
 * ```text
 *                       recordFailure() x threshold          now >= resetAt
 *   ┌────────┐ ───────────────────────────────────▶ ┌──────┐ ────────────────────▶ ┌───────────┐
 *   │ closed │                                       │ open │                       │ half-open │
 *   └────────┘ ◀─────────────────────────────────── └──────┘ ◀──────────────────── └───────────┘
 *      ▲     │        recordSuccess() (any state)      │ ▲     │                       │      │
 *      └─────┴────────────────────────────────────────┘ └─────┴───────────────────────┘      │
 *                                          recordFailure() (failed probe)   recordSuccess()  │
 * ```
 *
 * | Transition | Trigger | Threshold |
 * |------------|---------|-----------|
 * | `closed` → `open` | `recordFailure()` | `consecutiveFailures >= circuitBreakerThreshold` (`WEBHOOK_CIRCUIT_BREAKER_THRESHOLD`; default `0` = disabled, so an operator must set e.g. `10` to enable the breaker) |
 * | `closed` → `closed` | `recordFailure()` | `consecutiveFailures < circuitBreakerThreshold`; counter increments, no traffic is paused |
 * | `open` → `open` | `recordFailure()` while already open | stays open; `resetAt` is extended to `now + circuitBreakerResetMs` |
 * | `open` → `half-open` | `checkAndClaimAttempt()` | exactly one caller wins `SET NX webhook_cb_probe:{hash}` once `now >= resetAt` (`resetAt` is exclusive) |
 * | `open` → `open` | `checkAndClaimAttempt()` before `resetAt` | every delivery is denied; no HTTP call is made |
 * | `half-open` → `closed` | `recordSuccess()` | the single probe returned 2xx; `consecutiveFailures` resets to `0` |
 * | `half-open` → `open` | `recordFailure()` | the probe failed; re-opens until `now + circuitBreakerResetMs` and clears the probe lock |
 * | `half-open` → `half-open` | `checkAndClaimAttempt()` | probe lock still held (by this or another replica); deliveries denied. The probe lock alone does not re-open the gate: if that probe never reports an outcome, the circuit stays paused until the state record expires (`max(circuitBreakerResetMs * 2, 5 min)`), which reads back as `closed`. |
 *
 * Every transition increments
 * `fluxora_webhook_circuit_breaker_transitions_total{from_state,to_state,consumer_hash}`
 * (no-op re-entries are not counted).
 *
 * `describeWebhookCircuitBreaker()` renders a stored record into the operator /
 * receiver-facing status (state, whether delivery is paused, the machine-readable
 * reason, and when delivery resumes) served by `GET /internal/webhooks/circuit-breakers`.
 *
 * @module redis/webhookCircuitBreakerStore
 */

import { createHash, randomUUID } from 'node:crypto';
import { Counter } from 'prom-client';
import type { RedisClient } from './client.js';
import { registry } from '../metrics.js';
import { logger } from '../lib/logger.js';

export interface CircuitBreakerPolicy {
  circuitBreakerThreshold?: number;
  circuitBreakerResetMs?: number;
}

export const WEBHOOK_CIRCUIT_BREAKER_KEY_PREFIX = 'webhook_cb:';
export const WEBHOOK_CIRCUIT_BREAKER_PROBE_PREFIX = 'webhook_cb_probe:';
export type WebhookCircuitBreakerPhase = 'closed' | 'open' | 'half-open';

/**
 * Consecutive retryable failures that open the circuit when
 * `WEBHOOK_CIRCUIT_BREAKER_THRESHOLD` is unset. `0` means the breaker is
 * **disabled**: `checkAndClaimAttempt()` always allows the attempt and
 * `recordFailure()` never opens a circuit.
 */
export const DEFAULT_WEBHOOK_CIRCUIT_BREAKER_THRESHOLD = 0;

/**
 * How long an open circuit blocks deliveries before a single half-open probe is
 * admitted, when `WEBHOOK_CIRCUIT_BREAKER_RESET_MS` is unset (5 minutes).
 */
export const DEFAULT_WEBHOOK_CIRCUIT_BREAKER_RESET_MS = 300_000;

/**
 * Upper bound on the half-open probe lock TTL. The lock is acquired with
 * `SET NX EX min(circuitBreakerResetMs, 60_000)` and marks which replica owns
 * the single probe, so replicas sharing a circuit do not each fire one.
 *
 * The lock is not the recovery mechanism for an abandoned probe: while the
 * circuit is `half-open` every attempt stays denied regardless of the lock, and
 * the circuit only returns to `closed` when the state record expires
 * (see {@link WEBHOOK_CIRCUIT_BREAKER_STATE_TTL_FLOOR_MS}).
 */
export const WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS = 60_000;

/** State records are retained for `max(circuitBreakerResetMs * 2, 5 minutes)`. */
export const WEBHOOK_CIRCUIT_BREAKER_STATE_TTL_FLOOR_MS = 300_000;

export interface WebhookCircuitBreakerRecord {
  state: WebhookCircuitBreakerPhase;
  consecutiveFailures: number;
  resetAt: number;
  /**
   * Timestamp (ms since epoch) of the most recent failure counted toward the
   * circuit. `null` when the circuit has never failed or has been closed.
   * Reported as `lastFailureTime` by `GET /internal/webhooks/circuit-breakers`.
   */
  lastFailureAt: number | null;
  /**
   * Timestamp (ms since epoch) at which this record expires from the store
   * (`max(circuitBreakerResetMs * 2, 300000)` after it was written). An expired
   * record reads as `closed`, so this is the hard upper bound on how long a
   * `half-open` circuit can stay paused when its probe never reports an outcome.
   * `0` on records written by an older version, which fall back to the probe-lock
   * bound when reporting `resumeAt`.
   */
  expiresAt: number;
}

export interface WebhookCircuitBreakerCheckResult {
  allowed: boolean;
  state: WebhookCircuitBreakerPhase;
  consecutiveFailures: number;
  resetAt: number | null;
}

/**
 * Machine-readable explanation of why a receiver is not receiving deliveries,
 * and when delivery resumes.
 *
 * - `deliveries-allowed` — the circuit is `closed`; every attempt is delivered
 *   (subject to the rate limiter).
 * - `failure-threshold` — the circuit is `open` because
 *   `consecutiveFailures >= circuitBreakerThreshold`; all attempts are blocked
 *   until `resumeAt` (`resetAt`).
 * - `reset-elapsed` — the open window has elapsed but no probe has been claimed
 *   yet; the next `checkAndClaimAttempt()` is admitted as the half-open probe.
 * - `half-open-probe-in-flight` — a single probe delivery is in flight (this
 *   replica or another); all other attempts are blocked until the probe reports
 *   success/failure, or at `resumeAt` (the state record's expiry, the hard
 *   upper bound for a probe that never reports).
 */
export type WebhookCircuitBreakerPauseReason =
  | 'deliveries-allowed'
  | 'failure-threshold'
  | 'reset-elapsed'
  | 'half-open-probe-in-flight';

/** Receiver-facing view of one consumer's circuit breaker. */
export interface WebhookCircuitBreakerStatus {
  state: WebhookCircuitBreakerPhase;
  /** True when deliveries to this receiver are currently blocked. */
  paused: boolean;
  reason: WebhookCircuitBreakerPauseReason;
  consecutiveFailures: number;
  /** Effective failure threshold (`0` = breaker disabled). */
  threshold: number;
  /** Effective open-window duration in ms. */
  resetMs: number;
  /** Epoch ms of the last counted failure, or `null`. */
  lastFailureAt: number | null;
  /**
   * Epoch ms at which delivery to this receiver resumes — the half-open probe
   * window for an open circuit, or the state record's expiry while half-open.
   * This is the latest moment the pause can still be in effect: a half-open
   * pause normally ends within seconds, when the probe reports its outcome.
   * `null` when nothing is blocking delivery.
   */
  resumeAt: number | null;
}

export interface WebhookCircuitBreakerStore {
  checkAndClaimAttempt(
    consumerUrl: string,
    policy: CircuitBreakerPolicy,
    now?: number,
  ): Promise<WebhookCircuitBreakerCheckResult>;
  recordSuccess(consumerUrl: string, policy: CircuitBreakerPolicy): Promise<WebhookCircuitBreakerRecord>;
  recordFailure(
    consumerUrl: string,
    policy: CircuitBreakerPolicy,
    now?: number,
  ): Promise<WebhookCircuitBreakerRecord>;
  getState(consumerUrl: string): Promise<WebhookCircuitBreakerRecord | null>;
  close(): Promise<void>;
}

export const transitionsTotal =
  (registry.getSingleMetric('fluxora_webhook_circuit_breaker_transitions_total') as Counter<
    'from_state' | 'to_state' | 'consumer_hash'
  >) ||
  new Counter({
    name: 'fluxora_webhook_circuit_breaker_transitions_total',
    help: 'Webhook circuit breaker state transitions per consumer endpoint',
    labelNames: ['from_state', 'to_state', 'consumer_hash'] as const,
    registers: [registry],
  });

export { webhookRateLimiterFailOpenTotal } from './webhookRateLimit.js';

function closed(): WebhookCircuitBreakerRecord {
  return { state: 'closed', consecutiveFailures: 0, resetAt: 0, lastFailureAt: null, expiresAt: 0 };
}

export function hashConsumerUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function stateKey(url: string): string {
  return `${WEBHOOK_CIRCUIT_BREAKER_KEY_PREFIX}${hashConsumerUrl(url)}`;
}

function probeKey(url: string): string {
  return `${WEBHOOK_CIRCUIT_BREAKER_PROBE_PREFIX}${hashConsumerUrl(url)}`;
}

function ttlSec(policy: CircuitBreakerPolicy): number {
  const resetMs = policy.circuitBreakerResetMs ?? DEFAULT_WEBHOOK_CIRCUIT_BREAKER_RESET_MS;
  return Math.ceil(Math.max(resetMs * 2, WEBHOOK_CIRCUIT_BREAKER_STATE_TTL_FLOOR_MS) / 1000);
}

/** Retention of a state record, in ms — the value both stores agree on. */
function ttlMs(policy: CircuitBreakerPolicy): number {
  return ttlSec(policy) * 1000;
}

function emit(from: WebhookCircuitBreakerPhase, to: WebhookCircuitBreakerPhase, consumerUrl: string): void {
  if (from !== to)
    transitionsTotal.inc({
      from_state: from,
      to_state: to,
      consumer_hash: hashConsumerUrl(consumerUrl),
    });
}

function parse(raw: string | null): WebhookCircuitBreakerRecord {
  if (!raw) return closed();
  try {
    const v = JSON.parse(raw) as Partial<WebhookCircuitBreakerRecord>;
    return {
      state: v.state ?? 'closed',
      consecutiveFailures: v.consecutiveFailures ?? 0,
      resetAt: v.resetAt ?? 0,
      lastFailureAt: v.lastFailureAt ?? null,
      expiresAt: v.expiresAt ?? 0,
    };
  } catch {
    return closed();
  }
}

/**
 * Render a stored circuit record into the receiver-facing status: the state,
 * whether delivery is paused, the reason it is paused, and when it resumes.
 *
 * This is the single source of truth behind `GET /internal/webhooks/circuit-breakers`
 * and behind the thresholds documented in [`docs/webhooks.md`](../../docs/webhooks.md).
 *
 * @param record Stored record, or `null` when the receiver has no state yet.
 * @param policy Effective circuit-breaker policy (thresholds).
 * @param now Current timestamp, ms since epoch.
 */
export function describeWebhookCircuitBreaker(
  record: WebhookCircuitBreakerRecord | null,
  policy: CircuitBreakerPolicy,
  now: number = Date.now(),
): WebhookCircuitBreakerStatus {
  const threshold = policy.circuitBreakerThreshold ?? DEFAULT_WEBHOOK_CIRCUIT_BREAKER_THRESHOLD;
  const resetMs = policy.circuitBreakerResetMs ?? DEFAULT_WEBHOOK_CIRCUIT_BREAKER_RESET_MS;
  const current = record ?? closed();

  if (current.state === 'closed') {
    return {
      state: 'closed',
      paused: false,
      reason: 'deliveries-allowed',
      consecutiveFailures: current.consecutiveFailures,
      threshold,
      resetMs,
      lastFailureAt: current.lastFailureAt,
      resumeAt: null,
    };
  }

  if (current.state === 'open') {
    if (now < current.resetAt) {
      return {
        state: 'open',
        paused: true,
        reason: 'failure-threshold',
        consecutiveFailures: current.consecutiveFailures,
        threshold,
        resetMs,
        lastFailureAt: current.lastFailureAt,
        resumeAt: current.resetAt,
      };
    }
    return {
      state: 'open',
      paused: false,
      reason: 'reset-elapsed',
      consecutiveFailures: current.consecutiveFailures,
      threshold,
      resetMs,
      lastFailureAt: current.lastFailureAt,
      resumeAt: null,
    };
  }

  return {
    state: 'half-open',
    paused: true,
    reason: 'half-open-probe-in-flight',
    consecutiveFailures: current.consecutiveFailures,
    threshold,
    resetMs,
    lastFailureAt: current.lastFailureAt,
    // The pause normally ends as soon as the probe reports. If that probe is
    // never reported (dispatcher crash), the record expires and the circuit
    // reads as `closed` — that expiry is the hard upper bound.
    resumeAt: current.expiresAt > 0 ? current.expiresAt : now + Math.min(resetMs, WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS),
  };
}

export class RedisWebhookCircuitBreakerStore implements WebhookCircuitBreakerStore {
  constructor(private readonly client: RedisClient) {}

  private threshold(policy: CircuitBreakerPolicy): number {
    return policy.circuitBreakerThreshold ?? DEFAULT_WEBHOOK_CIRCUIT_BREAKER_THRESHOLD;
  }

  private resetMs(policy: CircuitBreakerPolicy): number {
    return policy.circuitBreakerResetMs ?? DEFAULT_WEBHOOK_CIRCUIT_BREAKER_RESET_MS;
  }

  async checkAndClaimAttempt(
    consumerUrl: string,
    policy: CircuitBreakerPolicy,
    now = Date.now(),
  ): Promise<WebhookCircuitBreakerCheckResult> {
    if (this.threshold(policy) <= 0) {
      return { allowed: true, state: 'closed', consecutiveFailures: 0, resetAt: null };
    }
    try {
      const record = parse(await this.client.get(stateKey(consumerUrl)));
      if (record.state === 'closed') {
        return {
          allowed: true,
          state: 'closed',
          consecutiveFailures: record.consecutiveFailures,
          resetAt: null,
        };
      }
      if (record.state === 'open') {
        if (now < record.resetAt) {
          return {
            allowed: false,
            state: 'open',
            consecutiveFailures: record.consecutiveFailures,
            resetAt: record.resetAt,
          };
        }
        const acquired = await this.client.setNx(
          probeKey(consumerUrl),
          randomUUID(),
          Math.min(this.resetMs(policy), WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS),
        );
        if (!acquired) {
          return {
            allowed: false,
            state: 'half-open',
            consecutiveFailures: record.consecutiveFailures,
            resetAt: record.resetAt,
          };
        }
        const next = {
          state: 'half-open' as const,
          consecutiveFailures: record.consecutiveFailures,
          resetAt: 0,
          lastFailureAt: record.lastFailureAt,
          expiresAt: now + ttlMs(policy),
        };
        await this.client.set(stateKey(consumerUrl), JSON.stringify(next), { ex: ttlSec(policy) });
        emit('open', 'half-open', consumerUrl);
        return {
          allowed: true,
          state: 'half-open',
          consecutiveFailures: record.consecutiveFailures,
          resetAt: null,
        };
      }
      return {
        allowed: false,
        state: 'half-open',
        consecutiveFailures: record.consecutiveFailures,
        resetAt: null,
      };
    } catch (err) {
      logger.error('WebhookCircuitBreakerStore Redis error — failing open', undefined, {
        operation: 'checkAndClaimAttempt',
        consumerKey: hashConsumerUrl(consumerUrl),
        error: err instanceof Error ? err.message : String(err),
      });
      return { allowed: true, state: 'closed', consecutiveFailures: 0, resetAt: null };
    }
  }

  async recordSuccess(consumerUrl: string, policy: CircuitBreakerPolicy): Promise<WebhookCircuitBreakerRecord> {
    try {
      const previous = parse(await this.client.get(stateKey(consumerUrl)));
      const next = { ...closed(), expiresAt: Date.now() + ttlMs(policy) };
      await this.client.set(stateKey(consumerUrl), JSON.stringify(next), { ex: ttlSec(policy) });
      await this.client.del(probeKey(consumerUrl));
      if (previous.state !== 'closed') emit(previous.state, 'closed', consumerUrl);
      return next;
    } catch (err) {
      logger.error('WebhookCircuitBreakerStore Redis error on recordSuccess', undefined, {
        operation: 'recordSuccess',
        consumerKey: hashConsumerUrl(consumerUrl),
        error: err instanceof Error ? err.message : String(err),
      });
      return closed();
    }
  }

  async recordFailure(
    consumerUrl: string,
    policy: CircuitBreakerPolicy,
    now = Date.now(),
  ): Promise<WebhookCircuitBreakerRecord> {
    if (this.threshold(policy) <= 0) return closed();
    try {
      const previous = parse(await this.client.get(stateKey(consumerUrl)));
      const expiresAt = now + ttlMs(policy);
      let next: WebhookCircuitBreakerRecord;
      if (previous.state === 'half-open') {
        next = {
          state: 'open',
          consecutiveFailures: previous.consecutiveFailures,
          resetAt: now + this.resetMs(policy),
          lastFailureAt: now,
          expiresAt,
        };
        emit('half-open', 'open', consumerUrl);
      } else {
        const failures = previous.consecutiveFailures + 1;
        next =
          failures >= this.threshold(policy)
            ? {
                state: 'open',
                consecutiveFailures: failures,
                resetAt: now + this.resetMs(policy),
                lastFailureAt: now,
                expiresAt,
              }
            : {
                state: 'closed',
                consecutiveFailures: failures,
                resetAt: 0,
                lastFailureAt: now,
                expiresAt,
              };
        if (next.state === 'open') emit(previous.state === 'open' ? 'open' : 'closed', 'open', consumerUrl);
      }
      await this.client.set(stateKey(consumerUrl), JSON.stringify(next), { ex: ttlSec(policy) });
      await this.client.del(probeKey(consumerUrl));
      return next;
    } catch (err) {
      logger.error('WebhookCircuitBreakerStore Redis error on recordFailure', undefined, {
        operation: 'recordFailure',
        consumerKey: hashConsumerUrl(consumerUrl),
        error: err instanceof Error ? err.message : String(err),
      });
      return closed();
    }
  }

  async getState(consumerUrl: string): Promise<WebhookCircuitBreakerRecord | null> {
    try {
      const raw = await this.client.get(stateKey(consumerUrl));
      return raw ? parse(raw) : null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * In-memory implementation of the {@link WebhookCircuitBreakerStore}.
 *
 * Enforces half-open probe semantics and ensures the exactly-one-probe invariant:
 * - When the circuit is 'open' and the reset period has passed, exactly one probe attempt
 *   is allowed to be in-flight to check the service health.
 * - This behavior is isolated per consumer URL. Concurrent probe requests on different
 *   URLs do not interfere with one another.
 * - A probe attempt is reserved for `min(circuitBreakerResetMs, 60s)` — the same
 *   bound the Redis implementation uses for its `SET NX` lock.
 * - The reservation is released as soon as an outcome is recorded
 *   ({@link recordSuccess} / {@link recordFailure}). If a dispatcher abandons the
 *   probe, the circuit stays `half-open` and paused: probe reservations are only
 *   consulted when claiming a probe from `open`, never to re-admit delivery. The
 *   circuit returns to `closed` when the state record expires
 *   (`expiresAt`), which is the bound `resumeAt` reports for a stuck probe.
 */
export class InMemoryWebhookCircuitBreakerStore implements WebhookCircuitBreakerStore {
  private readonly states = new Map<string, WebhookCircuitBreakerRecord>();
  /** Maps hashed consumer URL key -> probe lock expiration timestamp (ms since epoch) */
  private readonly probes = new Map<string, number>();

  /**
   * Checks the circuit breaker state and attempts to claim a half-open probe.
   *
   * @param consumerUrl The target webhook endpoint.
   * @param policy The circuit breaker configuration policy.
   * @param now The current timestamp.
   * @returns A check result indicating if the attempt is allowed, the state, failures, and reset duration.
   *
   * @remarks
   * Evaluates if a probe is already in-flight by verifying if a probe exists in the local map and
   * its expiration time is in the future. Ensures exactly one probe is admitted in flight per consumer URL
   * under concurrent calls.
   */
  async checkAndClaimAttempt(
    consumerUrl: string,
    policy: CircuitBreakerPolicy,
    now = Date.now(),
  ): Promise<WebhookCircuitBreakerCheckResult> {
    const threshold = policy.circuitBreakerThreshold ?? DEFAULT_WEBHOOK_CIRCUIT_BREAKER_THRESHOLD;
    if (threshold <= 0) return { allowed: true, state: 'closed', consecutiveFailures: 0, resetAt: null };
    const key = hashConsumerUrl(consumerUrl);
    const record = this.states.get(key) ?? closed();
    if (record.state === 'closed') {
      return { allowed: true, state: 'closed', consecutiveFailures: record.consecutiveFailures, resetAt: null };
    }
    if (record.state === 'open') {
      if (now < record.resetAt) {
        return { allowed: false, state: 'open', consecutiveFailures: record.consecutiveFailures, resetAt: record.resetAt };
      }
      const probeExpiry = this.probes.get(key);
      if (probeExpiry !== undefined && now < probeExpiry) {
        return { allowed: false, state: 'half-open', consecutiveFailures: record.consecutiveFailures, resetAt: record.resetAt };
      }
      const resetMs = policy.circuitBreakerResetMs ?? DEFAULT_WEBHOOK_CIRCUIT_BREAKER_RESET_MS;
      const expiry = now + Math.min(resetMs, WEBHOOK_CIRCUIT_BREAKER_PROBE_LOCK_MAX_MS);
      this.probes.set(key, expiry);
      this.states.set(key, {
        state: 'half-open',
        consecutiveFailures: record.consecutiveFailures,
        resetAt: 0,
        lastFailureAt: record.lastFailureAt,
        expiresAt: now + ttlMs(policy),
      });
      emit('open', 'half-open', consumerUrl);
      return { allowed: true, state: 'half-open', consecutiveFailures: record.consecutiveFailures, resetAt: null };
    }
    return {
      allowed: false,
      state: 'half-open',
      consecutiveFailures: record.consecutiveFailures,
      resetAt: null,
    };
  }

  /**
   * Records a successful probe outcome, resetting the consecutive failures
   * count and closing the circuit. Clears the in-flight probe state.
   */
  async recordSuccess(consumerUrl: string, policy: CircuitBreakerPolicy): Promise<WebhookCircuitBreakerRecord> {
    const key = hashConsumerUrl(consumerUrl);
    const previous = this.states.get(key) ?? closed();
    const next = { ...closed(), expiresAt: Date.now() + ttlMs(policy) };
    this.states.set(key, next);
    this.probes.delete(key);
    if (previous.state !== 'closed') emit(previous.state, 'closed', consumerUrl);
    return next;
  }

  /**
   * Records a failed probe outcome, re-opening the circuit breaker with a backoff delay.
   * Clears the in-flight probe state.
   */
  async recordFailure(consumerUrl: string, policy: CircuitBreakerPolicy, now = Date.now()): Promise<WebhookCircuitBreakerRecord> {
    const threshold = policy.circuitBreakerThreshold ?? DEFAULT_WEBHOOK_CIRCUIT_BREAKER_THRESHOLD;
    if (threshold <= 0) return closed();
    const resetMs = policy.circuitBreakerResetMs ?? DEFAULT_WEBHOOK_CIRCUIT_BREAKER_RESET_MS;
    const key = hashConsumerUrl(consumerUrl);
    const previous = this.states.get(key) ?? closed();
    const expiresAt = now + ttlMs(policy);
    let next: WebhookCircuitBreakerRecord;
    if (previous.state === 'half-open') {
      next = {
        state: 'open',
        consecutiveFailures: previous.consecutiveFailures,
        resetAt: now + resetMs,
        lastFailureAt: now,
        expiresAt,
      };
      emit('half-open', 'open', consumerUrl);
    } else {
      const failures = previous.consecutiveFailures + 1;
      next =
        failures >= threshold
          ? { state: 'open', consecutiveFailures: failures, resetAt: now + resetMs, lastFailureAt: now, expiresAt }
          : { state: 'closed', consecutiveFailures: failures, resetAt: 0, lastFailureAt: now, expiresAt };
      if (next.state === 'open') emit(previous.state === 'open' ? 'open' : 'closed', 'open', consumerUrl);
    }
    this.states.set(key, next);
    this.probes.delete(key);
    return next;
  }

  async getState(consumerUrl: string): Promise<WebhookCircuitBreakerRecord | null> {
    return this.states.get(hashConsumerUrl(consumerUrl)) ?? null;
  }

  async close(): Promise<void> {
    this.states.clear();
    this.probes.clear();
  }
}

let storeInstance: WebhookCircuitBreakerStore | null = null;

export function setWebhookCircuitBreakerStore(store: WebhookCircuitBreakerStore | null): void {
  storeInstance = store;
}

export function getWebhookCircuitBreakerStore(): WebhookCircuitBreakerStore {
  if (!storeInstance) storeInstance = new InMemoryWebhookCircuitBreakerStore();
  return storeInstance;
}

export function createWebhookCircuitBreakerStore(client: RedisClient): WebhookCircuitBreakerStore {
  return new RedisWebhookCircuitBreakerStore(client);
}
