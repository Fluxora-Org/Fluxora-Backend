// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.
import { ReplayProgress } from '../types.js';

// ── In-memory concurrent-replay lock ──────────────────────────────────────────

/**
 * Lightweight in-memory flag that prevents two concurrent replay operations
 * from running at the same time on this process instance.
 *
 * All durable progress is stored in the `replay_cursors` DB table — this flag
 * is intentionally reset to `false` on process restart so a crash-interrupted
 * replay can be resumed immediately.
 *
 * For multi-process deployments a distributed lock (e.g. Redis SETNX) would
 * be required instead; this flag handles the single-process case.
 */
class ReplayLock {
  private _isReplaying = false;

  isHeld(): boolean {
    return this._isReplaying;
  }

  acquire(): void {
    this._isReplaying = true;
  }

  release(): void {
    this._isReplaying = false;
  }
}

export const replayLock = new ReplayLock();

// ── Graceful stop signal ───────────────────────────────────────────────────────

let _stopRequested = false;
let _stopRequestedAt: number | null = null;

/**
 * Resolved the moment a stop is requested so that in-flight database waits
 * (inside `ReplayBatchRunner.processBatch`) can be force-bounded by a timer
 * instead of blocking forever on a stuck connection while holding the
 * indexer lock.
 */
function createStopTriggered(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let _stopTriggered = createStopTriggered();

/**
 * Request that an in-progress replay stops at the next safe batch boundary.
 * Already-committed batches remain durable; a re-run resumes from the last
 * committed cursor offset.
 */
export function requestStopReplay(): void {
  if (!_stopRequested) {
    _stopRequested = true;
    _stopRequestedAt = Date.now();
    _stopTriggered.resolve();
  }
}

/** Reset stop flag — for testing only. */
export function _resetStopReplay(): void {
  _stopRequested = false;
  _stopRequestedAt = null;
  _stopTriggered = createStopTriggered();
}

/** True when a stop has been requested (cooperative cancellation signal). */
export function isReplayStopRequested(): boolean {
  return _stopRequested;
}

/** Timestamp (ms) at which the current stop was requested, or null if none. */
export function getReplayStopRequestedAt(): number | null {
  return _stopRequestedAt;
}

/**
 * The promise that resolves the moment a stop is requested. Always reflects
 * the *current* stop cycle — read this at call time rather than caching it,
 * since `_resetStopReplay` swaps in a fresh, unresolved promise.
 */
export function getReplayStopTriggeredPromise(): Promise<void> {
  return _stopTriggered.promise;
}

// ── In-memory progress state (for low-latency /status polling) ────────────────

/**
 * In-memory replay progress state used exclusively for fast `/status` polling.
 * This state is ephemeral and is NOT relied upon for crash-resume durability —
 * that role belongs to the `replay_cursors` DB table.
 */
class ReplayState {
  private state: ReplayProgress = {
    isReplaying: false,
    rowsReplayed: 0,
    rowsRemaining: 0,
    totalRows: 0,
    estimatedCompletion: null,
    startedAt: null,
  };

  getState(): ReplayProgress {
    return { ...this.state };
  }

  startReplay(
    totalRows: number,
    contractId: string,
    ledger: number,
    replayCursorId: string,
    resumeFromOffset: number,
  ): void {
    this.state = {
      isReplaying: true,
      rowsReplayed: resumeFromOffset,
      rowsRemaining: Math.max(0, totalRows - resumeFromOffset),
      totalRows,
      estimatedCompletion: null,
      startedAt: new Date(),
      contractId,
      ledger,
      replayCursorId,
      currentOffset: resumeFromOffset,
    };
  }

  updateProgress(rowsProcessed: number, newOffset: number): void {
    const prevOffset = this.state.currentOffset ?? 0;
    const monotonicOffset = Math.max(prevOffset, newOffset);
    const actualAdded = Math.max(0, monotonicOffset - prevOffset);
    this.state.rowsReplayed += actualAdded;
    this.state.rowsRemaining = Math.max(0, this.state.totalRows - this.state.rowsReplayed);
    this.state.currentOffset = monotonicOffset;

    if (this.state.startedAt && this.state.rowsReplayed > 0) {
      const elapsed = Date.now() - this.state.startedAt.getTime();
      const rate = this.state.rowsReplayed / elapsed; // rows per ms
      const remainingTime = this.state.rowsRemaining / rate;
      this.state.estimatedCompletion = new Date(Date.now() + remainingTime);
    }
  }

  endReplay(): void {
    this.state.isReplaying = false;
    this.state.estimatedCompletion = null;
  }
}

export const replayState = new ReplayState();
