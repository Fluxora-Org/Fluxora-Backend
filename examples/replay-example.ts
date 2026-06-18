/**
 * Example usage of the indexer replay API
 * 
 * This script demonstrates how to:
 * 1. Start a replay operation
 * 2. Monitor progress
 * 3. Handle completion
 */

import axios from 'axios';

const INDEXER_BASE_URL = process.env.INDEXER_URL || 'http://localhost:3000';

interface ReplayStatus {
  isReplaying: boolean;
  rowsReplayed: number;
  rowsRemaining: number;
  totalRows: number;
  estimatedCompletion: string | null;
  startedAt: string | null;
  contractId?: string;
  ledger?: number;
}

/**
 * Start a replay operation
 */
async function startReplay(
  contractId: string,
  ledger: number,
  fromBlock?: number,
  toBlock?: number
): Promise<void> {
  try {
    console.log(`Starting replay for contract ${contractId}, ledger ${ledger}...`);
    
    const response = await axios.post(
      `${INDEXER_BASE_URL}/internal/indexer/events/replay`,
      {
        contract_id: contractId,
        ledger: ledger,
        from_block: fromBlock,
        to_block: toBlock,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          // Add authentication header if required
          // 'X-API-Key': process.env.API_KEY,
        },
      }
    );
    
    console.log('✓ Replay started successfully');
    console.log('Initial status:', response.data.status);
  } catch (error: any) {
    if (error.response) {
      console.error('Failed to start replay:', error.response.data);
      throw new Error(error.response.data.error);
    } else {
      console.error('Network error:', error.message);
      throw error;
    }
  }
}

/**
 * Get current replay status
 */
async function getStatus(): Promise<ReplayStatus> {
  try {
    const response = await axios.get(
      `${INDEXER_BASE_URL}/internal/indexer/status`,
      {
        headers: {
          // Add authentication header if required
          // 'X-API-Key': process.env.API_KEY,
        },
      }
    );
    
    return response.data;
  } catch (error: any) {
    if (error.response) {
      console.error('Failed to get status:', error.response.data);
      throw new Error(error.response.data.error);
    } else {
      console.error('Network error:', error.message);
      throw error;
    }
  }
}

/**
 * Monitor replay progress until completion
 */
async function monitorProgress(pollIntervalMs: number = 2000): Promise<void> {
  console.log('\nMonitoring replay progress...\n');
  
  let lastStatus: ReplayStatus | null = null;
  
  while (true) {
    const status = await getStatus();
    
    // Only log if status changed
    if (
      !lastStatus ||
      status.rowsReplayed !== lastStatus.rowsReplayed ||
      status.isReplaying !== lastStatus.isReplaying
    ) {
      const progress = status.totalRows > 0
        ? ((status.rowsReplayed / status.totalRows) * 100).toFixed(1)
        : '0.0';
      
      console.log(`[${new Date().toISOString()}]`);
      console.log(`  Progress: ${status.rowsReplayed}/${status.totalRows} (${progress}%)`);
      console.log(`  Remaining: ${status.rowsRemaining} rows`);
      
      if (status.estimatedCompletion) {
        const eta = new Date(status.estimatedCompletion);
        const now = new Date();
        const remainingMs = eta.getTime() - now.getTime();
        const remainingMin = Math.ceil(remainingMs / 1000 / 60);
        console.log(`  ETA: ${eta.toLocaleTimeString()} (~${remainingMin} minutes)`);
      }
      
      console.log('');
    }
    
    lastStatus = status;
    
    // Check if replay is complete
    if (!status.isReplaying) {
      console.log('✓ Replay completed!');
      console.log(`  Total rows processed: ${status.rowsReplayed}`);
      break;
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Example 1: Simple replay
 */
async function example1_SimpleReplay() {
  console.log('=== Example 1: Simple Replay ===\n');
  
  await startReplay('contract-abc-123', 1);
  await monitorProgress();
}

/**
 * Example 2: Replay with block range
 */
async function example2_BlockRangeReplay() {
  console.log('=== Example 2: Block Range Replay ===\n');
  
  await startReplay('contract-xyz-789', 2, 1000, 5000);
  await monitorProgress();
}

/**
 * Example 3: Check status without starting replay
 */
async function example3_CheckStatus() {
  console.log('=== Example 3: Check Current Status ===\n');
  
  const status = await getStatus();
  
  if (status.isReplaying) {
    console.log('Replay is currently in progress:');
    console.log(`  Contract: ${status.contractId}`);
    console.log(`  Ledger: ${status.ledger}`);
    console.log(`  Progress: ${status.rowsReplayed}/${status.totalRows}`);
  } else {
    console.log('No replay is currently in progress');
  }
}

/**
 * Example 4: Error handling
 */
async function example4_ErrorHandling() {
  console.log('=== Example 4: Error Handling ===\n');
  
  try {
    // Try to start replay with invalid parameters
    await startReplay('', -1);
  } catch (error: any) {
    console.log('✓ Caught expected error:', error.message);
  }
  
  try {
    // Try to start concurrent replay
    await startReplay('contract-1', 1);
    await startReplay('contract-2', 1); // This should fail
  } catch (error: any) {
    console.log('✓ Caught concurrent replay error:', error.message);
  }
}

/**
 * Example 5: Batch replay multiple contracts
 */
async function example5_BatchReplay() {
  console.log('=== Example 5: Batch Replay Multiple Contracts ===\n');
  
  const contracts = [
    { contractId: 'contract-1', ledger: 1 },
    { contractId: 'contract-2', ledger: 1 },
    { contractId: 'contract-3', ledger: 2 },
  ];
  
  for (const { contractId, ledger } of contracts) {
    console.log(`\nReplaying ${contractId}...`);
    await startReplay(contractId, ledger);
    await monitorProgress(1000); // Poll every second
    console.log('---');
  }
  
  console.log('\n✓ All contracts replayed successfully');
}

// Main execution
async function main() {
  const example = process.argv[2] || '1';
  
  try {
    switch (example) {
      case '1':
        await example1_SimpleReplay();
        break;
      case '2':
        await example2_BlockRangeReplay();
        break;
      case '3':
        await example3_CheckStatus();
        break;
      case '4':
        await example4_ErrorHandling();
        break;
      case '5':
        await example5_BatchReplay();
        break;
      default:
        console.log('Usage: ts-node examples/replay-example.ts [1-5]');
        console.log('  1: Simple replay');
        console.log('  2: Block range replay');
        console.log('  3: Check status');
        console.log('  4: Error handling');
        console.log('  5: Batch replay');
        process.exit(1);
    }
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export {
  startReplay,
  getStatus,
  monitorProgress,
};
