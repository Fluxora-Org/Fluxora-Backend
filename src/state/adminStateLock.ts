/**
 * Distributed lock for adminState pause-flag persistence.
 *
 * Uses Redis SET with NX (not-exists) for atomic lock acquisition.
 * Supports timeout-based expiry to prevent deadlocks.
 * Falls back to file-based locking if Redis is unavailable.
 */

import * as fs from 'node:fs';
import type { RedisClient } from '../redis/client.js';
import { logger } from '../lib/logger.js';

export interface Lock {
  acquire(): Promise<Lock>;
  release(): Promise<void>;
}

const LOCK_KEY_PREFIX = 'admin-state:lock:';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 50;
const LOCK_MAX_RETRIES = Math.ceil(LOCK_TIMEOUT_MS / LOCK_POLL_MS);

/**
 * Lock namespace for reindex operations.  Acquired by `triggerReindex()`
 * to prevent overlapping reindex jobs across independent process instances
 * sharing the same Redis backend.
 */
export const REINDEX_LOCK_NAMESPACE = 'reindex';

export class AdminStateLockError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AdminStateLockError';
  }
}

export interface RedisDistributedLockOptions {
  /**
   * Maximum time (ms) to retry lock acquisition before throwing.
   * Defaults to `LOCK_TIMEOUT_MS` (5000 ms).  Tests may use a shorter
   * value to avoid slow timeouts when contention is expected.
   */
  timeoutMs?: number;
}

export class RedisDistributedLock implements Lock {
  private readonly timeoutMs: number;

  constructor(
    private readonly redis: RedisClient,
    private readonly lockNamespace: string,
    options?: RedisDistributedLockOptions,
  ) {
    this.timeoutMs = options?.timeoutMs ?? LOCK_TIMEOUT_MS;
  }

  /**
   * Acquire a distributed lock via Redis.
   * Returns immediately on success; throws if lock cannot be acquired within timeout.
   */
  async acquire(): Promise<Lock> {
    const lockKey = `${LOCK_KEY_PREFIX}${this.lockNamespace}`;
    const lockValue = `${process.pid}:${Date.now()}`;
    const maxRetries = Math.ceil(this.timeoutMs / LOCK_POLL_MS);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const acquired = await this.redis.setNx(lockKey, lockValue, this.timeoutMs);
        if (acquired) {
          return {
            acquire: async () => this.acquire(),
            release: async () => {
              try {
                await this.redis.del(lockKey);
              } catch (err) {
                logger.warn('Failed to release admin state lock', undefined, {
                  lockKey,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            },
          };
        }
      } catch (err) {
        logger.warn('Redis lock acquisition failed, falling back to file lock', undefined, {
          lockKey,
          error: err instanceof Error ? err.message : String(err),
        });
        return this._acquireFileLock();
      }

      // Exponential backoff: 50ms base, capped at LOCK_POLL_MS
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
    } catch (err) {
      logger.warn('Failed to release admin state lock', undefined, {
        lockKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async _acquireFileLock(): Promise<Lock> {
    const lockFile = `/tmp/fluxora-admin-state-${this.lockNamespace}.lock`;

    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
      try {
        const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        fs.writeSync(fd, `${process.pid}\n`);
        fs.closeSync(fd);

        return {
          acquire: async () => this.acquire(),
          release: async () => {
            try {
              fs.rmSync(lockFile, { force: true });
            } catch (err) {
              logger.warn('Failed to release file lock', undefined, {
                lockFile,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        };
      } catch (err) {
        const error = err as NodeJS.ErrnoException;
        if (error.code !== 'EEXIST') {
          throw new AdminStateLockError(`Failed to create lock file: ${error.message}`, err);
        }
      }

      await sleep(LOCK_POLL_MS);
    }

    throw new AdminStateLockError(
      `Failed to acquire file lock after ${LOCK_TIMEOUT_MS}ms`,
    );
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
