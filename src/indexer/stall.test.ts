import { describe, it, expect, beforeEach } from 'vitest';
import { assessIndexerHealth, clearIndexerStall, ActiveStallError, _resetForTest } from './stall.js';

describe('assessIndexerHealth', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('returns not_configured when disabled', () => {
    const health = assessIndexerHealth({ enabled: false });
    expect(health.status).toBe('not_configured');
    expect(health.clientImpact).toBe('none');
    expect(health.operatorAction).toBe('none');
  });

  it('returns healthy when within threshold', () => {
    const health = assessIndexerHealth({
      enabled: true,
      lastSuccessfulSyncAt: '2026-03-25T20:00:00.000Z',
      now: '2026-03-25T20:03:00.000Z',
      stallThresholdMs: 5 * 60 * 1000,
    });
    expect(health.status).toBe('healthy');
    expect(health.stalled).toBe(false);
    expect(health.clientImpact).toBe('none');
  });

  it('returns stalled when threshold exceeded', () => {
    const health = assessIndexerHealth({
      enabled: true,
      lastSuccessfulSyncAt: '2026-03-25T20:00:00.000Z',
      now: '2026-03-25T20:06:00.000Z',
      stallThresholdMs: 5 * 60 * 1000,
    });
    expect(health.status).toBe('stalled');
    expect(health.stalled).toBe(true);
    expect(health.clientImpact).toBe('stale_chain_state');
    expect(health.operatorAction).toBe('page');
  });

  it('returns starting when enabled but no sync recorded', () => {
    const health = assessIndexerHealth({ enabled: true });
    expect(health.status).toBe('starting');
    expect(health.stalled).toBe(false);
    expect(health.clientImpact).toBe('stale_chain_state');
  });

  describe('stall detection and automatic recovery', () => {
    it('fires an alert when the stall threshold is crossed and clears automatically once healthy', () => {
      let health = assessIndexerHealth({
        enabled: true,
        lastSuccessfulSyncAt: '2026-03-25T20:00:00.000Z',
        now: '2026-03-25T20:06:00.000Z',
        stallThresholdMs: 5 * 60 * 1000,
      });
      expect(health.status).toBe('stalled');
      expect(health.stalled).toBe(true);
      expect(health.operatorAction).toBe('page');
      expect(health.thresholdMs).toBe(5 * 60 * 1000);

      health = assessIndexerHealth({
        enabled: true,
        lastSuccessfulSyncAt: '2026-03-25T20:00:00.000Z',
        now: '2026-03-25T20:02:00.000Z',
        stallThresholdMs: 5 * 60 * 1000,
      });
      expect(health.status).toBe('healthy');
      expect(health.stalled).toBe(false);
      expect(health.operatorAction).toBe('none');
    });

    it('refuses to clear the flag if still actively stalled', () => {
      const input = {
        enabled: true,
        lastSuccessfulSyncAt: '2026-03-25T20:00:00.000Z',
        now: '2026-03-25T20:06:00.000Z',
        stallThresholdMs: 5 * 60 * 1000,
      };

      assessIndexerHealth(input);

      expect(() => clearIndexerStall(input)).toThrow(ActiveStallError);

      const health = assessIndexerHealth(input);
      expect(health.status).toBe('stalled');
    });
  });
});
