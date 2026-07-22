import { vi } from 'vitest';
import { correlationStore } from '../../src/tracing/middleware.js';
import { logger } from '../../src/lib/logger.js';
import { query } from '../../src/db/pool.js';
import pg from 'pg';

describe('Logger Correlation ID', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('automatically attaches correlationId from AsyncLocalStorage to slow DB query logs', async () => {
    // Spy on process.stdout.write to capture the log line
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const testCorrelationId = 'test-correlation-id-123';

    // Mock pg.Pool
    const pool = {
      query: vi.fn().mockImplementation(async () => {
        // simulate slow query by waiting
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { rows: [] };
      }),
      waitingCount: 0,
      totalCount: 1,
      idleCount: 1,
      _queueLimit: 50,
    } as unknown as pg.Pool;

    await correlationStore.run(testCorrelationId, async () => {
      // Execute a query with a low slow-query threshold to force a log
      await query(pool, 'SELECT 1 FROM test_table', [], 10);
    });

    // Verify a slow query was logged
    const calls = writeSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('slow_query')
    );
    expect(calls.length).toBeGreaterThan(0);

    const logRecord = JSON.parse(calls[0][0] as string);
    
    // Assert the correlation ID matches the request's correlation ID
    expect(logRecord.correlation_id).toBe(testCorrelationId);
  });
});
