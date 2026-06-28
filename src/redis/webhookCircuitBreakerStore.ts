/**
 * Redis-backed per-consumer-URL circuit breaker for outbound webhook delivery.
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

export interface WebhookCircuitBreakerRecord {
  state: WebhookCircuitBreakerPhase;
  consecutiveFailures: number;
  resetAt: number;
}

export interface WebhookCircuitBreakerCheckResult {
  allowed: boolean;
  state: WebhookCircuitBreakerPhase;
  consecutiveFailures: number;
  resetAt: number | null;
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

const transitionsTotal =
  (registry.getSingleMetric('fluxora_webhook_circuit_breaker_transitions_total') as Counter<
    'from_state' | 'to_state'
  >) ||
  new Counter({
    name: 'fluxora_webhook_circuit_breaker_transitions_total',
    help: 'Webhook circuit breaker state transitions per consumer endpoint',
    labelNames: ['from_state', 'to_state'] as const,
    registers: [registry],
  });

function closed(): WebhookCircuitBreakerRecord {
  return { state: 'closed', consecutiveFailures: 0, resetAt: 0 };
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
  const resetMs = policy.circuitBreakerResetMs ?? 300_000;
  return Math.ceil(Math.max(resetMs * 2, 300_000) / 1000);
}

function emit(from: WebhookCircuitBreakerPhase, to: WebhookCircuitBreakerPhase): void {
  if (from !== to) transitionsTotal.inc({ from_state: from, to_state: to });
}

function parse(raw: string | null): WebhookCircuitBreakerRecord {
  if (!raw) return closed();
  try {
    const v = JSON.parse(raw) as Partial<WebhookCircuitBreakerRecord>;
    return {
      state: v.state ?? 'closed',
      consecutiveFailures: v.consecutiveFailures ?? 0,
      resetAt: v.resetAt ?? 0,
    };
  } catch {
    return closed();
  }
}

export class RedisWebhookCircuitBreakerStore implements WebhookCircuitBreakerStore {
  constructor(private readonly client: RedisClient) {}

  private threshold(policy: CircuitBreakerPolicy): number {
    return policy.circuitBreakerThreshold ?? 0;
  }

  private resetMs(policy: CircuitBreakerPolicy): number {
    return policy.circuitBreakerResetMs ?? 300_000;
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
          Math.min(this.resetMs(policy), 60_000),
        );
        if (!acquired) {
          return {
            allowed: false,
            state: 'half-open',
            consecutiveFailures: record.consecutiveFailures,
            resetAt: record.resetAt,
          };
        }
        const next = { state: 'half-open' as const, consecutiveFailures: record.consecutiveFailures, resetAt: 0 };
        await this.client.set(stateKey(consumerUrl), JSON.stringify(next), { ex: ttlSec(policy) });
        emit('open', 'half-open');
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
      const next = closed();
      await this.client.set(stateKey(consumerUrl), JSON.stringify(next), { ex: ttlSec(policy) });
      await this.client.del(probeKey(consumerUrl));
      if (previous.state !== 'closed') emit(previous.state, 'closed');
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
      let next: WebhookCircuitBreakerRecord;
      if (previous.state === 'half-open') {
        next = {
          state: 'open',
          consecutiveFailures: previous.consecutiveFailures,
          resetAt: now + this.resetMs(policy),
        };
        emit('half-open', 'open');
      } else {
        const failures = previous.consecutiveFailures + 1;
        next =
          failures >= this.threshold(policy)
            ? { state: 'open', consecutiveFailures: failures, resetAt: now + this.resetMs(policy) }
            : { state: 'closed', consecutiveFailures: failures, resetAt: 0 };
        if (next.state === 'open') emit(previous.state === 'open' ? 'open' : 'closed', 'open');
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

export class InMemoryWebhookCircuitBreakerStore implements WebhookCircuitBreakerStore {
  private readonly states = new Map<string, WebhookCircuitBreakerRecord>();
  private readonly probes = new Set<string>();

  async checkAndClaimAttempt(
    consumerUrl: string,
    policy: CircuitBreakerPolicy,
    now = Date.now(),
  ): Promise<WebhookCircuitBreakerCheckResult> {
    const threshold = policy.circuitBreakerThreshold ?? 0;
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
      if (this.probes.has(key)) {
        return { allowed: false, state: 'half-open', consecutiveFailures: record.consecutiveFailures, resetAt: record.resetAt };
      }
      this.probes.add(key);
      this.states.set(key, { state: 'half-open', consecutiveFailures: record.consecutiveFailures, resetAt: 0 });
      emit('open', 'half-open');
      return { allowed: true, state: 'half-open', consecutiveFailures: record.consecutiveFailures, resetAt: null };
    }
    return {
      allowed: false,
      state: 'half-open',
      consecutiveFailures: record.consecutiveFailures,
      resetAt: null,
    };
  }

  async recordSuccess(consumerUrl: string, _policy: CircuitBreakerPolicy): Promise<WebhookCircuitBreakerRecord> {
    const key = hashConsumerUrl(consumerUrl);
    const previous = this.states.get(key) ?? closed();
    const next = closed();
    this.states.set(key, next);
    this.probes.delete(key);
    if (previous.state !== 'closed') emit(previous.state, 'closed');
    return next;
  }

  async recordFailure(consumerUrl: string, policy: CircuitBreakerPolicy, now = Date.now()): Promise<WebhookCircuitBreakerRecord> {
    const threshold = policy.circuitBreakerThreshold ?? 0;
    if (threshold <= 0) return closed();
    const key = hashConsumerUrl(consumerUrl);
    const previous = this.states.get(key) ?? closed();
    let next: WebhookCircuitBreakerRecord;
    if (previous.state === 'half-open') {
      next = { state: 'open', consecutiveFailures: previous.consecutiveFailures, resetAt: now + (policy.circuitBreakerResetMs ?? 300_000) };
      emit('half-open', 'open');
    } else {
      const failures = previous.consecutiveFailures + 1;
      next =
        failures >= threshold
          ? { state: 'open', consecutiveFailures: failures, resetAt: now + (policy.circuitBreakerResetMs ?? 300_000) }
          : { state: 'closed', consecutiveFailures: failures, resetAt: 0 };
      if (next.state === 'open') emit(previous.state === 'open' ? 'open' : 'closed', 'open');
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
