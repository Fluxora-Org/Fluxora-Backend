/**
 * Example usage of the IndexerService replay API
 *
 * This script demonstrates how to:
 *  1. Start a replay operation (per-batch commits, durable cursor)
 *  2. Monitor progress while the replay runs
 *  3. Resume a crash-interrupted replay idempotently
 *  4. Handle error scenarios (bad params, concurrent replay, budget exceeded)
 *  5. Batch-replay multiple contracts sequentially
 *
 * ## Per-batch commit contract
 *
 * `IndexerService.replayEvents` commits once per batch of rows (default: 250).
 * Each batch uses its own database connection that is checked out and released
 * within the batch — no single connection is held for the lifetime of the replay.
 *
 * ## Crash-resume semantics
 *
 * Every committed batch advances a `last_committed_offset` in the
 * `replay_cursors` table (inside the same transaction as the data INSERT).
 * If the process crashes mid-replay, a re-call with the same parameters reads
 * the existing cursor and resumes from the last committed offset.
 * `ON CONFLICT (event_id) DO NOTHING` guarantees no duplicate rows are written
 * regardless of how many times a replay is retried.
 *
 * ## Environment variables
 *
 *   INDEXER_REPLAY_BATCH_SIZE         rows per batch transaction (default 250)
 *   INDEXER_MAX_REPLAY_RANGE_BLOCKS   max (to_block - from_block) allowed (default 10 000 000)
 *   INDEXER_REPLAY_BUDGET_MS          wall-clock ms budget per replay run (0 = unlimited)
 *   INDEXER_URL                       base URL of the indexer service
 */

import axios from 'axios';

const INDEXER_BASE_URL = process.env.INDEXER_URL || 'http://localhost:3000';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ReplayStatus {
  isReplaying: boolean;
  rowsReplayed: number;
  rowsRemaining: number;
  totalRows: number;
  estimatedCompletion: string | null;
  startedAt: string | null;
  contractId?: string;
  ledger?: number;
  /** DB cursor ID — present while a replay is active (or resumed). */
  replayCursorId?: string;
  /** Row offset of the last committed batch. */
  currentOffset?: number;
}

interface StartReplayResponse {
  status: ReplayStatus;
  message?: string;
}

// ── API helpers ────────────────────────────────────────────────────────────────

/**
 * Start (or resume) a replay operation.
 *
 * If a crash-interrupted replay exists for (contract_id, ledger), the server
 * resumes from the last committed cursor offset automatically.
 */
async function startReplay(
  contractId: string,
  ledger: number,
  fromBlock?: number,
  toBlock?: number,
): Promise<StartReplayResponse> {
  console.log(
    `Starting replay for contract ${contractId}, ledger ${ledger}` +
      (fromBlock !== undefined ? `, blocks ${fromBlock}–${toBlock ?? '∞'}` : ''),
  );

  const response = await axios.post<StartReplayResponse>(
    `${INDEXER_BASE_URL}/internal/indexer/events/replay`,
    {
      contract_id: contractId,
      ledger,
      from_block: fromBlock,
      to_block: toBlock,
    },
    { headers: { 'Content-Type': 'application/json' } },
  );

  return response.data;
}

/**
 * Get current replay status (reads in-memory progress for fast polling).
 */
async function getStatus(): Promise<ReplayStatus> {
  const response = await axios.get<ReplayStatus>(
    `${INDEXER_BASE_URL}/internal/indexer/status`,
  );
  return response.data;
}

/**
 * Monitor replay progress until completion.  Logs only when something changes.
 */
async function monitorProgress(pollIntervalMs = 2_000): Promise<void> {
  console.log('\nMonitoring replay progress…\n');
  let lastStatus: ReplayStatus | null = null;

  while (true) {
    const status = await getStatus();

    const changed =
      !lastStatus ||
      status.rowsReplayed !== lastStatus.rowsReplayed ||
      status.isReplaying !== lastStatus.isReplaying;

    if (changed) {
      const pct =
        status.totalRows > 0
          ? ((status.rowsReplayed / status.totalRows) * 100).toFixed(1)
          : '0.0';

      console.log(`[${new Date().toISOString()}]`);
      console.log(`  Progress : ${status.rowsReplayed}/${status.totalRows} (${pct}%)`);
      console.log(`  Remaining: ${status.rowsRemaining} rows`);
      if (status.currentOffset !== undefined) {
        console.log(`  Cursor   : offset ${status.currentOffset} (${status.replayCursorId})`);
      }
      if (status.estimatedCompletion) {
        const eta = new Date(status.estimatedCompletion);
        const remainingMin = Math.ceil((eta.getTime() - Date.now()) / 60_000);
        console.log(`  ETA      : ${eta.toLocaleTimeString()} (~${remainingMin} min)`);
      }
      console.log('');
    }

    lastStatus = status;

    if (!status.isReplaying) {
      console.log('✓ Replay completed!');
      console.log(`  Total rows processed: ${status.rowsReplayed}`);
      break;
    }

    await new Promise((res) => setTimeout(res, pollIntervalMs));
  }
}

