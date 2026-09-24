/**
 * Distributed lock for adminState pause-flag persistence and reindex
 * serialization.
 *
 * Uses Redis SET with NX (not-exists) for atomic lock acquisition.
 * Supports timeout-based expiry to prevent deadlocks.
 * Falls back to file-based locking if Redis is unavailable.
 *
 * ## Lease duration
 *
 * Every acquisition writes the lock with an explicit **lease**: the Redis
 * backend issues `SET key value NX PX <leaseMs>` and the file backend treats
 * a lock file older than the lease as stale. The lease is the crash-recovery
 * bound — it decides how long a crashed holder (a process that dies without
 * calling `release()`) blocks everybody else:
 *
 * - **Redis backend:** the key self-expires no later than `leaseMs` after
 *   acquisition, so a crashed holder's lock is released within the lease.
 * - **File backend:** a contender that finds a lock file at least `leaseMs`
 *   old steals it (with a re-stat guard), so a crashed holder's lock is
 *   released within the lease as well. A revived crashed holder's later
 *   `release()` is ownership-checked and will not delete the new holder's
 *   lock.
 *
 * The lease is **configurable** via {@link RedisDistributedLockOptions.leaseMs}
 * and **defaults to {@link DEFAULT_LEASE_MS} (5000 ms)**. It is deliberately
 * independent of the acquisition timeout (`timeoutMs`, which only bounds how
 * long `acquire()` retries before throwing). The lock is not renewed while
 * held, so the lease must exceed the longest expected critical section —
 * pause-flag writes are sub-millisecond and the simulated reindex job runs
 * well under the default lease.
 *
 * ## Observability
 *
 * Lock acquisition and release are observable through structured log events
 * (see `src/lib/logger.ts`):
 *
 * - `admin_state_lock:acquired`      — lock taken; meta: `lockKey`,
 *   `lockNamespace`, `lockValue` (PID + timestamp + sequence), `leaseMs`,
 *   `backend` (`redis` | `file`), and (for Redis) `waitedMs`.
 * - `admin_state_lock:released`      — lock freed by its owner.
 * - `admin_state_lock:release_skipped` — release was a no-op because another
 *   holder now owns the lock (lease expired and was stolen).
 * - `admin_state_lock:stale_lock_stolen` — file backend stole a lock whose
 *   age reached the lease (holder presumed crashed).
 *
 * The store itself is observable too: while held, `admin-state:lock:<ns>`
 * exists in Redis (or the lock file exists in `os.tmpdir()`), and both are
 * gone after a successful release.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RedisClient } from '../redis/client.js';
import { logger } from '../lib/logger.js';

export interface Lock {
  acquire(): Promise<Lock>;
  release(): Promise<void>;
}

const LOCK_KEY_PREFIX = 'admin-state:lock:';
const LOCK_POLL_MS = 50;

/**
 * Default maximum time (ms) `acquire()` retries lock acquisition before
 * throwing `AdminStateLockError`. Independent of the lease duration.
 */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 5000;

/**
 * Default lease duration (ms). A crashed holder blocks other acquirers for at
 * most this long; see the module documentation ("Lease duration").
 */
export const DEFAULT_LEASE_MS = 5000;

/**
 * Lock namespace for reindex operations.  Acquired by `triggerReindex()`
 * to prevent overlapping reindex jobs across independent process instances
 * sharing the same Redis backend.
 */
export const REINDEX_LOCK_NAMESPACE = 'reindex';

/**
 * Monotonic per-process sequence appended to lock values so two acquisitions
 * in the same millisecond (same PID) still produce distinct ownership tokens.
 */
let lockSequence = 0;

export class AdminStateLockError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AdminStateLockError';
  }
}

export interface RedisDistributedLockOptions {
  /**
   * Maximum time (ms) to retry lock acquisition before throwing.
   * Defaults to {@link DEFAULT_ACQUIRE_TIMEOUT_MS} (5000 ms).  Tests may use
   * a shorter value to avoid slow timeouts when contention is expected.
   * This does NOT change how long the lock is held — see `leaseMs`.
   */
  timeoutMs?: number;
  /**
   * Lease duration (ms) — the `PX` TTL written with the Redis lock key, and
   * the staleness threshold for the file-lock fallback. This decides how long
   * a crashed holder's lock blocks other acquirers: the lock is guaranteed to
   * be releasable by someone else no later than `leaseMs` after acquisition.
   * Defaults to {@link DEFAULT_LEASE_MS} (5000 ms). Must be a positive,
   * finite number and should exceed the longest expected critical section
   * (the lock is not renewed while held).
   */
  leaseMs?: number;
}

