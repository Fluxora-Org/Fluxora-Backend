/**
 * Centralized admin state for operator-grade controls.
 *
 * Holds pause flags and reindex tracking in memory.
 * Will be replaced by Redis or PostgreSQL once persistence is wired up.
 */

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

export function getPauseFlags(): PauseFlags {
  return { ...state.pauseFlags };
}

export function setPauseFlags(flags: Partial<PauseFlags>): PauseFlags {
  if (flags.streamCreation !== undefined) {
    state.pauseFlags.streamCreation = flags.streamCreation;
  }
  if (flags.ingestion !== undefined) {
    state.pauseFlags.ingestion = flags.ingestion;
  }
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
export function _resetForTest(): void {
  state.pauseFlags.streamCreation = false;
  state.pauseFlags.ingestion = false;
  state.reindex = {
    status: 'idle',
    startedAt: null,
    completedAt: null,
    error: null,
    processedItems: 0,
  };
}
