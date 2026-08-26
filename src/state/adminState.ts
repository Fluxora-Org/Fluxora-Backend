/**
 * Centralized admin state for operator-grade controls.
 *
 * Holds pause flags and reindex tracking in memory, with file-backed
 * persistence for pause flags so admin toggles survive process restarts.
 *
 * Pause-flag writes are protected by a distributed lock (Redis-backed with file lock fallback)
 * to ensure safe concurrent writes across multiple processes.
 */

import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { NoOpRedisClient, type RedisClient } from '../redis/client.js';
import { RedisDistributedLock, NoOpLock, Lock, AdminStateLockError, REINDEX_LOCK_NAMESPACE } from './adminStateLock.js';
import { logger } from '../lib/logger.js';
import { adminReindexJobDurationSeconds } from '../metrics/businessMetrics.js';

export interface PauseFlags {
  /** Block new stream creation via the public API. */
  streamCreation: boolean;
  /** Halt the Horizon / chain-event ingestion worker. */
  ingestion: boolean;
}

export type ReindexStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface ReindexState {
  status: ReindexStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  processedItems: number;
}

interface AdminState {
  pauseFlags: PauseFlags;
  reindex: ReindexState;
}

interface PersistedAdminStateV1 {
  version: 1;
  pauseFlags: PauseFlags;
}

const DEFAULT_ADMIN_STATE_FILE = '/tmp/fluxora-admin-state.json';

const state: AdminState = {
  pauseFlags: {
    streamCreation: false,
    ingestion: false,
  },
  reindex: {
    status: 'idle',
    startedAt: null,
    completedAt: null,
    error: null,
    processedItems: 0,
  },
};

let pauseFlagsLock: Lock | null = null;
let reindexLock: Lock | null = null;

hydratePauseFlagsFromPersistence();

export class AdminStatePersistenceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AdminStatePersistenceError';
  }
}

function resolveAdminStatePath(): string {
  const configured = process.env.ADMIN_STATE_FILE?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_ADMIN_STATE_FILE;
}

function isPauseFlags(value: unknown): value is PauseFlags {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.streamCreation === 'boolean' && typeof candidate.ingestion === 'boolean';
}

function readPersistedPauseFlags(): PauseFlags | null {
  try {
    const raw = fs.readFileSync(resolveAdminStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (isPauseFlags(parsed)) {
      return { ...parsed };
    }

    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as Partial<PersistedAdminStateV1>).version === 1 &&
      isPauseFlags((parsed as Partial<PersistedAdminStateV1>).pauseFlags)
    ) {
      return { ...(parsed as PersistedAdminStateV1).pauseFlags };
    }

    logger.warn('Ignoring invalid persisted admin state payload', undefined, {
      adminStatePath: resolveAdminStatePath(),
    });
    return null;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return null;
    }

    logger.warn('Failed to read persisted admin state', undefined, {
      adminStatePath: resolveAdminStatePath(),
      error: error.message,
    });
    return null;
  }
}

async function writePersistedPauseFlags(flags: PauseFlags): Promise<void> {
  const lock = await acquirePauseFlagsLock();
  try {
    const adminStatePath = resolveAdminStatePath();
    const tempPath = `${adminStatePath}.${process.pid}.tmp`;
    const payload: PersistedAdminStateV1 = {
      version: 1,
      pauseFlags: {
        streamCreation: flags.streamCreation,
        ingestion: flags.ingestion,
      },
    };

    fs.mkdirSync(dirname(adminStatePath), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(tempPath, adminStatePath);
    } catch (err) {
      // Best effort cleanup for failed atomic writes.
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // no-op
      }
      throw err;
    }
  } finally {
    await lock.release();
  }
}

function hydratePauseFlagsFromPersistence(): void {
  const persisted = readPersistedPauseFlags();
  if (!persisted) return;
  state.pauseFlags = persisted;
}

/**
 * Initialize distributed locking for admin state with a Redis client.
 * Call this during app startup after Redis is available.
 * Creates locks for both pause flags and reindex operations.
 * If not called, file-based locking will be used as fallback for pause flags
 * and no distributed lock will protect reindex across processes.
 */
export function initializeAdminStateLock(redis: RedisClient): void {
  pauseFlagsLock = new RedisDistributedLock(redis, 'pauseFlags');
  reindexLock = new RedisDistributedLock(redis, REINDEX_LOCK_NAMESPACE);
}

async function acquirePauseFlagsLock(): Promise<Lock> {
  if (!pauseFlagsLock) {
    pauseFlagsLock = new RedisDistributedLock(
      new NoOpRedisClient(),
      'pauseFlags',
    );
  }
  const lock = pauseFlagsLock;
  if (!lock) {
    throw new AdminStateLockError('pauseFlagsLock is not initialized');
  }
  return lock.acquire();
}

export function getPauseFlags(): PauseFlags {
  return { ...state.pauseFlags };
}

export async function setPauseFlags(flags: Partial<PauseFlags>): Promise<PauseFlags> {
  const next: PauseFlags = {
    streamCreation:
      flags.streamCreation !== undefined ? flags.streamCreation : state.pauseFlags.streamCreation,
    ingestion: flags.ingestion !== undefined ? flags.ingestion : state.pauseFlags.ingestion,
  };

  if (
    next.streamCreation === state.pauseFlags.streamCreation &&
    next.ingestion === state.pauseFlags.ingestion
  ) {
    return { ...state.pauseFlags };
  }

  try {
    await writePersistedPauseFlags(next);
  } catch (err) {
    throw new AdminStatePersistenceError('Failed to persist admin pause flags', err);
  }

  state.pauseFlags = next;
  return { ...state.pauseFlags };
}