export class RedisDistributedLock implements Lock {
  private readonly timeoutMs: number;
  private readonly leaseMs: number;

  constructor(
    private readonly redis: RedisClient,
    private readonly lockNamespace: string,
    options?: RedisDistributedLockOptions,
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    this.leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0) {
      throw new AdminStateLockError(
        `Invalid lease duration: ${this.leaseMs} (leaseMs must be a positive finite number of milliseconds)`,
      );
    }
  }

  /**
   * Acquire a distributed lock via Redis.
   * Returns immediately on success; throws if lock cannot be acquired within
   * `timeoutMs`. The acquired key expires after the configured lease so a
   * crashed holder cannot block others beyond the lease.
   */
  async acquire(): Promise<Lock> {
    const lockKey = `${LOCK_KEY_PREFIX}${this.lockNamespace}`;
    const lockValue = `${process.pid}:${Date.now()}:${lockSequence++}`;
    const maxRetries = Math.ceil(this.timeoutMs / LOCK_POLL_MS);
    const startedAt = Date.now();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let acquired = false;
      try {
        acquired = await this.redis.setNx(lockKey, lockValue, this.leaseMs);
      } catch (err) {
        logger.warn('Redis lock acquisition failed, falling back to file lock', undefined, {
          lockKey,
          error: err instanceof Error ? err.message : String(err),
        });
        return this._acquireFileLock(lockValue);
      }

      if (acquired) {
        logger.info('admin_state_lock:acquired', undefined, {
          lockKey,
          lockNamespace: this.lockNamespace,
          lockValue,
          leaseMs: this.leaseMs,
          backend: 'redis',
          waitedMs: Date.now() - startedAt,
        });
        return {
          acquire: async () => this.acquire(),
          release: async () => {
            try {
              if (this.redis.delIfValue) {
                await this.redis.delIfValue(lockKey, lockValue);
                logger.info('admin_state_lock:released', undefined, {
                  lockKey,
                  lockNamespace: this.lockNamespace,
                  lockValue,
                  backend: 'redis',
                });
              } else if ((await this.redis.get(lockKey)) === lockValue) {
                await this.redis.del(lockKey);
                logger.info('admin_state_lock:released', undefined, {
                  lockKey,
                  lockNamespace: this.lockNamespace,
                  lockValue,
                  backend: 'redis',
                });
              } else {
                logger.info('admin_state_lock:release_skipped', undefined, {
                  lockKey,
                  lockNamespace: this.lockNamespace,
                  lockValue,
                  backend: 'redis',
                  reason: 'not_owner_or_expired',
                });
              }
            } catch (err) {
              logger.warn('Failed to release admin state lock', undefined, {
                lockKey,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        };
      }

      // Fixed poll interval between acquisition attempts.
      await sleep(LOCK_POLL_MS);
    }

    throw new AdminStateLockError(
      `Failed to acquire admin state lock after ${this.timeoutMs}ms`,
    );
  }

  /**
   * Release the distributed lock for this instance's namespace directly.
   */
  async release(): Promise<void> {
    const lockKey = `${LOCK_KEY_PREFIX}${this.lockNamespace}`;
    try {
      await this.redis.del(lockKey);
      logger.info('admin_state_lock:released', undefined, {
        lockKey,
        lockNamespace: this.lockNamespace,
        backend: 'redis',
      });
    } catch (err) {
      logger.warn('Failed to release admin state lock', undefined, {
        lockKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Lock-file path for this namespace inside the OS temp directory. */
  private _fileLockPath(): string {
    return path.join(os.tmpdir(), `fluxora-admin-state-${this.lockNamespace}.lock`);
  }

  /**
   * File-based lock fallback used when Redis is unavailable.
   *
   * Acquisition uses `O_CREAT | O_EXCL` for atomicity. Contenders poll until
   * `timeoutMs` elapses; a lock file whose age has reached the lease is
   * presumed to belong to a crashed holder and is stolen so the lock is
   * released within the lease even without Redis.
   */
  private async _acquireFileLock(lockValue: string): Promise<Lock> {
    const lockFile = this._fileLockPath();
    const deadline = Date.now() + this.timeoutMs;

    for (;;) {
      try {
        const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        try {
          fs.writeSync(fd, `${lockValue}\n`);
        } finally {
          fs.closeSync(fd);
        }

        logger.info('admin_state_lock:acquired', undefined, {
          lockKey: lockFile,
          lockNamespace: this.lockNamespace,
          lockValue,
          leaseMs: this.leaseMs,
          backend: 'file',
        });

        return {
          acquire: async () => this.acquire(),
          release: async () => this._releaseFileLock(lockFile, lockValue),
        };
      } catch (err) {
        const error = err as NodeJS.ErrnoException;
        if (error.code !== 'EEXIST') {
          throw new AdminStateLockError(`Failed to create lock file: ${error.message}`, err);
        }
      }

      // Lease-based crash recovery: steal a lock file held past the lease.
      if (this._stealStaleFileLock(lockFile)) {
        continue;
      }

      if (Date.now() >= deadline) {
        break;
      }

      await sleep(LOCK_POLL_MS);
    }

    throw new AdminStateLockError(
      `Failed to acquire file lock after ${this.timeoutMs}ms`,
    );
  }

  /**
   * Steal a lock file whose holder has exceeded the lease (presumed crashed).
   *
   * @returns `true` when the caller should immediately retry creation (the
   *   file was stale and removed, or vanished); `false` when the lock is
   *   still fresh (or the file could not be removed).
   */
  private _stealStaleFileLock(lockFile: string): boolean {
    let ageMs = 0;
    try {
      const stat = fs.statSync(lockFile);
      ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < this.leaseMs) {
        return false;
      }
      // Re-stat before unlink: if the file changed since the first stat, the
      // original holder released and someone else re-acquired — that fresh
      // lock must not be stolen.
      const again = fs.statSync(lockFile);
      if (again.mtimeMs !== stat.mtimeMs) {
        return false;
      }
      ageMs = Date.now() - again.mtimeMs;
      if (ageMs < this.leaseMs) {
        return false;
      }
      fs.rmSync(lockFile, { force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // File vanished — retry acquisition immediately.
        return true;
      }
      // Unremovable lock (permissions etc.) — keep polling until the deadline.
      return false;
    }

    logger.info('admin_state_lock:stale_lock_stolen', undefined, {
      lockKey: lockFile,
      lockNamespace: this.lockNamespace,
      leaseMs: this.leaseMs,
      ageMs,
      backend: 'file',
    });
    return true;
  }

  /**
   * Release the file lock, but only when this holder still owns it. A holder
   * whose lease expired and whose lock was stolen must not delete the new
   * holder's lock file.
   */
  private async _releaseFileLock(lockFile: string, lockValue: string): Promise<void> {
    try {
      let current: string;
      try {
        current = fs.readFileSync(lockFile, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          logger.info('admin_state_lock:released', undefined, {
            lockKey: lockFile,
            lockNamespace: this.lockNamespace,
            lockValue,
            backend: 'file',
          });
          return;
        }
        throw err;
      }

      if (current.trim() !== lockValue) {
        logger.info('admin_state_lock:release_skipped', undefined, {
          lockKey: lockFile,
          lockNamespace: this.lockNamespace,
          lockValue,
          heldValue: current.trim(),
          backend: 'file',
          reason: 'not_owner_or_expired',
        });
        return;
      }

      fs.rmSync(lockFile, { force: true });
      logger.info('admin_state_lock:released', undefined, {
        lockKey: lockFile,
        lockNamespace: this.lockNamespace,
        lockValue,
        backend: 'file',
      });
    } catch (err) {
      logger.warn('Failed to release file lock', undefined, {
        lockFile,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * No-op lock for when locking is disabled or unavailable.
 */
export class NoOpLock implements Lock {
  async acquire(): Promise<Lock> {
    return this;
  }

  async release(): Promise<void> {
    return;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
