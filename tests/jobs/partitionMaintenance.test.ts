import { describe, it, expect, vi } from 'vitest';
import { runPartitionMaintenance } from '../../src/jobs/partitionMaintenance.js';
import { Pool } from 'pg';

describe('runPartitionMaintenance', () => {
  it('acquires lock and creates partitions when they do not exist', async () => {
    const mockPool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] }) // lock
        .mockResolvedValueOnce({ rowCount: 0 }) // check exists (first partition)
        .mockResolvedValueOnce({ rows: [] }) // create (first)
        .mockResolvedValueOnce({ rowCount: 0 }) // check exists (second)
        .mockResolvedValueOnce({ rows: [] }) // create (second)
        .mockResolvedValueOnce({ rowCount: 0 }) // check exists (third)
        .mockResolvedValueOnce({ rows: [] }) // create (third)
        .mockResolvedValueOnce({ rows: [] }) // unlock
    } as unknown as Pool;

    await runPartitionMaintenance(mockPool, 3);
    
    expect(mockPool.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1)', [123456789]);
    expect(mockPool.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [123456789]);
  });

  it('skips partition creation if lock cannot be acquired', async () => {
    const mockPool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: false }] }) // lock
    } as unknown as Pool;

    await runPartitionMaintenance(mockPool, 3);
    
    expect(mockPool.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1)', [123456789]);
    // Should not try to query partitions
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });
});