export function isStreamCreationPaused(): boolean {
  return state.pauseFlags.streamCreation;
}

export function getReindexState(): ReindexState {
  return { ...state.reindex };
}

/**
 * Kick off a simulated reindex. In production this would trigger a
 * Horizon replay or database rebuild from chain events.
 *
 * Acquires a distributed lock (Redis-backed) for the entire duration of the
 * reindex job to prevent overlapping reindex jobs across independent process
 * instances sharing the same Redis.  If the lock cannot be acquired, the
 * caller receives the current state so the route layer can return 409.
 *
 * @security The lock key includes a PID + timestamp for auditability.
 *           Lock expiry (TTL) prevents deadlocks if the process crashes
 *           while holding the lock.
 */
export async function triggerReindex(): Promise<ReindexState> {
  // Fast path: if already running (same process), short-circuit.
  if (state.reindex.status === 'running') {
    return { ...state.reindex };
  }

  // If a distributed lock is available, serialize across processes.
  if (reindexLock) {
    let lock: Lock | null = null;
    try {
      lock = await reindexLock.acquire();
    } catch {
      // Lock acquisition failed — another instance holds it or Redis is down.
      // Return current state so the route layer can return 409.
      return { ...state.reindex };
    }

    // Re-check after acquiring lock (double-checked locking pattern).
    // Cast to widen: `state.reindex` may have been reassigned by a concurrent
    // caller during the `await` above, but TS's narrowing from the early
    // return doesn't account for mutation across an await boundary.
    if ((state.reindex.status as ReindexStatus) === 'running') {
      await lock.release();
      return { ...state.reindex };
    }

    state.reindex = {
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      processedItems: 0,
    };

    const result = { ...state.reindex };

    // Fire-and-forget: the job runs in the background.  The lock is held
    // for the entire job duration so no other process can start a reindex.
    runReindexJob()
      .catch(() => { /* errors are captured in state */ })
      .finally(() => { lock!.release().catch(() => {}); });

    return result;
  }

  // Fallback: no distributed lock configured (file-lock or single-process).
  state.reindex = {
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    processedItems: 0,
  };

  runReindexJob().catch(() => { /* errors are captured in state */ });

  return { ...state.reindex };
}

/**
 * Kick off a simulated reindex for a specific stream.
 * In production this would trigger a stream-specific Horizon replay.
 */
export async function triggerStreamReindex(streamId: string): Promise<ReindexState> {
  logger.info('Triggering stream-specific reindex', undefined, { streamId });
  return triggerReindex();
}

async function runReindexJob(): Promise<void> {
  const endTimer = adminReindexJobDurationSeconds.startTimer();
  try {
    // Simulate incremental reindex work (placeholder for Horizon replay).
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      await sleep(50);
      state.reindex.processedItems = i;
    }
    state.reindex.status = 'completed';
    state.reindex.completedAt = new Date().toISOString();
    endTimer({ outcome: 'success' });
  } catch (err) {
    state.reindex.status = 'failed';
    state.reindex.completedAt = new Date().toISOString();
    state.reindex.error = err instanceof Error ? err.message : String(err);
    endTimer({ outcome: 'failure' });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reset state — only exposed for tests. */
export function _resetForTest(options: { clearPersistence?: boolean; clearLock?: boolean } = {}): void {
  state.pauseFlags.streamCreation = false;
  state.pauseFlags.ingestion = false;
  state.reindex = {
    status: 'idle',
    startedAt: null,
    completedAt: null,
    error: null,
    processedItems: 0,
  };

  if (options.clearLock !== false) {
    pauseFlagsLock = null;
    reindexLock = null;
  }

  if (options.clearPersistence !== false) {
    try {
      fs.rmSync(resolveAdminStatePath(), { force: true });
    } catch {
      // no-op
    }
  }
}

/**
 * Set the distributed lock instance used by `triggerReindex()`.
 * Exported for integration testing — allows tests to inject a lock backed
 * by a shared FakeRedisClient to simulate cross-process serialization.
 * @security Only for testing; never called in production code paths.
 */
export function _setReindexLockForTest(lock: Lock | null): void {
  reindexLock = lock as RedisDistributedLock | null;
}

export function _reloadPauseFlagsFromPersistenceForTest(): void {
  const persisted = readPersistedPauseFlags();
  if (!persisted) {
    state.pauseFlags = {
      streamCreation: false,
      ingestion: false,
    };
    return;
  }
  state.pauseFlags = persisted;
}

/**
 * Checks whether the configured `ADMIN_STATE_FILE` path is writable at startup.
 *
 * Performs a write-and-delete probe using a `.probe` sentinel file in the same
 * directory as the admin state file. If the probe fails (e.g. read-only
 * container filesystem), a structured warning is emitted but the server
 * continues to start — in-memory pause flags remain fully functional without
 * persistence.
 *
 * Security: the probe file path is derived solely from the server-controlled
 * environment variable and is not logged in the warning to avoid leaking
 * internal directory structure in security-sensitive deployments.
 *
 * @returns A promise that resolves to `true` if the path is writable, or
 *   `false` if the write probe failed.
 */
export async function checkAdminStatePersistence(): Promise<boolean> {
  const adminStatePath = resolveAdminStatePath();
  const dir = dirname(adminStatePath);
  const probePath = join(dir, '.fluxora-admin-state.probe');

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(probePath, '', { encoding: 'utf8', mode: 0o600 });
    fs.rmSync(probePath, { force: true });
    return true;
  } catch {
    logger.warn('Admin state file path is not writable; pause flags will not persist across restarts', undefined, {
      event: 'admin_state_file_not_writable',
    });
    return false;
  }
}
