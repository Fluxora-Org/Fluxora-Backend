import {
  defaultChainStatusForStartTime,
  mapChainStatusToApiStatus,
} from './status.js';

describe('stream status mapping', () => {
  it('maps pending to scheduled', () => {
    expect(mapChainStatusToApiStatus('pending')).toEqual({
      chainStatus: 'pending',
      status: 'scheduled',
      terminal: false,
    });
  });

  it('maps depleted to completed with a reason', () => {
    expect(mapChainStatusToApiStatus('depleted')).toEqual({
      chainStatus: 'depleted',
      status: 'completed',
      terminal: true,
      statusReason: 'depleted',
    });
  });

  it('treats future start times as pending', () => {
    expect(defaultChainStatusForStartTime(2_000_000_000, 1_900_000_000)).toBe('pending');
  });

  it('treats past start times as active', () => {
    expect(defaultChainStatusForStartTime(1_800_000_000, 1_900_000_000)).toBe('active');
  });
});
