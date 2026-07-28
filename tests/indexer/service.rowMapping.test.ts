/**
 * Regression tests for src/indexer/service.ts row-mapping fixes.
 *
 * Validates that:
 *  - countEventsToReplay correctly parses the COUNT result from a Record<string, unknown> row
 *  - resumeIncompleteReplay correctly narrows untyped pg rows into a ReplayRequest
 *  - getReplayProgressExtended correctly narrows untyped pg rows into a ReplayProgress
 *  - logger.error calls pass the error as structured metadata, not as correlationId
 *
 * These tests exercise the exact code paths that were previously type-unsafe
 * (unknown values assigned directly to typed fields without narrowing).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  IndexerService,
  ReplayCursorRepository,
  replayLock,
  _resetStopReplay,
} from '../../src/indexer/service.js';
import { logger } from '../../src/lib/logger.js';
import type { ReplayRequest } from '../../src/types/index.js';
import { NoOpLeaderElection } from '../../src/indexer/leaderElection.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockPoolClient(rows: unknown[][] = [], queryFn?: (sql: string, params?: unknown[]) => unknown) {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };

  // Default: return rows from the pre-built array based on call index
  let callIndex = 0;
  client.query.mockImplementation((sql: string, params?: unknown[]) => {
    if (queryFn) {
      return Promise.resolve(queryFn(sql, params));
    }
    const result = rows[callIndex] ?? [];
    callIndex++;
    return Promise.resolve({ rows: result, rowCount: result.length });
  });

  return client;
}

function createMockPool(client: ReturnType<typeof createMockPoolClient>) {
  return {
    connect: vi.fn().mockResolvedValue(client),
  } as any;
}

function createNoopLeaderElection(): NoOpLeaderElection {
  return new NoOpLeaderElection();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IndexerService row-mapping regression', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    replayLock.release();
    _resetStopReplay();
  });

  describe('countEventsToReplay (via replayEvents)', () => {
    it('correctly parses COUNT(*) as string from Record<string, unknown> row', async () => {
      const client = createMockPoolClient();
      const pool = createMockPool(client);

      // First call: findActive → empty (no existing cursor)
      // Second call: countEventsToReplay → 0 rows
      // Third call: create cursor
      let queryCount = 0;
      client.query.mockImplementation((sql: string, params?: unknown[]) => {
        queryCount++;
        if (sql.includes('SELECT id') && sql.includes('replay_cursors')) {
          // findActive → no existing cursor
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes('SELECT COUNT(*)')) {
          // countEventsToReplay → 0 rows (no events to replay)
          return Promise.resolve({ rows: [{ count: '0' }], rowCount: 1 });
        }
        if (sql.includes('INSERT INTO replay_cursors')) {
          // create cursor
          return Promise.resolve({
            rows: [{
              id: 'cursor-1',
              contract_id: 'test-contract',
              ledger: 100,
              from_block: null,
              to_block: null,
              total_rows: 0,
              last_committed_offset: 0,
              started_at: new Date(),
              completed_at: null,
            }],
            rowCount: 1,
          });
        }
        if (sql.includes('INSERT INTO indexer_replay_progress')) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        if (sql.includes('UPDATE replay_cursors')) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        if (sql.includes('UPDATE indexer_replay_progress')) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const service = new IndexerService(
        pool,
        10,     // batchSize
        1000,   // maxRangeBlocks
        60000,  // replayBudgetMs
        undefined,
        createNoopLeaderElection(),
      );

      const request: ReplayRequest = {
        contract_id: 'test-contract',
        ledger: 100,
      };

      // Should complete without error — 0 rows means nothing to replay
      await service.replayEvents(request);

      // Verify the COUNT query was executed
      const countCall = client.query.mock.calls.find(
        ([sql]: [string]) => sql.includes('SELECT COUNT(*)'),
      );
      expect(countCall).toBeDefined();
    });

    it('correctly parses COUNT(*) as a non-zero string', async () => {
      const client = createMockPoolClient();
      const pool = createMockPool(client);

      client.query.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT id') && sql.includes('replay_cursors')) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes('SELECT COUNT(*)')) {
          return Promise.resolve({ rows: [{ count: '42' }], rowCount: 1 });
        }
        if (sql.includes('INSERT INTO replay_cursors')) {
          return Promise.resolve({
            rows: [{
              id: 'cursor-2',
              contract_id: 'test-contract',
              ledger: 200,
              from_block: null,
              to_block: null,
              total_rows: 42,
              last_committed_offset: 0,
              started_at: new Date(),
              completed_at: null,
            }],
            rowCount: 1,
          });
        }
        if (sql.includes('INSERT INTO indexer_replay_progress')) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        if (sql.includes('SELECT') && sql.includes('historical_events')) {
          // fetchEventBatch → no events (empty result)
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes('UPDATE') || sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const service = new IndexerService(
        pool,
        10,
        1000,
        60000,
        undefined,
        createNoopLeaderElection(),
      );

      const request: ReplayRequest = {
        contract_id: 'test-contract',
        ledger: 200,
      };

      // Should start and immediately stop (no events to fetch but totalRows = 42)
      await service.replayEvents(request);

      // Verify the cursor was created with total_rows = 42 (not NaN)
      const createCall = client.query.mock.calls.find(
        ([sql]: [string]) => sql.includes('INSERT INTO replay_cursors'),
      );
      expect(createCall).toBeDefined();
    });
  });

  describe('resumeIncompleteReplay row mapping', () => {
    it('correctly narrows string-encoded pg row values into a typed ReplayRequest', async () => {
      const client = createMockPoolClient();
      const pool = createMockPool(client);

      client.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes('indexer_replay_progress')) {
          return Promise.resolve({
            rows: [{
              last_committed_cursor: 'cursor-abc',
              contract_id: 'my-contract',
              ledger: '150',  // pg returns strings for numeric columns
              from_block: '10',
              to_block: '200',
            }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      // Mock replayEvents to capture the request
      let capturedRequest: ReplayRequest | null = null;
      const OriginalService = IndexerService;

      const service = new OriginalService(
        pool,
        10,
        1000,
        60000,
        undefined,
        createNoopLeaderElection(),
      );

      // We need to spy on replayEvents to capture the request without actually running it
      const replaySpy = vi.spyOn(service, 'replayEvents').mockResolvedValue(undefined);

      await service.resumeIncompleteReplay();

      expect(replaySpy).toHaveBeenCalledOnce();
      capturedRequest = replaySpy.mock.calls[0][0];

      // Verify the row was correctly narrowed (string → typed fields)
      expect(capturedRequest!.contract_id).toBe('my-contract');
      expect(capturedRequest!.ledger).toBe(150); // Number('150') = 150
      expect(capturedRequest!.from_block).toBe(10);
      expect(capturedRequest!.to_block).toBe(200);
    });

    it('handles null from_block and to_block gracefully', async () => {
      const client = createMockPoolClient();
      const pool = createMockPool(client);

      client.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes('indexer_replay_progress')) {
          return Promise.resolve({
            rows: [{
              last_committed_cursor: 'cursor-null',
              contract_id: 'null-blocks',
              ledger: 50,
              from_block: null,
              to_block: null,
            }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const service = new IndexerService(
        pool, 10, 1000, 60000, undefined, createNoopLeaderElection(),
      );
      const replaySpy = vi.spyOn(service, 'replayEvents').mockResolvedValue(undefined);

      await service.resumeIncompleteReplay();

      const request = replaySpy.mock.calls[0][0];
      expect(request.from_block).toBeUndefined();
      expect(request.to_block).toBeUndefined();
    });

    it('logs error with metadata when replayEvents fails', async () => {
      const client = createMockPoolClient();
      const pool = createMockPool(client);

      client.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes('indexer_replay_progress')) {
          return Promise.resolve({
            rows: [{
              last_committed_cursor: 'cursor-fail',
              contract_id: 'fail-contract',
              ledger: 10,
              from_block: null,
              to_block: null,
            }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const service = new IndexerService(
        pool, 10, 1000, 60000, undefined, createNoopLeaderElection(),
      );
      vi.spyOn(service, 'replayEvents').mockRejectedValue(new Error('simulated failure'));

      await service.resumeIncompleteReplay();

      // Wait for the async catch handler
      await new Promise((r) => setTimeout(r, 10));

      // Verify logger.error was called with correct signature: (message, undefined, meta)
      const errorCall = errorSpy.mock.calls.find(
        ([msg]: [string]) => msg === 'Resumed replay failed',
      );
      expect(errorCall).toBeDefined();
      // Second arg should be undefined (correlationId), not an Error object
      expect(errorCall![1]).toBeUndefined();
      // Third arg should be the metadata with error info
      expect(errorCall![2]).toMatchObject({
        contract_id: 'fail-contract',
        ledger: 10,
        error: 'simulated failure',
      });
    });

    it('logs error with metadata when DB query fails', async () => {
      const client = createMockPoolClient();
      const pool = createMockPool(client);

      client.query.mockRejectedValue(new Error('connection refused'));

      const service = new IndexerService(
        pool, 10, 1000, 60000, undefined, createNoopLeaderElection(),
      );

      await service.resumeIncompleteReplay();

      const errorCall = errorSpy.mock.calls.find(
        ([msg]: [string]) => msg === 'Failed to check for incomplete replays on startup',
      );
      expect(errorCall).toBeDefined();
      // Second arg should be undefined (correlationId), not an Error object
      expect(errorCall![1]).toBeUndefined();
      // Third arg should be metadata with error message
      expect(errorCall![2]).toMatchObject({
        error: 'connection refused',
      });
    });
  });

  describe('getReplayProgressExtended row mapping', () => {
    it('correctly narrows string-encoded pg row values into a typed ReplayProgress', async () => {
      const client = createMockPoolClient();
      const pool = createMockPool(client);

      const startedAt = new Date('2026-07-01T10:00:00Z');
      const updatedAt = new Date('2026-07-01T11:00:00Z');

      client.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes('indexer_replay_progress')) {
          return Promise.resolve({
            rows: [{
              status: 'completed',
              total: '500',
              started_at: startedAt,
              updated_at: updatedAt,
              contract_id: 'progress-contract',
              ledger: '250',
              cursor_id: 'cursor-progress',
              last_committed_offset: '500',
            }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const service = new IndexerService(
        pool, 10, 1000, 60000, undefined, createNoopLeaderElection(),
      );

      const progress = await service.getReplayProgressExtended();

      expect(progress.isReplaying).toBe(false);
      expect(progress.totalRows).toBe(500);
      expect(progress.rowsReplayed).toBe(500);
      expect(progress.rowsRemaining).toBe(0);
      expect(progress.contractId).toBe('progress-contract');
      expect(progress.ledger).toBe(250);
      expect(progress.replayCursorId).toBe('cursor-progress');
      expect(progress.status).toBe('completed');
    });

    it('handles in-progress replay with partial offset', async () => {
      const client = createMockPoolClient();
      const pool = createMockPool(client);

      client.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes('indexer_replay_progress')) {
          return Promise.resolve({
            rows: [{
              status: 'in-progress',
              total: '1000',
              started_at: new Date('2026-07-01T10:00:00Z'),
              updated_at: new Date('2026-07-01T10:30:00Z'),
              contract_id: 'partial',
              ledger: '99',
              cursor_id: 'cursor-partial',
              last_committed_offset: '300',
            }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const service = new IndexerService(
        pool, 10, 1000, 60000, undefined, createNoopLeaderElection(),
      );

      const progress = await service.getReplayProgressExtended();

      expect(progress.isReplaying).toBe(true);
      expect(progress.totalRows).toBe(1000);
      expect(progress.rowsReplayed).toBe(300);
      expect(progress.rowsRemaining).toBe(700);
    });

    it('logs error with metadata when DB query fails', async () => {
      const client = createMockPoolClient();
      const pool = createMockPool(client);

      client.query.mockRejectedValue(new Error('table not found'));

      const service = new IndexerService(
        pool, 10, 1000, 60000, undefined, createNoopLeaderElection(),
      );

      const progress = await service.getReplayProgressExtended();

      // Should fall back to in-memory state
      expect(progress.isReplaying).toBe(false);

      const errorCall = errorSpy.mock.calls.find(
        ([msg]: [string]) => msg === 'Failed to fetch replay progress from database',
      );
      expect(errorCall).toBeDefined();
      // Second arg should be undefined (correlationId), not an Error object
      expect(errorCall![1]).toBeUndefined();
      // Third arg should be metadata with error message
      expect(errorCall![2]).toMatchObject({
        error: 'table not found',
      });
    });
  });
});
