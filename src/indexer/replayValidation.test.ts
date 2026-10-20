import { describe, it, expect } from 'vitest';
import { validateReplayRequest } from './replayValidation.js';
import type { ReplayRequest } from '../types/index.js';

function baseRequest(overrides: Partial<ReplayRequest> = {}): ReplayRequest {
  return {
    contract_id: 'contract-1',
    ledger: 100,
    ...overrides,
  };
}

describe('validateReplayRequest', () => {
  it('accepts a valid request with no range', () => {
    expect(() => validateReplayRequest(baseRequest(), 1000)).not.toThrow();
  });

  it('accepts a valid request with from_block and to_block within range', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ from_block: 10, to_block: 20 }), 1000),
    ).not.toThrow();
  });

  it('rejects a missing contract_id', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ contract_id: undefined as unknown as string }), 1000),
    ).toThrow('Invalid contract_id');
  });

  it('rejects an empty string contract_id', () => {
    expect(() => validateReplayRequest(baseRequest({ contract_id: '' }), 1000)).toThrow(
      'Invalid contract_id',
    );
  });

  it('rejects a non-string contract_id', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ contract_id: 42 as unknown as string }), 1000),
    ).toThrow('Invalid contract_id');
  });

  it('rejects a non-number ledger', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ ledger: '100' as unknown as number }), 1000),
    ).toThrow('Invalid ledger');
  });

  it('rejects a negative ledger', () => {
    expect(() => validateReplayRequest(baseRequest({ ledger: -1 }), 1000)).toThrow(
      'Invalid ledger',
    );
  });

  it('accepts a zero ledger', () => {
    expect(() => validateReplayRequest(baseRequest({ ledger: 0 }), 1000)).not.toThrow();
  });

  it('rejects a non-number from_block', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ from_block: '10' as unknown as number }), 1000),
    ).toThrow('Invalid from_block');
  });

  it('rejects a negative from_block', () => {
    expect(() => validateReplayRequest(baseRequest({ from_block: -1 }), 1000)).toThrow(
      'Invalid from_block',
    );
  });

  it('accepts a zero from_block', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ from_block: 0, to_block: 0 }), 1000),
    ).not.toThrow();
  });

  it('rejects a non-number to_block', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ to_block: '10' as unknown as number }), 1000),
    ).toThrow('Invalid to_block');
  });

  it('rejects a negative to_block', () => {
    expect(() => validateReplayRequest(baseRequest({ to_block: -1 }), 1000)).toThrow(
      'Invalid to_block',
    );
  });

  it('rejects from_block greater than to_block', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ from_block: 20, to_block: 10 }), 1000),
    ).toThrow('from_block must be less than or equal to to_block');
  });

  it('accepts from_block equal to to_block', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ from_block: 10, to_block: 10 }), 1000),
    ).not.toThrow();
  });

  it('rejects a range exceeding maxRangeBlocks', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ from_block: 0, to_block: 101 }), 100),
    ).toThrow(
      'Block range 101 exceeds the maximum allowed range of 100. Reduce the range or increase INDEXER_MAX_REPLAY_RANGE_BLOCKS.',
    );
  });

  it('accepts a range exactly at maxRangeBlocks', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ from_block: 0, to_block: 100 }), 100),
    ).not.toThrow();
  });

  it('does not enforce a range limit when maxRangeBlocks is zero', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ from_block: 0, to_block: 1_000_000 }), 0),
    ).not.toThrow();
  });

  it('does not enforce a range limit when maxRangeBlocks is negative', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ from_block: 0, to_block: 1_000_000 }), -1),
    ).not.toThrow();
  });

  it('does not enforce a range limit when from_block is undefined', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ to_block: 1_000_000 }), 100),
    ).not.toThrow();
  });

  it('does not enforce a range limit when to_block is undefined', () => {
    expect(() =>
      validateReplayRequest(baseRequest({ from_block: 0 }), 100),
    ).not.toThrow();
  });
});
