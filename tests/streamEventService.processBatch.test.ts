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
    findByStreamId: vi.fn(),
    createStream: vi.fn(),
    updateStream: vi.fn(),
  },
}));
vi.mock('../src/utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../src/ws/hub.js', () => ({ getStreamHub: vi.fn(() => null) }));
vi.mock('../src/tracing/hooks.js', () => ({ enrichActiveSpanWithStream: vi.fn() }));
vi.mock('../src/streams/sseEmitter.js', () => ({ deriveStreamId: vi.fn((h: string, i: number) => `${h}-${i}`) }));

import { streamEventService, StreamCreatedEvent } from '../src/services/streamEventService.js';
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
    cliffTimestamp: 0,
    startTimestamp: 1700000000,
    endTimestamp: 1700086400,
    ...overrides,
  };
}

describe('streamEventService.processBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty array for an empty batch', async () => {
    const results = await streamEventService.processBatch([]);
    expect(results).toHaveLength(0);
  });

  it('returns one result per event', async () => {
    (streamRepository.findByStreamId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (streamRepository.createStream as ReturnType<typeof vi.fn>).mockResolvedValue({ id: '1' });

    const events = [
      makeCreatedEvent({ eventIndex: 0 }),
      makeCreatedEvent({ eventIndex: 1 }),
    ];

    const results = await streamEventService.processBatch(events);
    expect(results).toHaveLength(2);
  });

  it('marks a failing event as success=false without aborting subsequent events', async () => {
    const repoMock = streamRepository.findByStreamId as ReturnType<typeof vi.fn>;
    const createMock = streamRepository.createStream as ReturnType<typeof vi.fn>;

    // First event: repository throws (simulates DB failure)
    repoMock.mockRejectedValueOnce(new Error('DB connection lost'));
    // Second event: processes normally
    repoMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValue({ id: '2' });

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
    (streamRepository.findByStreamId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (streamRepository.createStream as ReturnType<typeof vi.fn>).mockResolvedValue({ id: '1' });

    const events = [makeCreatedEvent({ eventIndex: 0 }), makeCreatedEvent({ eventIndex: 1 })];
    const results = await streamEventService.processBatch(events);

    expect(results.every((r) => r.success)).toBe(true);
  });
});
