import { Pool } from 'pg';
import { logger } from '../lib/logger.js';
import { query } from '../db/pool.js';

// Advisory lock ID (arbitrary constant)
const PARTITION_MAINTENANCE_LOCK_ID = 123456789;

/**
 * Ensures partitions exist for the next N months.
 * Idempotent: safe to run multiple times.
 */
export async function runPartitionMaintenance(pool: Pool, monthsAhead = 3): Promise<void> {
  // Use pg_try_advisory_lock to ensure only one instance runs
  const lockRes = await query<{ pg_try_advisory_lock: boolean }>(pool, 'SELECT pg_try_advisory_lock($1)', [PARTITION_MAINTENANCE_LOCK_ID]);
  
  if (!lockRes.rows[0].pg_try_advisory_lock) {
    logger.info('Partition maintenance job already running, skipping.');
    return;
  }

  try {
    await createPartitionsForTable(pool, 'contract_events', monthsAhead);
  } finally {
    await query(pool, 'SELECT pg_advisory_unlock($1)', [PARTITION_MAINTENANCE_LOCK_ID]);
  }
}

async function createPartitionsForTable(pool: Pool, tableName: string, months: number): Promise<void> {
  const now = new Date();
  
  for (let i = 1; i <= months; i++) {
    const targetDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
    
    // Naming convention: table_YYYY_MM
    const partitionName = `${tableName}_${targetDate.getFullYear()}_${(targetDate.getMonth() + 1).toString().padStart(2, '0')}`;
    const startRange = targetDate.toISOString();
    const endRange = nextMonthDate.toISOString();
    
    // Check if partition exists
    const checkExists = await query(pool, 
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = $1`, 
      [partitionName]
    );
    
    if (checkExists.rowCount === 0) {
      logger.info(`Creating partition ${partitionName} for ${tableName}`);
      // Using template strings for DDL is usually dangerous, but table names and bounds 
      // are carefully controlled here.
      await query(pool, `
        CREATE TABLE ${partitionName} PARTITION OF ${tableName}
        FOR VALUES FROM ('${startRange}') TO ('${endRange}');
      `);
    }
  }
}
