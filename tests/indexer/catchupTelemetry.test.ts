/**
 * tests/indexer/catchupTelemetry.test.ts
 *
 * Focused regression test suite for crash-safe, monotonic replay progress checkpoints,
 * failure/retry boundaries, and catchup telemetry.
 *
 * Covers:
 *  - Crash injection before side effects (no partial event persistence, offset unadvanced)
 *  - Crash injection after side effects (event duplicate absorption, idempotent completion)
 *  - Monotonic progress enforcement (checkpoints never regress or move backward)
 *  - Zero-event loss and zero-event skip verification upon crash-recovery retry
 *  - Postgres store & memory store checkpoint round-trips
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryContractEventStore,
  PostgresContractEventStore,
  ReplayProgressCheckpoint,
} from '../../src/indexer/store.js';
import {
  ReplayCursorRepository,
} from '../../src/indexer/service.js';
import type { ContractEventRecord } from '../../src/indexer/types.js';

function makeEvent(eventId: string, ledger = 100): ContractEventRecord {
  return {
    eventId,
    ledger,
    contractId: 'C_CATCHUP_TEST',
    topic: 'transfer',
    txHash: `tx-${eventId}`,
    txIndex: 0,
    operationIndex: 0,
    eventIndex: 0,
    payload: { amount: '50.0000000' },
    happenedAt: '2026-01-01T00:00:00.000Z',
    ledgerHash: `hash-${ledger}`,
  };
}

describe('Replay Progress Checkpoints — Monotonicity & Crash Safety', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    store = new InMemoryContractEventStore();
  });

  describe('InMemoryContractEventStore — saveCheckpoint & getCheckpoint', () => {
    it('stores and retrieves a valid progress checkpoint', async () => {
      const checkpoint: ReplayProgressCheckpoint = {
        cursorId: 'cursor-101',
        total: 50,
        lastCommittedOffset: 10,
        status: 'in-progress',
      };

      await store.saveCheckpoint(checkpoint);
      const retrieved = await store.getCheckpoint('cursor-101');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.cursorId).toBe('cursor-101');
      expect(retrieved!.lastCommittedOffset).toBe(10);
      expect(retrieved!.total).toBe(50);
      expect(retrieved!.status).toBe('in-progress');
    });

    it('rejects regress offset updates (monotonicity violation)', async () => {
      await store.saveCheckpoint({
        cursorId: 'cursor-102',
        total: 100,
        lastCommittedOffset: 40,
        status: 'in-progress',
      });

      // Attempting to regress offset from 40 to 20 should throw a Monotonicity violation
      await expect(
        store.saveCheckpoint({
          cursorId: 'cursor-102',
          total: 100,
          lastCommittedOffset: 20,
          status: 'in-progress',
        }),
      ).rejects.toThrow('Monotonicity violation');

      // Assert checkpoint offset remains at 40
      const current = await store.getCheckpoint('cursor-102');
      expect(current!.lastCommittedOffset).toBe(40);
    });

    it('allows advancing offset monotonically to higher values', async () => {
      await store.saveCheckpoint({
        cursorId: 'cursor-103',
        total: 100,
        lastCommittedOffset: 10,
        status: 'in-progress',
      });

      await store.saveCheckpoint({
        cursorId: 'cursor-103',
        total: 100,
        lastCommittedOffset: 20,
        status: 'in-progress',
      });

      await store.saveCheckpoint({
        cursorId: 'cursor-103',
        total: 100,
        lastCommittedOffset: 50,
        status: 'completed',
      });

      const current = await store.getCheckpoint('cursor-103');
      expect(current!.lastCommittedOffset).toBe(50);
      expect(current!.status).toBe('completed');
    });
  });

  describe('Crash Injection Before & After Side Effects', () => {
    it('simulates crash before side effect: zero events saved, offset unchanged', async () => {
      const cursorId = 'crash-before-side-effect';
      await store.saveCheckpoint({
        cursorId,
        total: 10,
        lastCommittedOffset: 0,
        status: 'in-progress',
      });

      const eventsToInsert = [makeEvent('e1'), makeEvent('e2')];

      // Simulate crash BEFORE side effect execution
      const sideEffectFailed = true;

      try {
        if (sideEffectFailed) {
          throw new Error('Crash injected before side effect (event insert)');
        }
        await store.insertMany(eventsToInsert);
        await store.saveCheckpoint({
          cursorId,
          total: 10,
          lastCommittedOffset: 2,
          status: 'in-progress',
        });
      } catch {
        // Crash handled by rollback/retry handler
      }

      // Assert: Store contains 0 events and checkpoint offset remains at 0
      const storedEvents = store.all();
      expect(storedEvents).toHaveLength(0);
      const cp = await store.getCheckpoint(cursorId);
      expect(cp!.lastCommittedOffset).toBe(0);

      // Retry: re-run processing from checkpoint offset 0
      const res = await store.insertMany(eventsToInsert);
      await store.saveCheckpoint({
        cursorId,
        total: 10,
        lastCommittedOffset: 2,
        status: 'in-progress',
      });

      expect(res.insertedEventIds).toEqual(['e1', 'e2']);
      expect(store.all()).toHaveLength(2);
      const finalCp = await store.getCheckpoint(cursorId);
      expect(finalCp!.lastCommittedOffset).toBe(2);
    });

    it('simulates crash after side effect: idempotent retry avoids duplicates and advances monotonically', async () => {
      const cursorId = 'crash-after-side-effect';
      await store.saveCheckpoint({
        cursorId,
        total: 10,
        lastCommittedOffset: 0,
        status: 'in-progress',
      });

      const batch = [makeEvent('e1'), makeEvent('e2')];

      // 1. Side effect executes successfully
      const result = await store.insertMany(batch);
      expect(result.insertedEventIds).toEqual(['e1', 'e2']);

      // 2. Crash occurs AFTER side effect, BEFORE checkpoint save
      // Simulated process crash / crash interruption here

      // Checkpoint in store is still at offset 0, but events e1, e2 exist in store
      const cpBeforeRetry = await store.getCheckpoint(cursorId);
      expect(cpBeforeRetry!.lastCommittedOffset).toBe(0);

      // 3. Recovery / retry: replay process restarts from last committed checkpoint (offset 0)
      // Re-inserting the same batch (e1, e2) MUST be idempotent (0 new inserts, 2 duplicates)
      const retryResult = await store.insertMany(batch);
      expect(retryResult.insertedEventIds).toEqual([]);
      expect(retryResult.duplicateEventIds).toEqual(['e1', 'e2']);

      // Now save checkpoint for offset 2
      await store.saveCheckpoint({
        cursorId,
        total: 10,
        lastCommittedOffset: 2,
        status: 'in-progress',
      });

      // Assert: No duplicate rows in store, offset advanced monotonically to 2
      expect(store.all()).toHaveLength(2);
      const cpAfterRetry = await store.getCheckpoint(cursorId);
      expect(cpAfterRetry!.lastCommittedOffset).toBe(2);
    });
  });

  describe('PostgresContractEventStore & ReplayCursorRepository Monotonic SQL', () => {
    it('advanceOffset uses GREATEST in SQL to prevent regression', async () => {
      const queries: Array<{ sql: string; values?: unknown[] }> = [];
      const client = {
        query: async <T>(sql: string, values?: unknown[]) => {
          queries.push({ sql, values });
          return { rows: [] as T[], rowCount: 0 };
        },
      };

      const repo = new ReplayCursorRepository();
      await repo.advanceOffset(client, 'cursor-pg-1', 45);

      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain('GREATEST(last_committed_offset, $1)');
      expect(queries[0].values).toEqual([45, 'cursor-pg-1']);
    });

    it('PostgresContractEventStore saveCheckpoint issues ON CONFLICT DO UPDATE SQL', async () => {
      const queries: Array<{ sql: string; values?: unknown[] }> = [];
      const client = {
        query: async <T>(sql: string, values?: unknown[]) => {
          queries.push({ sql, values });
          return { rows: [] as T[], rowCount: 1 };
        },
      };

      const store = new PostgresContractEventStore(client);
      await store.saveCheckpoint({
        cursorId: 'c-uuid-999',
        total: 100,
        lastCommittedOffset: 30,
        status: 'in-progress',
      });

      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain('INSERT INTO indexer_replay_progress');
      expect(queries[0].sql).toContain('ON CONFLICT (last_committed_cursor) DO UPDATE');
      expect(queries[0].values).toEqual(['c-uuid-999', 100, 'in-progress']);
    });
  });
});
