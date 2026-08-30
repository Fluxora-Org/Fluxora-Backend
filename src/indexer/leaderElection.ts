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
 *
 * ## Clock-anomaly safety
 *
 * Lease expiry is enforced by the Redis server, which uses its own monotonic
 * clock (server-side TTL via `SET … PX` / `PEXPIRE`). This means NTP jumps or
 * wall-clock skew on the local node do not affect *when* the key expires in
 * Redis — only the Redis server's clock matters for lease validity.
 *
 * The remaining local-clock risk is in the heartbeat scheduler: if the process
 * is paused (GC, VM suspend, NTP step-forward) long enough that the renewal
 * interval fires *after* the Redis TTL has already lapsed, another instance
 * may have legitimately acquired the lease. In that case `renew()` will detect
 * the key is held by someone else and self-revoke on the next tick — the
 * correct safe outcome.
 *
 * To make this behaviour explicit and independently testable the implementation
 * tracks `_lastRenewAttemptMs` (wall-clock time of the previous heartbeat tick)
 * using an injectable `clockNowMs` function. When the elapsed time since the
 * last renewal attempt **exceeds the full lease duration**, the process
 * conservatively self-revokes without contacting Redis — any leader that was
 * unable to contact Redis for a full lease period cannot know whether its lease
 * is still valid, so dropping leadership is the safe choice.
 *
 * Backward clock jumps (NTP step-back, monotonic counter reset after reboot)
 * are handled by clamping: elapsed time is treated as zero whenever
 * `clockNowMs() < _lastRenewAttemptMs`, so a backward step never causes a
 * spurious self-revocation.
 *
 * ### Fencing token
 *
 * Every fresh acquisition atomically increments a shared Redis counter
 * (`FENCE_KEY`). Callers that write to shared state must carry the fencing
 * token and the backing store must reject writes carrying a token older than
 * the current epoch — this prevents a stale leader that missed revocation from
 * committing writes after a new leader has taken over (split-brain prevention).
 */

import * as crypto from 'node:crypto';
import type { RedisClient } from '../redis/client.js';
import { logger } from '../lib/logger.js';

const LEADER_KEY = 'indexer:leader-election:replay';
const FENCE_KEY = 'indexer:leader-election:replay:fence';
const DEFAULT_LEASE_MS = 15_000;

export interface IndexerLeaderElectionOptions {
  /** Lease TTL in milliseconds. Default 15000. */
  leaseMs?: number;
  /** Heartbeat renewal interval in milliseconds. Default leaseMs / 3. */
  renewIntervalMs?: number;
  /** Identifier for this instance. Default `${pid}:${randomUUID()}`. */
  instanceId?: string;
  /**
   * Monotonic clock source used to detect missed-renewal windows caused by
   * local wall-clock anomalies (forward jumps, GC pauses, VM suspend/resume).
   *
   * Defaults to `Date.now`. In tests, inject a controlled function to simulate
   * clock anomalies without relying on `vi.useFakeTimers`.
   *
   * The implementation uses this clock **only** to detect whether a heartbeat
   * fired so late that the full lease duration has elapsed since the previous
   * renewal attempt. Lease expiry itself is always enforced by the Redis server.
   */
  clockNowMs?: () => number;
}

export interface IndexerLeaderElection {
  /** Synchronous, in-memory check — safe to call in a hot loop. */
  isLeader(): boolean;
  /** Single non-blocking attempt to acquire (or confirm) leadership. */
  tryAcquire(): Promise<boolean>;
  /** Release the lease (if held) and stop the heartbeat. */
  release(): Promise<void>;
  /**
   * Monotonically increasing fencing token for the current leadership epoch.
   * A stale leader (whose lease expired and was re-acquired by another
   * instance) retains its old, lower token; writes carrying that token must
   * be rejected by the store so a split-brain worker cannot commit.
   */
  getFencingToken(): number;
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

  getFencingToken(): number {
    return 0;
  }
}

