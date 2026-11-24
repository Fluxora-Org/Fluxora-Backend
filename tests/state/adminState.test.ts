import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getPauseFlags,
  setPauseFlags,
  isStreamCreationPaused,
  getReindexState,
  triggerReindex,
  initializeAdminStateLock,
  AdminStatePersistenceError,
  _resetForTest,
  _reloadPauseFlagsFromPersistenceForTest,
  _setReindexRunnerForTest,
  cancelReindex,
  indexerReplayRunner,
  triggerStreamReindex,
} from '../../src/state/adminState.js';
import { TEST_REINDEX_TARGET, timedReindexRunner } from '../helpers/fakeReindexRunner.js';
import { RedisDistributedLock } from '../../src/state/adminStateLock.js';
import { NoOpRedisClient } from '../../src/redis/client.js';

describe('adminState', () => {
  let originalAdminStateFile: string | undefined;
  let adminStateFile: string;

  beforeEach(() => {
    originalAdminStateFile = process.env.ADMIN_STATE_FILE;
    adminStateFile = join(
      tmpdir(),
      `fluxora-admin-state-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    process.env.ADMIN_STATE_FILE = adminStateFile;
    _resetForTest();
    _setReindexRunnerForTest(timedReindexRunner());
  });

  afterEach(() => {
    _setReindexRunnerForTest(null);
    vi.restoreAllMocks();
    _resetForTest();
    fs.rmSync(adminStateFile, { recursive: true, force: true });

    if (originalAdminStateFile !== undefined) {
      process.env.ADMIN_STATE_FILE = originalAdminStateFile;
    } else {
      delete process.env.ADMIN_STATE_FILE;
    }
  });

  describe('pause flags', () => {
    it('defaults to all flags false', () => {
      const flags = getPauseFlags();
      expect(flags.streamCreation).toBe(false);
      expect(flags.ingestion).toBe(false);
    });

    it('sets streamCreation flag', async () => {
      const updated = await setPauseFlags({ streamCreation: true });
      expect(updated.streamCreation).toBe(true);
      expect(updated.ingestion).toBe(false);
    });

    it('sets ingestion flag', async () => {
      const updated = await setPauseFlags({ ingestion: true });
      expect(updated.streamCreation).toBe(false);
      expect(updated.ingestion).toBe(true);
    });

    it('sets both flags at once', async () => {
      const updated = await setPauseFlags({ streamCreation: true, ingestion: true });
      expect(updated.streamCreation).toBe(true);
      expect(updated.ingestion).toBe(true);
    });

    it('returns a copy, not a reference', () => {
      const a = getPauseFlags();
      a.streamCreation = true;
      expect(getPauseFlags().streamCreation).toBe(false);
    });

    it('isStreamCreationPaused reflects state', async () => {
      expect(isStreamCreationPaused()).toBe(false);
      await setPauseFlags({ streamCreation: true });
      expect(isStreamCreationPaused()).toBe(true);
    });

    it('persists pause flags and reloads them from storage', async () => {
      await setPauseFlags({ streamCreation: true, ingestion: true });

      _resetForTest({ clearPersistence: false });
      expect(getPauseFlags()).toEqual({ streamCreation: false, ingestion: false });

      _reloadPauseFlagsFromPersistenceForTest();
      expect(getPauseFlags()).toEqual({ streamCreation: true, ingestion: true });
    });

    it('ignores invalid persisted payload and falls back to defaults', () => {
      fs.writeFileSync(adminStateFile, '{"version":1,"pauseFlags":{"streamCreation":"yes"}}\n', 'utf8');

      _reloadPauseFlagsFromPersistenceForTest();
      expect(getPauseFlags()).toEqual({ streamCreation: false, ingestion: false });
    });

    it('throws and keeps prior state when persistence write fails', async () => {
      await setPauseFlags({ streamCreation: true });

      // Make the destination a directory so the atomic rename fails without
      // mocking node:fs or depending on ESM module spying.
      fs.rmSync(adminStateFile, { force: true });
      fs.mkdirSync(adminStateFile);

      await expect(setPauseFlags({ ingestion: true })).rejects.toBeInstanceOf(
        AdminStatePersistenceError,
      );
      expect(getPauseFlags()).toEqual({ streamCreation: true, ingestion: false });
    });

    it('handles concurrent writes safely via distributed lock', async () => {
      // Simulate 5 concurrent writes that should not corrupt the state file
      const promises = Array.from({ length: 5 }, (_, i) =>
        setPauseFlags({
          streamCreation: i % 2 === 0,
          ingestion: i % 2 !== 0,
        }),
      );

      const results = await Promise.all(promises);

      // All writes should succeed (no exceptions)
      expect(results).toHaveLength(5);
      results.forEach((result) => {
        expect(result).toHaveProperty('streamCreation');
        expect(result).toHaveProperty('ingestion');
      });

      // State file should be valid JSON and readable
      const fileContents = fs.readFileSync(adminStateFile, 'utf8');
      const parsed = JSON.parse(fileContents);
      expect(parsed.version).toBe(1);
      expect(parsed.pauseFlags).toHaveProperty('streamCreation');
      expect(parsed.pauseFlags).toHaveProperty('ingestion');

      // Final state should match last write
      _reloadPauseFlagsFromPersistenceForTest();
      const finalFlags = getPauseFlags();
      expect(finalFlags.streamCreation).toBe(4 % 2 === 0);
      expect(finalFlags.ingestion).toBe(4 % 2 !== 0);
    });

    it('serializes concurrent writes via distributed lock', async () => {
      const writeOrder: number[] = [];

      // Mock console to track write order (in practice, this would show lock acquires)
      const writePromises = Array.from({ length: 3 }, (_, i) =>
        setPauseFlags({
          streamCreation: i === 0,
          ingestion: i === 1,
        }).then((result) => {
          writeOrder.push(i);
          return result;
        }),
      );

      await Promise.all(writePromises);

      // Verify that state file contains valid JSON (lock prevented corruption)
      const fileContents = fs.readFileSync(adminStateFile, 'utf8');
      expect(() => JSON.parse(fileContents)).not.toThrow();

      // All writes should have completed
      expect(writeOrder).toHaveLength(3);
    });

    it('exercises fallback locking path when no Redis is initialized', async () => {
      _resetForTest();
      const updated = await setPauseFlags({ streamCreation: true });
      expect(updated.streamCreation).toBe(true);

      _reloadPauseFlagsFromPersistenceForTest();
      expect(getPauseFlags().streamCreation).toBe(true);
    });

    it('exercises locking path after initializeAdminStateLock', async () => {
      _resetForTest();
      initializeAdminStateLock(new NoOpRedisClient());
      const updated = await setPauseFlags({ ingestion: true });
      expect(updated.ingestion).toBe(true);

      _reloadPauseFlagsFromPersistenceForTest();
      expect(getPauseFlags().ingestion).toBe(true);
    });

    it('verifies RedisDistributedLock implements Lock interface acquire and release', async () => {
      const lock = new RedisDistributedLock(new NoOpRedisClient(), 'testNamespace');
      const acquired = await lock.acquire();
      expect(typeof acquired.acquire).toBe('function');
      expect(typeof acquired.release).toBe('function');
      await acquired.release();
      await lock.release();
    });

    it('RedisDistributedLock backed by NoOpRedisClient acquires immediately (single-process semantics)', async () => {
      // NoOpRedisClient.setNx() returns true — simulating an uncontended
      // single-process lock. The lock should be acquired on the first attempt.
      const lock = new RedisDistributedLock(new NoOpRedisClient(), 'noOpTest', { timeoutMs: 100 });
      const acquired = await lock.acquire();
      expect(acquired).toBeDefined();
      expect(typeof acquired.release).toBe('function');
      await acquired.release();
    });

    it('RedisDistributedLock with NoOpRedisClient can acquire and release repeatedly', async () => {
      // Each acquire call should succeed because NoOpRedisClient.setNx
      // simulates an always-uncontended lock. This is correct for no-Redis
      // single-process mode where in-process state guards provide exclusion.
      const lock = new RedisDistributedLock(new NoOpRedisClient(), 'noOpRepeated', { timeoutMs: 100 });

      const a = await lock.acquire();
      expect(typeof a.release).toBe('function');
      await a.release();

      const b = await lock.acquire();
      expect(typeof b.release).toBe('function');
      await b.release();
    });
  });

  describe('reindex', () => {
    it('defaults to idle with no timestamps', () => {
      const state = getReindexState();
      expect(state.status).toBe('idle');
      expect(state.startedAt).toBeNull();
      expect(state.completedAt).toBeNull();
      expect(state.error).toBeNull();
      expect(state.processedItems).toBe(0);
    });

    it('transitions to running on triggerReindex', async () => {
      const result = await triggerReindex(TEST_REINDEX_TARGET);
      expect(result.status).toBe('running');
      expect(result.startedAt).toBeTruthy();
    });

    it('completes after the background job finishes', async () => {
      await triggerReindex(TEST_REINDEX_TARGET);

      // Wait for the fake runner's 5 batches (5 × 50ms + margin).
      await new Promise((r) => setTimeout(r, 400));

      const state = getReindexState();
      expect(state.status).toBe('completed');
      expect(state.completedAt).toBeTruthy();
      expect(state.processedItems).toBe(5);
      expect(state.totalItems).toBe(5);
      expect(state.target).toEqual(TEST_REINDEX_TARGET);
    });

    it('records the replay error and outcome failed', async () => {
      _setReindexRunnerForTest({
        run: async () => {
          throw new Error('historical_events query failed');
        },
        cancel: () => {},
      });
      await triggerReindex(TEST_REINDEX_TARGET);
      await new Promise((r) => setImmediate(r));

      const state = getReindexState();
      expect(state.status).toBe('failed');
      expect(state.error).toBe('historical_events query failed');
      expect(state.completedAt).toBeTruthy();
    });

    it('cancelReindex stops the replay and ends the job as cancelled', async () => {
      _setReindexRunnerForTest(timedReindexRunner(10, 30));
      await triggerReindex(TEST_REINDEX_TARGET);
      await new Promise((r) => setTimeout(r, 75));

      expect(cancelReindex().status).toBe('running');
      await new Promise((r) => setTimeout(r, 100));

      const state = getReindexState();
      expect(state.status).toBe('cancelled');
      expect(state.processedItems).toBeGreaterThan(0);
      expect(state.processedItems).toBeLessThan(10);
      expect(state.totalItems).toBe(10);
      expect(state.error).toBeNull();
    });

    it('cancelReindex is a no-op when nothing is running', () => {
      const cancel = vi.fn();
      _setReindexRunnerForTest({ run: vi.fn(), cancel });
      expect(cancelReindex().status).toBe('idle');
      expect(cancel).not.toHaveBeenCalled();
    });

    it('a reset while a job runs is not overwritten when that job finishes', async () => {
      await triggerReindex(TEST_REINDEX_TARGET);
      _resetForTest();
      await new Promise((r) => setTimeout(r, 400));
      expect(getReindexState().status).toBe('idle');
    });

    it('triggerStreamReindex rejects an unknown stream without starting a replay', async () => {
      const run = vi.fn();
      _setReindexRunnerForTest({ run, cancel: () => {} });
      const { streamRepository } = await import('../../src/db/repositories/streamRepository.js');
      vi.spyOn(streamRepository, 'getById').mockResolvedValue(undefined);

      await expect(triggerStreamReindex('missing-stream', { ledger: 3 })).rejects.toThrow(
        'Stream missing-stream not found',
      );
      expect(run).not.toHaveBeenCalled();
    });

    it("triggerStreamReindex replays the stream's contract on the given ledger", async () => {
      const run = vi.fn(() => new Promise<never>(() => {}));
      _setReindexRunnerForTest({ run, cancel: () => {} });
      const { streamRepository } = await import('../../src/db/repositories/streamRepository.js');
      vi.spyOn(streamRepository, 'getById').mockResolvedValue({
        contract_id: 'CSTREAMCONTRACT',
      } as Awaited<ReturnType<typeof streamRepository.getById>>);

      const state = await triggerStreamReindex('stream-1', { ledger: 3, from_block: 10 });
      expect(state.status).toBe('running');
      expect(run).toHaveBeenCalledWith(
        { contract_id: 'CSTREAMCONTRACT', ledger: 3, from_block: 10 },
        expect.any(Function),
      );

      // A second stream reindex while one runs fails rather than claiming success.
      await expect(triggerStreamReindex('stream-2', { ledger: 3 })).rejects.toThrow(/already in progress/);
    });
  });

  describe('indexerReplayRunner (production wiring)', () => {
    it('drives IndexerService.replayEvents with the target and forwards batch progress', async () => {
      const { indexerService } = await import('../../src/indexer/service.js');
      const spy = vi
        .spyOn(indexerService, 'replayEvents')
        .mockImplementation(async (_req, options) => {
          options?.onProgress?.({ processedRows: 0, totalRows: 40 });
          options?.onProgress?.({ processedRows: 40, totalRows: 40 });
          return { outcome: 'completed', processedRows: 40, totalRows: 40 };
        });
      const seen: Array<{ processedRows: number; totalRows: number }> = [];

      const result = await indexerReplayRunner.run(TEST_REINDEX_TARGET, (u) => seen.push(u));

      expect(spy).toHaveBeenCalledWith(TEST_REINDEX_TARGET, { onProgress: expect.any(Function) });
      expect(seen).toEqual([
        { processedRows: 0, totalRows: 40 },
        { processedRows: 40, totalRows: 40 },
      ]);
      expect(result).toEqual({ outcome: 'completed', processedRows: 40, totalRows: 40 });
    });

    it('cancel requests a replay stop', async () => {
      const runtime = await import('../../src/indexer/replayRuntimeState.js');
      runtime._resetStopReplay();
      indexerReplayRunner.cancel();
      expect(runtime.isReplayStopRequested()).toBe(true);
      runtime._resetStopReplay();
    });

    it('returns current state if reindex is already running', async () => {
      await triggerReindex(TEST_REINDEX_TARGET);
      const second = await triggerReindex(TEST_REINDEX_TARGET);
      expect(second.status).toBe('running');
    });

    it('returns a copy, not a reference', () => {
      const a = getReindexState();
      a.status = 'failed';
      expect(getReindexState().status).toBe('idle');
    });
  });
});
