/**
 * Bounded-concurrency backfill scheduler with a yield-to-live-indexing rule.
 *
 * ## Schedule (documented behaviour)
 *
 * Backfill is a background, best-effort workload; live (tip-following) indexing
 * always has priority. A backfill that runs flat out during a busy period
 * competes for the same RPC and database capacity as live indexing and
 * therefore *increases* the ledger lag measured by
 * `src/metrics/indexerLag.ts` — the opposite of what the operator wanted.
 *
 * The schedule is therefore:
 *
 * 1. Batches are processed with bounded concurrency (never more than
 *    `concurrency` handlers in flight) in ascending `index` order.
 * 2. Before a worker claims its next batch it consults the live-indexing lag
 *    reader (`liveIndexingLag`). While the lag is **greater than or equal to**
 *    `maxLiveIndexingLag` ledgers the worker waits and starts no new batch.
 * 3. While paused the lag is re-checked every `yieldPollIntervalMs`. As soon as
 *    it falls **below** the threshold the backfill resumes automatically — no
 *    operator action and no restart required.
 * 4. Retries and ordered-checkpoint semantics are unchanged: a checkpoint is
 *    still only advanced across a contiguous prefix of successful batches.
 * 5. All workers share a single pause gate, so one sustained lagging period
 *    produces exactly one `paused` → `resumed` transition regardless of
 *    `concurrency`.
 *
 * Yielding is disabled — and the scheduler behaves exactly as before — when
 * `liveIndexingLag` is omitted or `maxLiveIndexingLag` is `<= 0`, so existing
 * callers are unaffected.
 *
 * If the lag reader throws, the read is treated as “no lag recorded” and the
 * backfill continues. A transient metrics/DB glitch must not be able to stall
 * the backfill forever; the failed read is not surfaced as a batch failure.
 *
 * ## Observability
 *
 * Every pause/resume decision is observable three ways:
 *
 * - `onYield(lag)` is invoked once when the backfill pauses; `onResume(lag)`
 *   once when it resumes. Both receive the lag observed at the transition.
 * - The `indexer_backfill_paused` gauge is `1` while paused and `0` otherwise.
 * - Each transition increments `indexer_backfill_yield_events_total`
 *   (`event="paused"` / `event="resumed"`).
 *
 * Together these let an operator answer “is backfill paused, for how long, and
 * because of what lag?” from the `/metrics` endpoint.
 */

import {
  indexerBackfillPaused,
  indexerBackfillYieldEventsTotal,
} from '../metrics/indexerLag.js';

export interface BackfillBatch<T = unknown> {
  index: number;
  data: T;
}

export type BackfillHandler<T = unknown> = (batch: BackfillBatch<T>) => Promise<void>;

/**
 * Reads the current live-indexing ledger lag (tip minus last-indexed ledger),
 * in ledgers. This is the same quantity exposed as the `indexer_ledger_lag`
 * gauge by `src/metrics/indexerLag.ts`.
 */
export type LiveIndexingLagReader = () => number | Promise<number>;

