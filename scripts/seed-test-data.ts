/**
 * Script to seed test data into historical_events table
 * 
 * Usage:
 *   ts-node scripts/seed-test-data.ts [num_events]
 * 
 * Example:
 *   ts-node scripts/seed-test-data.ts 10000
 */

import { db } from '../src/db/client';

async function seedTestData(numEvents: number = 1000) {
  console.log(`Seeding ${numEvents} test events...`);
  
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    // Generate test events in batches
    const batchSize = 1000;
    let inserted = 0;
    
    for (let i = 0; i < numEvents; i += batchSize) {
      const currentBatchSize = Math.min(batchSize, numEvents - i);
      const values: any[] = [];
      const placeholders: string[] = [];
      
      for (let j = 0; j < currentBatchSize; j++) {
        const eventIndex = i + j;
        const baseIndex = j * 7;
        
        placeholders.push(
          `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7})`
        );
        
        values.push(
          `event-${eventIndex}`,
          `contract-${Math.floor(eventIndex / 100)}`,
          Math.floor(eventIndex / 1000) + 1,
          ['Transfer', 'Mint', 'Burn', 'Approve'][eventIndex % 4],
          JSON.stringify({
            from: `addr-${eventIndex}`,
            to: `addr-${eventIndex + 1}`,
            amount: Math.floor(Math.random() * 1000000),
          }),
          1000 + eventIndex,
          `tx-${eventIndex}`
        );
      }
      
      const query = `
        INSERT INTO historical_events (
          event_id,
          contract_id,
          ledger,
          event_type,
          event_data,
          block_height,
          transaction_hash
        ) VALUES ${placeholders.join(', ')}
        ON CONFLICT (event_id) DO NOTHING
      `;
      
      await client.query(query, values);
      inserted += currentBatchSize;
      
      if (inserted % 5000 === 0) {
        console.log(`  Inserted ${inserted}/${numEvents} events...`);
      }
    }
    
    await client.query('COMMIT');
    console.log(`✓ Successfully seeded ${numEvents} test events`);
    
    // Show summary
    const summary = await client.query(`
      SELECT 
        contract_id,
        ledger,
        COUNT(*) as event_count,
        MIN(block_height) as min_block,
        MAX(block_height) as max_block
      FROM historical_events
      GROUP BY contract_id, ledger
      ORDER BY contract_id, ledger
      LIMIT 10
    `);
    
    console.log('\nSample data summary:');
    console.table(summary.rows);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to seed test data:', error);
    throw error;
  } finally {
    client.release();
    await db.close();
  }
}

// Parse command line arguments
const numEvents = parseInt(process.argv[2] || '1000', 10);

if (isNaN(numEvents) || numEvents <= 0) {
  console.error('Invalid number of events. Usage: ts-node scripts/seed-test-data.ts [num_events]');
  process.exit(1);
}

seedTestData(numEvents).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
