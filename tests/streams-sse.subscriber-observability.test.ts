import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  subscribeToSseStream,
  sseEventBus,
  SSE_STREAM_UPDATE_EVENT,
  _resetSseSubscriptionsForTest,
  type LiveSseStreamUpdateEvent,
} from '../src/streams/sseEmitter.js';
import {
  sseSubscriberErrorsTotal,
  deRegisterBusinessMetrics,
} from '../src/metrics/businessMetrics.js';
import { logger } from '../src/lib/logger.js';

describe('SSE subscriber error observability', () => {
  beforeEach(() => {
    _resetSseSubscriptionsForTest();
    sseSubscriberErrorsTotal.reset();
  });

  afterEach(() => {
    _resetSseSubscriptionsForTest();
    deRegisterBusinessMetrics();
    vi.restoreAllMocks();
  });

  it('increments error metric, emits structured log without payload, and isolates healthy subscriber when a callback throws', async () => {
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const streamId = 'stream-test-123';
    const correlationId = 'corr-xyz-456';
    const secretPayload = { sensitiveToken: 'SECRET_DO_NOT_LOG_999' };

    let healthyReceived = false;

    // Subscriber 1: throws an error
    subscribeToSseStream(streamId, () => {
      throw new Error('Subscriber error simulated');
    });

    // Subscriber 2: healthy
    subscribeToSseStream(streamId, (event) => {
      if (event.streamId === streamId) {
        healthyReceived = true;
      }
    });

    const event: LiveSseStreamUpdateEvent = {
      streamId,
      eventId: 'evt-001',
      payload: secretPayload,
      correlationId,
    };

    // Emit event on bus
    sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, event);

    // 1. Assert healthy subscriber still ran
    expect(healthyReceived).toBe(true);

    // 2. Assert metric counter incremented for subscriber_callback_throw
    const metricValue = await sseSubscriberErrorsTotal.get();
    expect(metricValue.values[0]?.value).toBe(1);
    expect(metricValue.values[0]?.labels).toEqual({ reason: 'subscriber_callback_throw' });

    // 3. Assert structured logger.error was called
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'SSE subscriber callback threw',
      correlationId,
      expect.objectContaining({
        streamId,
        subscriberError: {
          name: 'Error',
          message: 'Subscriber error simulated',
        },
      })
    );

    // 4. Assert payload is NOT logged anywhere in logger.error arguments
    const logCallArgsStr = JSON.stringify(loggerErrorSpy.mock.calls);
    expect(logCallArgsStr).not.toContain('SECRET_DO_NOT_LOG_999');
    expect(logCallArgsStr).not.toContain('sensitiveToken');
  });
});