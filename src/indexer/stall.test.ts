import { describe, it, expect } from '@jest/globals';
import { assessIndexerHealth } from './stall.js';

describe('assessIndexerHealth', () => {
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

  it('returns starting when lastSuccessfulSyncAt is an unparseable string', () => {
    const health = assessIndexerHealth({
      enabled: true,
      lastSuccessfulSyncAt: 'not-a-date',
    });
    expect(health.status).toBe('starting');
    expect(health.lastSuccessfulSyncAt).toBeNull();
    expect(health.operatorAction).toBe('observe');
  });

  it('accepts a Date object for lastSuccessfulSyncAt', () => {
    const syncAt = new Date(Date.now() - 60_000); // 1 min ago
    const health = assessIndexerHealth({
      enabled: true,
      lastSuccessfulSyncAt: syncAt,
      stallThresholdMs: 5 * 60 * 1000,
    });
    expect(health.status).toBe('healthy');
    expect(health.lagMs).toBeGreaterThanOrEqual(0);
  });

  it('accepts a numeric timestamp for lastSuccessfulSyncAt', () => {
    const syncAt = Date.now() - 30_000; // 30s ago
    const health = assessIndexerHealth({
      enabled: true,
      lastSuccessfulSyncAt: syncAt,
      stallThresholdMs: 5 * 60 * 1000,
    });
    expect(health.status).toBe('healthy');
  });

  it('uses Date.now() fallback when now is an invalid string', () => {
    // Passing an invalid string for `now` — toTimestamp returns null, falls back to Date.now()
    const health = assessIndexerHealth({
      enabled: true,
      lastSuccessfulSyncAt: new Date(Date.now() - 10_000),
      now: 'not-a-date' as unknown as string,
      stallThresholdMs: 5 * 60 * 1000,
    });
    // Should still resolve to healthy (sync was 10s ago, threshold is 5min)
    expect(health.status).toBe('healthy');
  });

  it('uses default threshold when stallThresholdMs is omitted', () => {
    const health = assessIndexerHealth({
      enabled: true,
      lastSuccessfulSyncAt: new Date(Date.now() - 10_000),
    });
    expect(health.thresholdMs).toBe(5 * 60 * 1000);
  });
});
