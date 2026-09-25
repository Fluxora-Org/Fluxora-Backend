import type { RedisClient } from './client.js';
import { sanitiseIdentifier } from './rateLimitStore.js';

const ATTEMPTS_PREFIX = 'fluxora:auth_attempts:';
const LOCKOUT_PREFIX = 'fluxora:auth_lockout:';
/** Failed-attempt entries are scoped per sanitised identifier and expire after this window. */
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const THRESHOLD = 5;
/** Lockout records are bounded even if failures continue arriving. */
const MAX_LOCKOUT_SECONDS = 3600; // 1 hour

function randomHex(): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars[Math.floor(Math.random() * 16)];
  }
  return result;
}

export function computeLockoutDuration(attemptCount: number): number {
  const exponent = attemptCount - THRESHOLD;
  const seconds = Math.pow(2, exponent) * 60;
  return Math.min(seconds, MAX_LOCKOUT_SECONDS);
}

function buildAttemptsKey(key: string): string {
  return `${ATTEMPTS_PREFIX}${sanitiseIdentifier(key)}`;
}

function buildLockoutKey(key: string): string {
  return `${LOCKOUT_PREFIX}${sanitiseIdentifier(key)}`;
}

/**
 * Redis-backed authentication failure tracking.
 *
 * Attempt keys are scoped by the sanitised login/IP identifier. The sorted-set
 * entry and its TTL are refreshed on each failure, but scores older than the
 * ten-minute window are removed before counting, so history cannot create a
 * permanent lockout. Lockout keys are always capped at one hour.
 *
 * Redis failures are deliberately surfaced to callers instead of converted to
 * a successful authentication decision. The middleware can then fail closed
 * or return its configured service-unavailable response.
 */
export class AuthAttemptStore {
  constructor(private readonly client: RedisClient) {}

  /** Record one failure, pruning the bounded window before calculating lockout. */
  async recordFailure(key: string): Promise<void> {
    const now = Date.now();
    const attemptsKey = buildAttemptsKey(key);
    const member = `${now}-${randomHex()}`;

    const results = await this.client
      .multi()
      .zadd(attemptsKey, 'NX', now, member)
      .zremrangebyscore(attemptsKey, '-inf', now - WINDOW_MS)
      .zcard(attemptsKey)
      .pexpire(attemptsKey, WINDOW_MS)
      .exec();

    if (!results) {
      throw new Error('AuthAttemptStore pipeline failed to execute');
    }

    for (let i = 0; i < results.length; i++) {
      const [err] = results[i] as [Error | null, unknown];
      if (err) {
        throw new Error(`AuthAttemptStore pipeline command at index ${i} failed: ${err.message}`);
      }
    }

    const zcardResult = results[2];
    const count = zcardResult && zcardResult[1] != null ? (zcardResult[1] as number) : 0;

    if (count >= THRESHOLD) {
      const lockoutSeconds = computeLockoutDuration(count);
      const lockoutKey = buildLockoutKey(key);
      const expiryTimestamp = String(now + lockoutSeconds * 1000);
      await this.client.set(lockoutKey, expiryTimestamp, { ex: lockoutSeconds });
    }
  }

  /** Return failures still inside the ten-minute accounting window. */
  async getAttemptCount(key: string): Promise<number> {
    const now = Date.now();
    const attemptsKey = buildAttemptsKey(key);
    return this.client.zcount(attemptsKey, now - WINDOW_MS, '+inf');
  }

  /** Remove both the rolling failure counter and any active lockout. */
  async resetAttempts(key: string): Promise<void> {
    const attemptsKey = buildAttemptsKey(key);
    const lockoutKey = buildLockoutKey(key);
    await this.client.del(attemptsKey);
    await this.client.del(lockoutKey);
  }

  /** Return remaining lockout seconds, or zero when no lockout is active. */
  async isLockedOut(key: string): Promise<number> {
    const lockoutKey = buildLockoutKey(key);
    const value = await this.client.get(lockoutKey);
    if (!value) return 0;
    const expiryTimestamp = parseInt(value, 10);
    const remaining = Math.ceil((expiryTimestamp - Date.now()) / 1000);
    return Math.max(0, remaining);
  }
}
