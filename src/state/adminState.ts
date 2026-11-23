import { getRuntimeEnv } from '../config/runtime-env.js';
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
import { RedisDistributedLock, Lock, AdminStateLockError, REINDEX_LOCK_NAMESPACE } from './adminStateLock.js';
import { logger } from '../lib/logger.js';
import { adminReindexJobDurationSeconds } from '../metrics/businessMetrics.js';
import { requestStopReplay } from '../indexer/replayRuntimeState.js';

export interface PauseFlags {
  /** Block new stream creation via the public API. */
  streamCreation: boolean;
  /** Halt the Horizon / chain-event ingestion worker. */
  ingestion: boolean;
}

export type ReindexStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

/** What a reindex replays: one contract's events on one ledger, optionally bounded by block. */
export interface ReindexTarget {
  contract_id: string;
  ledger: number;
  from_block?: number;
  to_block?: number;
}

export interface ReindexState {
  status: ReindexStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  /** Source rows committed so far, taken from replay batch results. */
  processedItems: number;
  /** Source rows the replay will process; null until the replay has counted them. */
  totalItems: number | null;
  /** The range being (or last) replayed; null before the first reindex. */
  target: ReindexTarget | null;
}

/**
 * The replay machinery a reindex drives. Production uses
 * {@link indexerReplayRunner}; tests inject a fake via `_setReindexRunnerForTest`.
 */
export interface ReindexRunner {
  /**
   * Replay `target`, calling `onProgress` with cumulative counts. Resolves
   * with how the replay ended; rejects if it failed.
   */
  run(
    target: ReindexTarget,
    onProgress: (update: { processedRows: number; totalRows: number }) => void,
  ): Promise<{ outcome: 'completed' | 'cancelled'; processedRows: number; totalRows: number }>;
  /** Ask the running replay to stop at its next safe batch boundary. */
  cancel(): void;
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
  reindex: idleReindexState(),
};

function idleReindexState(): ReindexState {
  return {
    status: 'idle',
    startedAt: null,
    completedAt: null,
    error: null,
    processedItems: 0,
    totalItems: null,
    target: null,
  };
}

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
  const configured = getRuntimeEnv().ADMIN_STATE_FILE?.trim();
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
  return cloneReindexState(state.reindex);
}

function cloneReindexState(r: ReindexState): ReindexState {
  return { ...r, target: r.target ? { ...r.target } : null };
}

export function getReindexLock(): Lock | null {
  return reindexLock;
}

/**
 * Default runner: the indexer's DB-backed replay (`IndexerService.replayEvents`,
 * which drives `ReplayBatchRunner` one committed batch at a time). Loaded
 * lazily so importing admin state never pulls in the database layer.
 */
export const indexerReplayRunner: ReindexRunner = {
  async run(target, onProgress) {
    const { indexerService } = await import('../indexer/service.js');
    return indexerService.replayEvents(target, { onProgress });
  },
  cancel() {
    requestStopReplay();
  },
};

let reindexRunner: ReindexRunner = indexerReplayRunner;

/**
 * Start a reindex of `target` by replaying its events through the indexer.
 *
 * Progress (`processedItems` / `totalItems`) is updated from each committed
 * replay batch. The job ends as `completed` when the replay reaches the end of
 * its rows, `cancelled` after {@link cancelReindex}, or `failed` with the
 * replay's error message.
 *
 * When a distributed lock is configured it is held for the whole job, so
 * independent processes sharing Redis never run overlapping reindexes. If the
 * lock cannot be acquired, or a reindex is already running here, the caller
 * gets the current state back unchanged and the route layer answers 409.
 *
 * @security The lock key includes a PID + timestamp for auditability.
 *           Lock expiry (TTL) prevents deadlocks if the process crashes
 *           while holding the lock.
 */