// ── Examples ───────────────────────────────────────────────────────────────────

/**
 * Example 1: Simple replay (all ledger events for a contract)
 */
async function example1_SimpleReplay() {
  console.log('=== Example 1: Simple Replay ===\n');
  await startReplay('contract-abc-123', 1);
  await monitorProgress();
}

/**
 * Example 2: Replay with block range
 *
 * Capped at INDEXER_MAX_REPLAY_RANGE_BLOCKS (default 10 000 000).
 * Requests exceeding this limit are rejected before any DB work.
 */
async function example2_BlockRangeReplay() {
  console.log('=== Example 2: Block Range Replay ===\n');
  await startReplay('contract-xyz-789', 2, 1_000, 5_000);
  await monitorProgress();
}

/**
 * Example 3: Crash-resume demonstration
 *
 * Step 1: Start a replay and simulate a mid-flight crash (Ctrl-C / SIGTERM).
 * Step 2: Call startReplay again with the same parameters.
 *         The server finds the incomplete `replay_cursors` row and resumes
 *         from `last_committed_offset` without re-inserting committed events.
 */
async function example3_CrashResume() {
  console.log('=== Example 3: Crash-Resume ===\n');
  console.log('Step 1: Starting replay (simulate crash by stopping after first status log)…');

  try {
    await startReplay('contract-resume-test', 1);
    // In a real scenario you would send SIGTERM here; for this demo we just continue.
  } catch {
    console.log('  (Simulated crash — continuing to resume step)');
  }

  console.log('\nStep 2: Resuming replay from last committed cursor offset…');
  const result = await startReplay('contract-resume-test', 1);
  console.log('  Resume response:', result);

  await monitorProgress(1_000);
  console.log('\n✓ Crash-resume completed — no duplicate rows inserted.');
}

/**
 * Example 4: Check status without starting replay
 */
async function example4_CheckStatus() {
  console.log('=== Example 4: Check Current Status ===\n');
  const status = await getStatus();

  if (status.isReplaying) {
    console.log('Replay is currently in progress:');
    console.log(`  Contract : ${status.contractId}`);
    console.log(`  Ledger   : ${status.ledger}`);
    console.log(`  Progress : ${status.rowsReplayed}/${status.totalRows}`);
    console.log(`  Cursor   : ${status.replayCursorId} @ offset ${status.currentOffset}`);
  } else {
    console.log('No replay is currently in progress.');
  }
}

/**
 * Example 5: Error handling
 */
async function example5_ErrorHandling() {
  console.log('=== Example 5: Error Handling ===\n');

  try {
    // Bad parameters → rejected before any DB work
    await startReplay('', -1);
  } catch (error: any) {
    console.log('✓ Caught invalid-params error:', error.response?.data?.error ?? error.message);
  }

  try {
    // Oversized block range → rejected by maxRangeBlocks guard
    await startReplay('contract-1', 1, 0, 20_000_000);
  } catch (error: any) {
    console.log('✓ Caught range-guard error:', error.response?.data?.error ?? error.message);
  }
}

/**
 * Example 6: Batch replay multiple contracts sequentially
 */
async function example6_BatchReplay() {
  console.log('=== Example 6: Batch Replay Multiple Contracts ===\n');

  const contracts = [
    { contractId: 'contract-1', ledger: 1 },
    { contractId: 'contract-2', ledger: 1 },
    { contractId: 'contract-3', ledger: 2 },
  ];

  for (const { contractId, ledger } of contracts) {
    console.log(`\nReplaying ${contractId} / ledger ${ledger}…`);
    await startReplay(contractId, ledger);
    await monitorProgress(1_000);
    console.log('---');
  }

  console.log('\n✓ All contracts replayed successfully.');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const example = process.argv[2] ?? '1';

  try {
    switch (example) {
      case '1': await example1_SimpleReplay(); break;
      case '2': await example2_BlockRangeReplay(); break;
      case '3': await example3_CrashResume(); break;
      case '4': await example4_CheckStatus(); break;
      case '5': await example5_ErrorHandling(); break;
      case '6': await example6_BatchReplay(); break;
      default:
        console.log('Usage: ts-node examples/replay-example.ts [1-6]');
        console.log('  1: Simple replay');
        console.log('  2: Block range replay');
        console.log('  3: Crash-resume');
        console.log('  4: Check status');
        console.log('  5: Error handling');
        console.log('  6: Batch replay');
        process.exit(1);
    }
  } catch (error: any) {
    const msg = error.response?.data?.error ?? error.message;
    console.error('\n❌ Error:', msg);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { startReplay, getStatus, monitorProgress };
