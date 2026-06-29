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
  release(): Promise<void>;
}

const LOCK_KEY_PREFIX = 'admin-state:lock:';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 50;
const LOCK_MAX_RETRIES = Math.ceil(LOCK_TIMEOUT_MS / LOCK_POLL_MS);

export class AdminStateLockError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AdminStateLockError';
  }
}

export class RedisDistributedLock {
  constructor(
    private readonly redis: RedisClient,
    private readonly lockNamespace: string,
  ) {}

  /**
   * Acquire a distributed lock via Redis.
   * Returns immediately on success; throws if lock cannot be acquired within timeout.
   */
  async acquire(): Promise<Lock> {
    const lockKey = `${LOCK_KEY_PREFIX}${this.lockNamespace}`;
    const lockValue = `${process.pid}:${Date.now()}`;

    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
      try {
        const acquired = await this.redis.setNx(lockKey, lockValue, LOCK_TIMEOUT_MS);
        if (acquired) {
          return {
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
      `Failed to acquire admin state lock after ${LOCK_TIMEOUT_MS}ms`,
    );
  }

  private async _acquireFileLock(): Promise<Lock> {
    const lockFile = `/tmp/fluxora-admin-state-${this.lockNamespace}.lock`;

    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
      try {
        const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        fs.writeSync(fd, `${process.pid}\n`);
        fs.closeSync(fd);

        return {
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
  async release(): Promise<void> {
    return;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
