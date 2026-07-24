import { Pool } from 'pg';
import { logger } from '../lib/logger.js';
import { runPartitionMaintenance } from './partitionMaintenance.js';

/**
 * Initializes and schedules background jobs.
 */
export function startBackgroundJobs(pool: Pool): void {
  // Schedule partition maintenance to run every 24 hours
  const intervalMs = 24 * 60 * 60 * 1000;
  
  setInterval(() => {
    runPartitionMaintenance(pool).catch((err) => {
      logger.error('Scheduled partition maintenance job failed', err);
    });
  }, intervalMs);
  
  // Run immediately on startup
  runPartitionMaintenance(pool).catch((err) => {
    logger.error('Startup partition maintenance job failed', err);
  });
}