export interface BackfillOptions<T = unknown> {
  batches: BackfillBatch<T>[];
  concurrency: number;
  initialCheckpoint?: number;
  retryLimit?: number;
  retryDelayMs?: number;
  onCheckpoint?: (index: number) => void | Promise<void>;
  signal?: AbortSignal;
  handler: BackfillHandler<T>;
  /** Reads the live-indexing ledger lag. Omit to disable yielding entirely. */
  liveIndexingLag?: LiveIndexingLagReader;
  /**
   * Lag threshold in ledgers. At or above this value the backfill pauses; below
   * it the backfill runs. `<= 0` (the default) disables yielding.
   */
  maxLiveIndexingLag?: number;
  /** How long to wait between lag re-checks while paused. Default 1000 ms. */
  yieldPollIntervalMs?: number;
  /** Called once per pause, with the lag that triggered it. */
  onYield?: (lag: number) => void;
  /** Called once per resume, with the lag observed when it resumed. */
  onResume?: (lag: number) => void;
  /** Injectable sleep used while paused (test seam). Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Default interval, in ms, between lag re-checks while the backfill is paused. */
export const DEFAULT_YIELD_POLL_INTERVAL_MS = 1000;

export async function runBackfill<T>(options: BackfillOptions<T>): Promise<number> {
  const {
    batches,
    concurrency,
    initialCheckpoint = -1,
    retryLimit = 3,
    retryDelayMs = 100,
    onCheckpoint,
    signal,
    handler,
    liveIndexingLag,
    maxLiveIndexingLag = 0,
    yieldPollIntervalMs = DEFAULT_YIELD_POLL_INTERVAL_MS,
    onYield,
    onResume,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  const status = new Map<number, 'pending' | 'done' | 'failed'>();
  for (const b of batches) status.set(b.index, 'pending');
  const indices = batches.map((b) => b.index).sort((a, b) => a - b);
  let checkpoint = initialCheckpoint;
  let next = 0;
  let error: Error | null = null;

  const yieldingEnabled =
    typeof liveIndexingLag === 'function' && maxLiveIndexingLag > 0;

  /**
   * Read the lag, coercing anything unusable (throw, `NaN`, negative, a
   * non-number) to `null`, which callers treat as “not lagging”.
   */
  const readLag = async (): Promise<number | null> => {
    try {
      const value = await liveIndexingLag!();
      return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, value)
        : null;
    } catch {
      return null;
    }
  };

  /**
   * Single shared gate. The first worker to observe a lagging indexer owns the
   * pause (and reports it once); every other worker simply awaits the same
   * promise, so a pause/resume pair is never double-counted.
   */
  let pausePromise: Promise<void> | null = null;

  const waitForLiveIndexing = async (): Promise<void> => {
    if (!yieldingEnabled) return;
    // Already paused: join the existing gate instead of opening a new one.
    if (pausePromise) return pausePromise;

    const lag = await readLag();
    // Re-check after the await — another worker may have raced us into a pause.
    if (pausePromise) return pausePromise;
    if (lag === null || lag < maxLiveIndexingLag) return;

    // This worker owns the pause.
    indexerBackfillPaused.set(1);
    indexerBackfillYieldEventsTotal.inc({ event: 'paused' });
    onYield?.(lag);

    pausePromise = (async () => {
      let currentLag = lag;
      while (currentLag >= maxLiveIndexingLag) {
        if (signal?.aborted) break;
        await sleep(yieldPollIntervalMs);
        const observed = await readLag();
        currentLag = observed ?? 0;
      }
      indexerBackfillPaused.set(0);
      indexerBackfillYieldEventsTotal.inc({ event: 'resumed' });
      onResume?.(currentLag);
      pausePromise = null;
    })();

    return pausePromise;
  };

  const commit = async () => {
    while (status.get(checkpoint + 1) === 'done') checkpoint++;
    if (onCheckpoint && checkpoint > initialCheckpoint) await onCheckpoint(checkpoint);
  };

  const worker = async () => {
    while (!error && !signal?.aborted) {
      // Yield to live indexing before claiming any new batch.
      await waitForLiveIndexing();
      if (error || signal?.aborted) return;

      const pos = next++;
      if (pos >= indices.length) return;
      const index = indices[pos];
      for (let attempt = 1; attempt <= retryLimit; attempt++) {
        try {
          await handler({ index, data: batches[pos].data });
          status.set(index, 'done');
          await commit();
          break;
        } catch (err) {
          if (attempt === retryLimit) {
            error = err instanceof Error ? err : new Error(String(err));
            status.set(index, 'failed');
            break;
          }
          await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** (attempt - 1)));
          if (signal?.aborted) return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker));
  if (error) throw error;
  return checkpoint;
}