export class RedisIndexerLeaderElection implements IndexerLeaderElection {
  private readonly leaseMs: number;
  private readonly renewIntervalMs: number;
  private readonly instanceId: string;
  private readonly clockNowMs: () => number;
  private _isLeader = false;
  private _fencingToken = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  /**
   * Wall-clock timestamp of the last heartbeat attempt, as reported by
   * `clockNowMs`. Initialised to 0 (no renewal attempted yet).
   *
   * Used exclusively to detect missed-renewal windows: if the current time
   * minus this value exceeds `leaseMs`, the process was paused or the clock
   * jumped forward long enough that the Redis TTL has almost certainly lapsed,
   * so the implementation self-revokes rather than issuing a speculative GET.
   */
  private _lastRenewAttemptMs = 0;

  constructor(
    private readonly redis: RedisClient,
    opts: IndexerLeaderElectionOptions = {},
  ) {
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    this.renewIntervalMs = opts.renewIntervalMs ?? Math.floor(this.leaseMs / 3);
    this.instanceId = opts.instanceId ?? `${process.pid}:${crypto.randomUUID()}`;
    this.clockNowMs = opts.clockNowMs ?? (() => Date.now());
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
        // Fresh acquisition: bump the shared fencing counter so any previous
        // leader's token becomes stale. The new token is strictly greater
        // than every token issued before this epoch.
        this._fencingToken = await this.redis.incr(FENCE_KEY);
        this._isLeader = true;
        // Record the clock time of this acquisition as the first "renewal
        // attempt" so the forward-jump guard has a baseline to compare against.
        this._lastRenewAttemptMs = this.clockNowMs();
        this.startHeartbeat();
        return true;
      }

      const current = await this.redis.get(LEADER_KEY);
      if (current === this.instanceId) {
        // We already hold the lease (idempotent re-confirm). Re-read the
        // current fencing token so a re-acquire after a reconnect observes
        // the latest epoch.
        this._fencingToken = await this.readFencingToken();
        this._isLeader = true;
        if (!this.heartbeat) {
          this._lastRenewAttemptMs = this.clockNowMs();
          this.startHeartbeat();
        }
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

  getFencingToken(): number {
    return this._fencingToken;
  }

  /** Read the current shared fencing counter (0 when never acquired). */
  private async readFencingToken(): Promise<number> {
    const raw = await this.redis.get(FENCE_KEY);
    const parsed = raw === null ? 0 : Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
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
   *
   * ### Clock-anomaly guard
   *
   * Before contacting Redis, the implementation checks whether the local clock
   * has advanced by more than `leaseMs` since the previous renewal attempt.
   * This catches forward jumps (NTP corrections, GC pauses, VM resume) where
   * the heartbeat timer fired so late that the Redis TTL has almost certainly
   * already lapsed.  In that case the process self-revokes immediately —
   * contacting Redis at this point would only confirm what we already know.
   *
   * Backward jumps are safe: elapsed time is clamped to zero when
   * `clockNowMs() < _lastRenewAttemptMs`, so a backward step never triggers
   * a spurious self-revocation.
   */
  private async renew(): Promise<void> {
    const now = this.clockNowMs();
    const elapsed = Math.max(0, now - this._lastRenewAttemptMs);

    // Forward-jump guard: if the local clock has advanced by a full lease
    // duration since the last renewal, the TTL has almost certainly expired
    // on the Redis side. Self-revoke without checking Redis.
    if (this._lastRenewAttemptMs > 0 && elapsed >= this.leaseMs) {
      logger.warn('Indexer leader election: clock anomaly detected — elapsed time since last renewal exceeds lease duration, self-revoking', undefined, {
        instanceId: this.instanceId,
        elapsedMs: elapsed,
        leaseMs: this.leaseMs,
      });
      this._isLeader = false;
      this.stopHeartbeat();
      return;
    }

    this._lastRenewAttemptMs = now;

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
