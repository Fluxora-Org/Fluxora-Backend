/**
 * Benchmark script to compare single-insert vs batch-insert performance
 * 
 * Usage:
 *   ts-node scripts/benchmark.ts
 */

import { db } from '../src/db/client';
import { performance } from 'perf_hooks';

interface BenchmarkResult {
  method: string;
  events: number;
  duration: number;
  eventsPerSecond: number;
}

async function benchmarkSingleInserts(numEvents: number): Promise<BenchmarkResult> {
  console.log(`\nBenchmarking single inserts (${numEvents} events)...`);
  
  const client = await db.getClient();
  const startTime = performance.now();
  
  try {
    await client.query('BEGIN');
    
    for (let i = 0; i < numEvents; i++) {
      await client.query(
        `INSERT INTO contract_events (
          event_id, contract_id, ledger, event_type, 
          event_data, block_height, transaction_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (event_id) DO NOTHING`,
        [
          `bench-single-${i}`,
          'benchmark-contract',
          999,
          'Transfer',
          JSON.stringify({ amount: 100 }),
          10000 + i,
          `bench-tx-${i}`,
        ]
      );
    }
    
    await client.query('COMMIT');
    
    const endTime = performance.now();
    const duration = (endTime - startTime) / 1000; // Convert to seconds
    
    return {
      method: 'Single Inserts',
      events: numEvents,
      duration,
      eventsPerSecond: numEvents / duration,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function benchmarkBatchInserts(numEvents: number, batchSize: number): Promise<BenchmarkResult> {
  console.log(`\nBenchmarking batch inserts (${numEvents} events, batch size ${batchSize})...`);
  
  const client = await db.getClient();
  const startTime = performance.now();
  
  try {
    await client.query('BEGIN');
    
    for (let offset = 0; offset < numEvents; offset += batchSize) {
      const currentBatchSize = Math.min(batchSize, numEvents - offset);
      const values: any[] = [];
      const placeholders: string[] = [];
      
      for (let i = 0; i < currentBatchSize; i++) {
        const eventIndex = offset + i;
        const baseIndex = i * 7;
        
        placeholders.push(
          `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7})`
        );
        
        values.push(
          `bench-batch-${eventIndex}`,
          'benchmark-contract',
          999,
          'Transfer',
          JSON.stringify({ amount: 100 }),
          10000 + eventIndex,
          `bench-tx-${eventIndex}`
        );
      }
      
      const query = `
        INSERT INTO contract_events (
          event_id, contract_id, ledger, event_type,
          event_data, block_height, transaction_hash
        ) VALUES ${placeholders.join(', ')}
        ON CONFLICT (event_id) DO NOTHING
      `;
      
      await client.query(query, values);
    }
    
    await client.query('COMMIT');
    
    const endTime = performance.now();
    const duration = (endTime - startTime) / 1000;
    
    return {
      method: `Batch Inserts (size ${batchSize})`,
      events: numEvents,
      duration,
      eventsPerSecond: numEvents / duration,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupBenchmarkData() {
  console.log('\nCleaning up benchmark data...');
  const client = await db.getClient();
  
  try {
    await client.query(`
      DELETE FROM contract_events 
      WHERE event_id LIKE 'bench-%'
    `);
    console.log('✓ Cleanup complete');
  } finally {
    client.release();
  }
}

async function runBenchmarks() {
  console.log('='.repeat(60));
  console.log('Contract Event Indexer - Performance Benchmark');
  console.log('='.repeat(60));
  
  const results: BenchmarkResult[] = [];
  const numEvents = 1000;
  
  try {
    // Cleanup any existing benchmark data
    await cleanupBenchmarkData();
    
    // Benchmark 1: Single inserts
    const singleResult = await benchmarkSingleInserts(numEvents);
    results.push(singleResult);
    
    // Cleanup between benchmarks
    await cleanupBenchmarkData();
    
    // Benchmark 2: Batch inserts (size 100)
    const batch100Result = await benchmarkBatchInserts(numEvents, 100);
    results.push(batch100Result);
    
    // Cleanup between benchmarks
    await cleanupBenchmarkData();
    
    // Benchmark 3: Batch inserts (size 500)
    const batch500Result = await benchmarkBatchInserts(numEvents, 500);
    results.push(batch500Result);
    
    // Cleanup between benchmarks
    await cleanupBenchmarkData();
    
    // Benchmark 4: Batch inserts (size 1000)
    const batch1000Result = await benchmarkBatchInserts(numEvents, 1000);
    results.push(batch1000Result);
    
    // Final cleanup
    await cleanupBenchmarkData();
    
    // Display results
    console.log('\n' + '='.repeat(60));
    console.log('BENCHMARK RESULTS');
    console.log('='.repeat(60));
    console.table(results.map(r => ({
      Method: r.method,
      Events: r.events,
      'Duration (s)': r.duration.toFixed(2),
      'Events/sec': Math.round(r.eventsPerSecond),
    })));
    
    // Calculate improvements
    const baseline = results[0].eventsPerSecond;
    console.log('\nPerformance Improvements vs Single Inserts:');
    results.slice(1).forEach(result => {
      const improvement = ((result.eventsPerSecond / baseline) - 1) * 100;
      console.log(`  ${result.method}: ${improvement.toFixed(1)}% faster (${(result.eventsPerSecond / baseline).toFixed(1)}x)`);
    });
    
    console.log('\n' + '='.repeat(60));
    
  } catch (error) {
    console.error('Benchmark failed:', error);
    throw error;
  } finally {
    await db.close();
  }
}

runBenchmarks().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