export async function triggerReindex(target: ReindexTarget): Promise<ReindexState> {
  // Fast path: already running in this process.
  if (state.reindex.status === 'running') {
    return getReindexState();
  }

  let lock: Lock | null = null;
  if (reindexLock) {
    try {
      lock = await reindexLock.acquire();
    } catch {
      // Another process holds the reindex lock.
      return getReindexState();
    }

    // Re-check after the (async) acquire: another caller in this process may
    // have started a job while we waited.
    if ((state.reindex.status as ReindexStatus) === 'running') {
      await lock.release();
      return getReindexState();
    }
  }

  state.reindex = {
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    processedItems: 0,
    totalItems: null,
    target: { ...target },
  };
  const started = getReindexState();
  const job = state.reindex;

  runReindexJob(job, reindexRunner)
    .catch(() => {
      /* errors are captured in state */
    })
    .finally(() => {
      lock?.release().catch(() => {});
    });

  return started;
}

/**
 * Reindex the events behind one stream: the stream's contract on `range.ledger`,
 * optionally bounded by block. Throws if the stream does not exist or a reindex
 * is already running, so bulk callers report the item as failed rather than
 * claiming work that was never started.
 */
export async function triggerStreamReindex(
  streamId: string,
  range: Omit<ReindexTarget, 'contract_id'>,
): Promise<ReindexState> {
  const { streamRepository } = await import('../db/repositories/streamRepository.js');
  const stream = await streamRepository.getById(streamId);
  if (!stream) {
    throw new Error(`Stream ${streamId} not found`);
  }

  if (state.reindex.status === 'running') {
    throw new Error('A reindex operation is already in progress.');
  }

  logger.info('Triggering stream-specific reindex', undefined, {
    streamId,
    contractId: stream.contract_id,
    ledger: range.ledger,
  });
  const result = await triggerReindex({ ...range, contract_id: stream.contract_id });
  if (result.status !== 'running' || result.target?.contract_id !== stream.contract_id) {
    throw new Error('A reindex operation is already in progress.');
  }
  return result;
}

/**
 * Ask the running reindex to stop. The replay finishes its in-flight batch
 * boundary, keeps every committed batch, and the job ends as `cancelled`.
 * Returns the current state; a no-op when nothing is running.
 */
export function cancelReindex(): ReindexState {
  if (state.reindex.status === 'running') {
    logger.info('Cancelling reindex', undefined, { target: state.reindex.target });
    reindexRunner.cancel();
  }
  return getReindexState();
}

async function runReindexJob(job: ReindexState, runner: ReindexRunner): Promise<void> {
  const endTimer = adminReindexJobDurationSeconds.startTimer();
  // `job` is the state object for this run; a test reset swaps in a new one,
  // so a late-finishing job never overwrites a newer state.
  const isCurrent = () => state.reindex === job;
  try {
    if (!job.target) throw new Error('Reindex target is missing');
    const result = await runner.run(job.target, ({ processedRows, totalRows }) => {
      if (!isCurrent()) return;
      job.processedItems = processedRows;
      job.totalItems = totalRows;
    });
    if (!isCurrent()) return;
    job.processedItems = result.processedRows;
    job.totalItems = result.totalRows;
    job.status = result.outcome === 'cancelled' ? 'cancelled' : 'completed';
    job.completedAt = new Date().toISOString();
    endTimer({ outcome: result.outcome === 'cancelled' ? 'cancelled' : 'success' });
  } catch (err) {
    endTimer({ outcome: 'failure' });
    if (!isCurrent()) return;
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = err instanceof Error ? err.message : String(err);
    logger.warn('Reindex failed', undefined, { target: job.target, error: job.error });
  }
}

/**
 * Replace the replay runner used by `triggerReindex()`.
 * @security Only for testing; never called in production code paths.
 */
export function _setReindexRunnerForTest(runner: ReindexRunner | null): void {
  reindexRunner = runner ?? indexerReplayRunner;
}

/** Reset state — only exposed for tests. */
export function _resetForTest(options: { clearPersistence?: boolean; clearLock?: boolean } = {}): void {
  state.pauseFlags.streamCreation = false;
  state.pauseFlags.ingestion = false;
  state.reindex = idleReindexState();

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
