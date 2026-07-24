/**
 * Unit tests for streamEventService.processBatch partial-failure handling.
 *
 * Verifies that processBatch:
 * - Returns a result per input event
 * - Continues processing remaining events when one fails
 * - Reports success=false for the failing event and success=true for others
 * - Handles an empty batch without errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies before importing the service
vi.mock('../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    upsertStream: vi.fn(),
    getById: vi.fn(),
    updateStream: vi.fn(),
  },
}));
vi.mock('../src/utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../src/tracing/hooks.js', () => ({
  enrichActiveSpanWithStream: vi.fn(),
  traceSpan: vi.fn((name, cid, tags, fn) => fn()),
}));
vi.mock('../src/streams/sseEmitter.js', () => ({ deriveStreamId: vi.fn((h: string, i: number) => `${h}-${i}`) }));

import { streamEventService, _resetDedupCache, StreamCreatedEvent } from '../src/services/streamEventService.js';
import { streamRepository } from '../src/db/repositories/streamRepository.js';

function makeCreatedEvent(overrides: Partial<StreamCreatedEvent> = {}): StreamCreatedEvent {
  return {
    type: 'StreamCreated',
    contractId: 'CCONTRACT',
    transactionHash: 'txhash001',
    eventIndex: 0,
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    amount: '1000000',
    ratePerSecond: '1000',
    startTime: 1700000000,
    endTime: 1700086400,
    ...overrides,
  };
}

describe('streamEventService.processBatch', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await _resetDedupCache();
  });

  it('returns an empty array for an empty batch', async () => {
    const results = await streamEventService.processBatch([]);
    expect(results).toHaveLength(0);
  });

  it('returns one result per event', async () => {
    vi.mocked(streamRepository.upsertStream).mockResolvedValue({ created: true } as any);

    const events = [
      makeCreatedEvent({ eventIndex: 0 }),
      makeCreatedEvent({ eventIndex: 1 }),
    ];

    const results = await streamEventService.processBatch(events);
    expect(results).toHaveLength(2);
  });

  it('marks a failing event as success=false without aborting subsequent events', async () => {
    vi.mocked(streamRepository.upsertStream)
      .mockRejectedValueOnce(new Error('DB connection lost'))
      .mockResolvedValueOnce({ created: true } as any);

    const events = [
      makeCreatedEvent({ eventIndex: 0 }),
      makeCreatedEvent({ eventIndex: 1 }),
    ];

    const results = await streamEventService.processBatch(events);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
  });

  it('marks all events as success when all succeed', async () => {
    vi.mocked(streamRepository.upsertStream).mockResolvedValue({ created: true } as any);

    const events = [makeCreatedEvent({ eventIndex: 0 }), makeCreatedEvent({ eventIndex: 1 })];
    const results = await streamEventService.processBatch(events);

    expect(results.every((r) => r.success)).toBe(true);
  });
});
