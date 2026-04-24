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
  AdminStatePersistenceError,
  _resetForTest,
  _reloadPauseFlagsFromPersistenceForTest,
} from '../../src/state/adminState.js';

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
  });

  afterEach(() => {
    _resetForTest();

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

    it('sets streamCreation flag', () => {
      const updated = setPauseFlags({ streamCreation: true });
      expect(updated.streamCreation).toBe(true);
      expect(updated.ingestion).toBe(false);
    });

    it('sets ingestion flag', () => {
      const updated = setPauseFlags({ ingestion: true });
      expect(updated.streamCreation).toBe(false);
      expect(updated.ingestion).toBe(true);
    });

    it('sets both flags at once', () => {
      const updated = setPauseFlags({ streamCreation: true, ingestion: true });
      expect(updated.streamCreation).toBe(true);
      expect(updated.ingestion).toBe(true);
    });

    it('returns a copy, not a reference', () => {
      const a = getPauseFlags();
      a.streamCreation = true;
      expect(getPauseFlags().streamCreation).toBe(false);
    });

    it('isStreamCreationPaused reflects state', () => {
      expect(isStreamCreationPaused()).toBe(false);
      setPauseFlags({ streamCreation: true });
      expect(isStreamCreationPaused()).toBe(true);
    });

    it('persists pause flags and reloads them from storage', () => {
      setPauseFlags({ streamCreation: true, ingestion: true });

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

    it('throws and keeps prior state when persistence write fails', () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('disk full');
      });

      expect(() => setPauseFlags({ streamCreation: true })).toThrow(AdminStatePersistenceError);
      expect(getPauseFlags()).toEqual({ streamCreation: false, ingestion: false });

      writeSpy.mockRestore();
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
      const result = await triggerReindex();
      expect(result.status).toBe('running');
      expect(result.startedAt).toBeTruthy();
    });

    it('completes after the background job finishes', async () => {
      await triggerReindex();

      // Wait for the simulated job (5 × 50ms + margin).
      await new Promise((r) => setTimeout(r, 400));

      const state = getReindexState();
      expect(state.status).toBe('completed');
      expect(state.completedAt).toBeTruthy();
      expect(state.processedItems).toBe(5);
    });

    it('returns current state if reindex is already running', async () => {
      await triggerReindex();
      const second = await triggerReindex();
      expect(second.status).toBe('running');
    });

    it('returns a copy, not a reference', () => {
      const a = getReindexState();
      a.status = 'failed';
      expect(getReindexState().status).toBe('idle');
    });
  });
});
