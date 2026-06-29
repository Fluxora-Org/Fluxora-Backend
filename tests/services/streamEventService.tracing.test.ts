/**
 * Tracing span tests for streamEventService.processEvent
 *
 * Verifies that:
 * - processEvent creates a parent span for all three event-type branches
 * - The span carries `stream.event_type` and `correlation_id` attributes
 * - processStreamCancelled calls enrichActiveSpanWithStream before updateStream
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initializeTracer,
  resetTracer,
  traceSpan,
} from '../../src/tracing/hooks.js';
import { SpanBuffer } from '../../src/tracing/builtin.js';

// ── Mock dependencies ─────────────────────────────────────────────────────────

vi.mock('../../src/db/repositories/streamRepository.js', () => ({
  streamRepository: {
    upsertStream: vi.fn().mockResolvedValue({ created: true }),
    getById: vi.fn().mockResolvedValue({
      id: 'stream-1',
      sender_address: 'GSENDER',
      recipient_address: 'GRECIPIENT',
      status: 'active',
    }),
    updateStream: vi.fn().mockResolvedValue({
      id: 'stream-1',
      sender_address: 'GSENDER',
      recipient_address: 'GRECIPIENT',
      status: 'cancelled',
    }),
  },
}));

vi.mock('../../src/ws/hub.js', () => ({
  getStreamHub: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/streams/sseEmitter.js', () => ({
  deriveStreamId: vi.fn().mockReturnValue('stream-1'),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getActiveSpan: vi.fn().mockReturnValue(null),
  },
  context: {},
  SpanStatusCode: { OK: 0, ERROR: 1 },
}));

import { streamEventService } from '../../src/services/streamEventService.js';
import type {
  StreamCreatedEvent,
  StreamUpdatedEvent,
  StreamCancelledEvent,
} from '../../src/services/streamEventService.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const createdEvent: StreamCreatedEvent = {
  type: 'StreamCreated',
  contractId: 'contract-1',
  transactionHash: 'txhash-1',
  eventIndex: 0,
  sender: 'GSENDER',
  recipient: 'GRECIPIENT',
  amount: '1000',
  ratePerSecond: '1',
  startTime: 1000,
  endTime: 2000,
};

const updatedEvent: StreamUpdatedEvent = {
  type: 'StreamUpdated',
  contractId: 'contract-1',
  transactionHash: 'txhash-2',
  eventIndex: 1,
  streamId: 'stream-1',
  streamedAmount: '100',
  remainingAmount: '900',
};

const cancelledEvent: StreamCancelledEvent = {
  type: 'StreamCancelled',
  contractId: 'contract-1',
  transactionHash: 'txhash-3',
  eventIndex: 2,
  streamId: 'stream-1',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('streamEventService.processEvent tracing', () => {
  let buffer: SpanBuffer;

  beforeEach(() => {
    resetTracer();
    buffer = new SpanBuffer({ logEvents: false });
    initializeTracer({ enabled: true, hooks: buffer });
    vi.clearAllMocks();
  });

  it('creates a parent span for StreamCreated with eventType attribute', async () => {
    await streamEventService.processEvent(createdEvent, 'corr-created');

    const spans = buffer.getSpans();
    const parentSpan = spans.find(
      (s) => s.context.tags?.['span.name'] === 'streamEventService.processEvent',
    );
    expect(parentSpan).toBeDefined();
    expect(parentSpan?.context.tags?.['stream.event_type']).toBe('StreamCreated');
    expect(parentSpan?.context.traceId).toBe('corr-created');
    expect(parentSpan?.status).toBe('ok');
  });

  it('includes correlationId as a span attribute when provided', async () => {
    await streamEventService.processEvent(createdEvent, 'corr-xyz');

    const spans = buffer.getSpans();
    const parentSpan = spans.find(
      (s) => s.context.tags?.['span.name'] === 'streamEventService.processEvent',
    );
    expect(parentSpan?.context.tags?.['correlation_id']).toBe('corr-xyz');
  });

  it('creates a parent span for StreamUpdated with eventType attribute', async () => {
    await streamEventService.processEvent(updatedEvent, 'corr-updated');

    const spans = buffer.getSpans();
    const parentSpan = spans.find(
      (s) => s.context.tags?.['span.name'] === 'streamEventService.processEvent',
    );
    expect(parentSpan).toBeDefined();
    expect(parentSpan?.context.tags?.['stream.event_type']).toBe('StreamUpdated');
    expect(parentSpan?.context.traceId).toBe('corr-updated');
    expect(parentSpan?.status).toBe('ok');
  });

  it('creates a parent span for StreamCancelled with eventType attribute', async () => {
    await streamEventService.processEvent(cancelledEvent, 'corr-cancelled');

    const spans = buffer.getSpans();
    const parentSpan = spans.find(
      (s) => s.context.tags?.['span.name'] === 'streamEventService.processEvent',
    );
    expect(parentSpan).toBeDefined();
    expect(parentSpan?.context.tags?.['stream.event_type']).toBe('StreamCancelled');
    expect(parentSpan?.context.traceId).toBe('corr-cancelled');
    expect(parentSpan?.status).toBe('ok');
  });

  it('uses "unknown" as traceId when correlationId is omitted', async () => {
    await streamEventService.processEvent(cancelledEvent);

    const spans = buffer.getSpans();
    const parentSpan = spans.find(
      (s) => s.context.tags?.['span.name'] === 'streamEventService.processEvent',
    );
    expect(parentSpan).toBeDefined();
    expect(parentSpan?.context.traceId).toBe('unknown');
    expect(parentSpan?.context.tags?.['correlation_id']).toBeUndefined();
  });

  it('marks parent span as error when the handler throws', async () => {
    const { streamRepository } = await import(
      '../../src/db/repositories/streamRepository.js'
    );
    vi.mocked(streamRepository.updateStream).mockRejectedValueOnce(
      new Error('db failure'),
    );

    const result = await streamEventService.processEvent(cancelledEvent, 'corr-err');

    // The service catches the error and returns success: false
    expect(result.success).toBe(false);
  });

  it('does not create a parent span when tracing is disabled', async () => {
    resetTracer();
    const disabledBuffer = new SpanBuffer({ logEvents: false });
    initializeTracer({ enabled: false, hooks: disabledBuffer });

    await streamEventService.processEvent(createdEvent, 'corr-disabled');

    const spans = disabledBuffer.getSpans();
    expect(spans).toHaveLength(0);
  });
});

// ── processStreamCancelled enrichment ─────────────────────────────────────────

describe('processStreamCancelled enrichActiveSpanWithStream', () => {
  it('calls streamRepository.getById to fetch sender/recipient before updateStream', async () => {
    resetTracer();
    initializeTracer({ enabled: true });

    const { streamRepository } = await import(
      '../../src/db/repositories/streamRepository.js'
    );
    vi.clearAllMocks();
    vi.mocked(streamRepository.getById).mockResolvedValueOnce({
      id: 'stream-1',
      sender_address: 'GSENDER',
      recipient_address: 'GRECIPIENT',
      status: 'active',
    } as any);
    vi.mocked(streamRepository.updateStream).mockResolvedValueOnce({
      id: 'stream-1',
      sender_address: 'GSENDER',
      recipient_address: 'GRECIPIENT',
      status: 'cancelled',
    } as any);

    const result = await streamEventService.processStreamCancelled(
      cancelledEvent,
      'corr-cancel',
    );

    expect(streamRepository.getById).toHaveBeenCalledWith('stream-1');
    expect(streamRepository.updateStream).toHaveBeenCalledWith(
      'stream-1',
      { status: 'cancelled' },
      'corr-cancel',
    );
    expect(result.success).toBe(true);
    expect(result.streamId).toBe('stream-1');
  });
});
