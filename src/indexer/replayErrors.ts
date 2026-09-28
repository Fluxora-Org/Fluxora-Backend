// Pre-existing type-error backlog, tracked for follow-up (#TBD-typecheck-backlog); not introduced by this PR. Remove once resolved.

/**
 * Thrown when a replay run exceeds the configured wall-clock budget
 * (`INDEXER_REPLAY_BUDGET_MS`). Already-committed batches are durable;
 * a re-run will resume from the last persisted cursor offset.
 */
export class ReplayBudgetExceededError extends Error {
  constructor(budgetMs: number, elapsedMs: number) {
    super(
      `Replay budget of ${budgetMs} ms exceeded (elapsed: ${elapsedMs} ms). ` +
        'Re-run to resume from the last committed cursor offset.',
    );
    this.name = 'ReplayBudgetExceededError';
  }
}

/**
 * Thrown when this instance could not acquire (or lost) the distributed
 * indexer leader-election lease. Another instance is currently the leader
 * and is expected to own replay; no data was lost, already-committed
 * batches remain durable, and a re-run resumes from the last committed
 * cursor offset once this instance becomes leader.
 */
export class IndexerNotLeaderError extends Error {
  constructor() {
    super(
      'This instance is not the indexer replay leader; another instance is ' +
        'currently running (or eligible to run) replay.',
    );
    this.name = 'IndexerNotLeaderError';
  }
}

/**
 * Thrown when a replay cancellation was requested but a single batch's
 * database wait (e.g. `fetch` or `COMMIT`) did not settle within
 * `INDEXER_REPLAY_STOP_FORCED_TIMEOUT_MS` of the request. The replay unwinds
 * cooperatively so the in-memory indexer lock and the leader lease are
 * released rather than being held indefinitely on a stuck connection.
 * Already-committed batches remain durable; a re-run resumes from the last
 * committed cursor offset.
 */
export class ReplayForcedStopError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Replay stop requested but the in-flight batch did not settle within ` +
        `${timeoutMs} ms; forcing cancellation to release the indexer lock.`,
    );
    this.name = 'ReplayForcedStopError';
  }
}
