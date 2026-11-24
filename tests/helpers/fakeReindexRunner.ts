/**
 * Replay-runner fakes for reindex tests that exercise admin state (locking,
 * serialization) rather than the replay itself.
 */
import type { ReindexRunner, ReindexTarget } from '../../src/state/adminState.js';

/** A fixed range used by tests that do not care what is replayed. */
export const TEST_REINDEX_TARGET: ReindexTarget = { contract_id: 'CTESTREINDEX', ledger: 1 };

/**
 * A runner that commits `batches` batches of one row, `batchMs` apart, then
 * completes. `cancel()` ends it as cancelled at the next batch boundary,
 * like the real replay. Defaults keep the job's duration (~250 ms) that the
 * lock-serialization tests are timed around.
 */
export function timedReindexRunner(batches = 5, batchMs = 50): ReindexRunner {
  let stopRequested = false;
  return {
    async run(_target, onProgress) {
      stopRequested = false;
      onProgress({ processedRows: 0, totalRows: batches });
      let processed = 0;
      for (let i = 0; i < batches; i++) {
        await new Promise((r) => setTimeout(r, batchMs));
        if (stopRequested) {
          return { outcome: 'cancelled', processedRows: processed, totalRows: batches };
        }
        processed++;
        onProgress({ processedRows: processed, totalRows: batches });
      }
      return { outcome: 'completed', processedRows: processed, totalRows: batches };
    },
    cancel() {
      stopRequested = true;
    },
  };
}
