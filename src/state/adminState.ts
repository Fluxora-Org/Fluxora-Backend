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
import { dirname } from 'node:path';
import type { RedisClient } from '../redis/client.js';
import { RedisDistributedLock, NoOpLock, Lock } from './adminStateLock.js';
import { logger } from '../lib/logger.js';

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
 * Initialize distributed locking for pause flags with a Redis client.
 * Call this during app startup after Redis is available.
 * If not called, file-based locking will be used as fallback.
 */
export function initializeAdminStateLock(redis: RedisClient): void {
  pauseFlagsLock = new RedisDistributedLock(redis, 'pauseFlags');
}

async function acquirePauseFlagsLock(): Promise<Lock> {
  if (!pauseFlagsLock) {
    pauseFlagsLock = new RedisDistributedLock(
      // Create a minimal Redis-compatible interface that falls back to file locking
      { setNx: async () => false, del: async () => {} } as RedisClient,
      'pauseFlags',
    );
  }
  return pauseFlagsLock.acquire();
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
 */
export async function triggerReindex(): Promise<ReindexState> {
  if (state.reindex.status === 'running') {
    return { ...state.reindex };
  }

  state.reindex = {
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    processedItems: 0,
  };

  // Fire-and-forget: the actual work runs in the background.
  // In production, replace this with a real reindex job.
  runReindexJob().catch(() => {
    /* errors are captured in state */
  });

  return { ...state.reindex };
}

async function runReindexJob(): Promise<void> {
  try {
    // Simulate incremental reindex work (placeholder for Horizon replay).
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      await sleep(50);
      state.reindex.processedItems = i;
    }
    state.reindex.status = 'completed';
    state.reindex.completedAt = new Date().toISOString();
  } catch (err) {
    state.reindex.status = 'failed';
    state.reindex.completedAt = new Date().toISOString();
    state.reindex.error = err instanceof Error ? err.message : String(err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reset state — only exposed for tests. */
export function _resetForTest(options: { clearPersistence?: boolean } = {}): void {
  state.pauseFlags.streamCreation = false;
  state.pauseFlags.ingestion = false;
  state.reindex = {
    status: 'idle',
    startedAt: null,
    completedAt: null,
    error: null,
    processedItems: 0,
  };

  if (options.clearPersistence !== false) {
    try {
      fs.rmSync(resolveAdminStatePath(), { force: true });
    } catch {
      // no-op
    }
  }
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
