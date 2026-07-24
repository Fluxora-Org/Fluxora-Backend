/**
 * Redis-backed leader election for indexer replay in multi-replica deployments.
 *
 * Only one backend instance may hold the lease at a time. The lease is
 * acquired with `SET NX PX` (via `RedisClient.setNx`) and renewed on a
 * heartbeat well before it expires. If renewal stops succeeding — because
 * another instance has taken over, or Redis is unreachable — `isLeader()`
 * flips to `false` so callers can abort in-flight work at a safe boundary.
 *
 * Modeled on `RedisDistributedLock` in `src/state/adminStateLock.ts`, with
 * lease renewal added since replay runs can far outlive a single lock TTL.
 */

import * as crypto from 'node:crypto';
import type { RedisClient } from '../redis/client.js';
import { logger } from '../lib/logger.js';

const LEADER_KEY = 'indexer:leader-election:replay';
const DEFAULT_LEASE_MS = 15_000;

export interface IndexerLeaderElectionOptions {
  /** Lease TTL in milliseconds. Default 15000. */
  leaseMs?: number;
  /** Heartbeat renewal interval in milliseconds. Default leaseMs / 3. */
  renewIntervalMs?: number;
  /** Identifier for this instance. Default `${pid}:${randomUUID()}`. */
  instanceId?: string;
}

export interface IndexerLeaderElection {
  /** Synchronous, in-memory check — safe to call in a hot loop. */
  isLeader(): boolean;
  /** Single non-blocking attempt to acquire (or confirm) leadership. */
  tryAcquire(): Promise<boolean>;
  /** Release the lease (if held) and stop the heartbeat. */
  release(): Promise<void>;
}

/**
 * Always-leader implementation used when Redis-backed election has not been
 * wired up (Redis disabled, or single-instance/dev/test deployments). This
 * preserves today's single-process behaviour unless explicitly configured.
 */
export class NoOpLeaderElection implements IndexerLeaderElection {
  isLeader(): boolean {
    return true;
  }

  async tryAcquire(): Promise<boolean> {
    return true;
  }

  async release(): Promise<void> {
    return;
  }
}

export class RedisIndexerLeaderElection implements IndexerLeaderElection {
  private readonly leaseMs: number;
  private readonly renewIntervalMs: number;
  private readonly instanceId: string;
  private _isLeader = false;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: RedisClient,
    opts: IndexerLeaderElectionOptions = {},
  ) {
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    this.renewIntervalMs = opts.renewIntervalMs ?? Math.floor(this.leaseMs / 3);
    this.instanceId = opts.instanceId ?? `${process.pid}:${crypto.randomUUID()}`;
  }

  isLeader(): boolean {
    return this._isLeader;
  }

  /**
   * Attempt to acquire the lease via `SET NX PX`. Fails safe: any Redis
   * error is treated as "not leader" rather than assuming leadership.
   *
   * Idempotent for the current holder: if the key is already held by this
   * same instanceId (e.g. a caller checks leadership before delegating to
   * another code path that also calls tryAcquire()), this returns `true`
   * without treating the "already exists" NX failure as a loss of
   * leadership.
   */
  async tryAcquire(): Promise<boolean> {
    try {
      const acquired = await this.redis.setNx(LEADER_KEY, this.instanceId, this.leaseMs);
      if (acquired) {
        this._isLeader = true;
        this.startHeartbeat();
        return true;
      }

      const current = await this.redis.get(LEADER_KEY);
      if (current === this.instanceId) {
        this._isLeader = true;
        if (!this.heartbeat) this.startHeartbeat();
        return true;
      }

      this._isLeader = false;
      return false;
    } catch (err) {
      logger.warn('Indexer leader election acquire failed', undefined, {
        instanceId: this.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
      this._isLeader = false;
      return false;
    }
  }

  /**
   * Release the lease and stop the heartbeat. Only deletes the key if it
   * still holds our instanceId — a lease renewed by a different instance
   * (because ours already expired) is never deleted here.
   *
   * Like `RedisDistributedLock.release()`, this is a check-then-act
   * sequence, not a Lua-atomic compare-and-delete. See docs/indexer.md for
   * why that risk is accepted.
   */
  async release(): Promise<void> {
    this.stopHeartbeat();
    this._isLeader = false;

    try {
      const current = await this.redis.get(LEADER_KEY);
      if (current === this.instanceId) {
        await this.redis.del(LEADER_KEY);
      }
    } catch (err) {
      logger.warn('Indexer leader election release failed', undefined, {
        instanceId: this.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const timer = setInterval(() => {
      void this.renew();
    }, this.renewIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.heartbeat = timer;
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /**
   * Renew the lease TTL, but only while we still hold it. Like `release()`,
   * this is a check-then-extend sequence rather than a Lua-atomic
   * compare-and-expire.
   */
  private async renew(): Promise<void> {
    try {
      const current = await this.redis.get(LEADER_KEY);
      if (current !== this.instanceId) {
        // Another instance holds the key (our lease already expired) or the
        // key is gone. Either way we are no longer the leader.
        this._isLeader = false;
        this.stopHeartbeat();
        return;
      }

      // `.exec()` never rejects for a per-command failure — ioredis (and the
      // fake) return `[Error | null, result]` tuples instead. Inspect the
      // tuple explicitly so a failed PEXPIRE is treated as a renewal failure
      // rather than silently ignored.
      const results = await this.redis.multi().pexpire(LEADER_KEY, this.leaseMs).exec();
      const [pexpireError] = results[0] ?? [];
      if (pexpireError) {
        throw pexpireError;
      }
    } catch (err) {
      logger.warn('Indexer leader election renewal failed', undefined, {
        instanceId: this.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
      this._isLeader = false;
      this.stopHeartbeat();
    }
  }
}

let defaultLeaderElection: IndexerLeaderElection = new NoOpLeaderElection();

/** Wire a Redis-backed leader election as the default used by `indexerService`. */
export function initializeIndexerLeaderElection(
  redis: RedisClient,
  opts?: IndexerLeaderElectionOptions,
): void {
  defaultLeaderElection = new RedisIndexerLeaderElection(redis, opts);
}

export function getIndexerLeaderElection(): IndexerLeaderElection {
  return defaultLeaderElection;
}

/** For testing only — resets the default back to always-leader. */
export function _resetIndexerLeaderElection(): void {
  defaultLeaderElection = new NoOpLeaderElection();
}
