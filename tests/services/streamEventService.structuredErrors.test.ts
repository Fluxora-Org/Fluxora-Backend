/**
 * Tests for structured error logging in streamEventService catch blocks.
 *
 * Verifies that every catch block emits:
 *   - event: 'stream_event_processing_failed'
 *   - eventType: matching the handler's event type
 *   - contractId: from the event payload
 *   - streamId: where available (NOT for StreamCreated before derivation)
 *
 * Security: asserts that Stellar sender/recipient addresses never appear
 * in error log output (PII policy, src/pii/policy.ts).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { streamEventService, STREAM_EVENT_PROCESSING_FAILED } from '../../src/services/streamEventService.js';

// ---------------------------------------------------------------------------
// Module mocks – must be hoisted before any imports that transitively load them
// ---------------------------------------------------------------------------
vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    upsertStream: vi.fn(),
    getById: vi.fn(),
    updateStream: vi.fn(),
  },
}));

vi.mock('../../src/ws/hub.js', () => ({
  getStreamHub: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/tracing/hooks.js', () => ({
  enrichActiveSpanWithStream: vi.fn(),
}));

vi.mock('../../src/streams/sseEmitter.js', () => ({
  deriveStreamId: vi.fn().mockReturnValue('derived-stream-id'),
}));

// ---------------------------------------------------------------------------
// Re-import mocked modules so we can control their behaviour per test
// ---------------------------------------------------------------------------
import { streamRepository } from '../../src/db/repositories/streamRepository.js';
import * as logger from '../../src/utils/logger.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SENDER = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGFDUUHEQQDAKHOCG4FXNUU';
const RECIPIENT = 'GBJCHHHNT6GZRDWJNF23VKSCJQZL23LJVSXQGKFGQ2I6XSKMWRJ66JX';

const baseCreatedEvent = {
  type: 'StreamCreated' as const,
  contractId: 'CCONTRACT123',
  transactionHash: 'txhash-abc',
  eventIndex: 0,
  sender: SENDER,
  recipient: RECIPIENT,
  amount: '1000',
  ratePerSecond: '10',
  startTime: 1000,
  endTime: 2000,
};

const baseUpdatedEvent = {
  type: 'StreamUpdated' as const,
  contractId: 'CCONTRACT123',
  transactionHash: 'txhash-def',
  eventIndex: 1,
  streamId: 'stream-xyz',
  streamedAmount: '100',
};

const baseCancelledEvent = {
  type: 'StreamCancelled' as const,
  contractId: 'CCONTRACT123',
  transactionHash: 'txhash-ghi',
  eventIndex: 2,
  streamId: 'stream-xyz',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('streamEventService – structured catch-block logging', () => {
  let logErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logErrorSpy = vi.spyOn(logger, 'error');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // processStreamCreated
  // -------------------------------------------------------------------------
  describe('processStreamCreated catch block', () => {
    it('emits event code and eventType when upsertStream throws', async () => {
      vi.mocked(streamRepository.upsertStream).mockRejectedValueOnce(
        new Error('DB connection lost'),
      );

      const result = await streamEventService.processStreamCreated(baseCreatedEvent, 'corr-1');

      expect(result.success).toBe(false);
      expect(logErrorSpy).toHaveBeenCalledOnce();

      const [, context] = logErrorSpy.mock.calls[0];
      expect(context).toMatchObject({
        event: STREAM_EVENT_PROCESSING_FAILED,
        eventType: 'StreamCreated',
        contractId: 'CCONTRACT123',
        correlationId: 'corr-1',
      });
    });

    it('does NOT include sender or recipient in error log (PII policy)', async () => {
      vi.mocked(streamRepository.upsertStream).mockRejectedValueOnce(
        new Error('oops'),
      );

      await streamEventService.processStreamCreated(baseCreatedEvent);

      const [, context] = logErrorSpy.mock.calls[0];
      const logString = JSON.stringify(context);
      expect(logString).not.toContain(SENDER);
      expect(logString).not.toContain(RECIPIENT);
    });

    it('does NOT include streamId in error log for StreamCreated (not yet derived)', async () => {
      vi.mocked(streamRepository.upsertStream).mockRejectedValueOnce(
        new Error('oops'),
      );

      await streamEventService.processStreamCreated(baseCreatedEvent);

      const [, context] = logErrorSpy.mock.calls[0];
      expect((context as Record<string, unknown>)['streamId']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // processStreamUpdated
  // -------------------------------------------------------------------------
  describe('processStreamUpdated catch block', () => {
    it('emits event code, eventType, contractId and streamId when getById throws', async () => {
      vi.mocked(streamRepository.getById).mockRejectedValueOnce(
        new Error('timeout'),
      );

      const result = await streamEventService.processStreamUpdated(baseUpdatedEvent, 'corr-2');

      expect(result.success).toBe(false);
      expect(logErrorSpy).toHaveBeenCalledOnce();

      const [, context] = logErrorSpy.mock.calls[0];
      expect(context).toMatchObject({
        event: STREAM_EVENT_PROCESSING_FAILED,
        eventType: 'StreamUpdated',
        contractId: 'CCONTRACT123',
        streamId: 'stream-xyz',
        correlationId: 'corr-2',
      });
    });

    it('does NOT include sender or recipient in error log (PII policy)', async () => {
      vi.mocked(streamRepository.getById).mockRejectedValueOnce(new Error('oops'));

      await streamEventService.processStreamUpdated(baseUpdatedEvent);

      const [, context] = logErrorSpy.mock.calls[0];
      const logString = JSON.stringify(context);
      expect(logString).not.toContain(SENDER);
      expect(logString).not.toContain(RECIPIENT);
    });
  });

  // -------------------------------------------------------------------------
  // processStreamCancelled
  // -------------------------------------------------------------------------
  describe('processStreamCancelled catch block', () => {
    it('emits event code, eventType, contractId and streamId when updateStream throws', async () => {
      vi.mocked(streamRepository.updateStream).mockRejectedValueOnce(
        new Error('write failed'),
      );

      const result = await streamEventService.processStreamCancelled(baseCancelledEvent, 'corr-3');

      expect(result.success).toBe(false);
      expect(logErrorSpy).toHaveBeenCalledOnce();

      const [, context] = logErrorSpy.mock.calls[0];
      expect(context).toMatchObject({
        event: STREAM_EVENT_PROCESSING_FAILED,
        eventType: 'StreamCancelled',
        contractId: 'CCONTRACT123',
        streamId: 'stream-xyz',
        correlationId: 'corr-3',
      });
    });

    it('does NOT include sender or recipient in error log (PII policy)', async () => {
      vi.mocked(streamRepository.updateStream).mockRejectedValueOnce(new Error('oops'));

      await streamEventService.processStreamCancelled(baseCancelledEvent);

      const [, context] = logErrorSpy.mock.calls[0];
      const logString = JSON.stringify(context);
      expect(logString).not.toContain(SENDER);
      expect(logString).not.toContain(RECIPIENT);
    });
  });

  // -------------------------------------------------------------------------
  // STREAM_EVENT_PROCESSING_FAILED constant
  // -------------------------------------------------------------------------
  describe('STREAM_EVENT_PROCESSING_FAILED constant', () => {
    it('has the expected stable string value', () => {
      expect(STREAM_EVENT_PROCESSING_FAILED).toBe('stream_event_processing_failed');
    });
  });
});
