import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPauseFlags,
  setPauseFlags,
  isStreamCreationPaused,
  getReindexState,
  triggerReindex,
  _resetForTest,
} from '../../src/state/adminState.js';

describe('adminState', () => {
  beforeEach(() => {
    _resetForTest();
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
