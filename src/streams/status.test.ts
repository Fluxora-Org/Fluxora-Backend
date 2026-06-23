import { describe, it, expect } from 'vitest';
import {
  defaultChainStatusForStartTime,
  mapChainStatusToApiStatus,
} from './status.js';

describe('mapChainStatusToApiStatus', () => {
  it('maps pending to active non-terminal', () => {
    expect(mapChainStatusToApiStatus('pending')).toEqual({
      chainStatus: 'pending',
      status: 'active',
      terminal: false,
    });
  });

  it('maps depleted to completed terminal with reason', () => {
    expect(mapChainStatusToApiStatus('depleted')).toEqual({
      chainStatus: 'depleted',
      status: 'completed',
      terminal: true,
      statusReason: 'depleted',
    });
  });
});

describe('defaultChainStatusForStartTime', () => {
  it('returns pending for future start time', () => {
    expect(defaultChainStatusForStartTime(2_000_000_000, 1_900_000_000)).toBe('pending');
  });

  it('returns active for past start time', () => {
    expect(defaultChainStatusForStartTime(1_800_000_000, 1_900_000_000)).toBe('active');
  });
});
