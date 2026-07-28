import { describe, it, expect, beforeEach } from 'vitest';
import {
  sseLiveSubscribersGauge,
  sseEventListenersGauge,
  deRegisterBusinessMetrics,
} from '../../src/metrics/businessMetrics.js';
import {
  subscribeToSseStream,
  _resetSseSubscriptionsForTest,
  SSE_STREAM_UPDATE_EVENT,
  sseEventBus,
} from '../../src/streams/sseEmitter.js';

async function gaugeValue(gauge: { get: () => Promise<{ values: Array<{ value: number }> }> }): Promise<number> {
  const snap = await gauge.get();
  return snap.values[0]?.value ?? 0;
}

beforeEach(() => {
  _resetSseSubscriptionsForTest();
});

describe('SSE gauge metrics', () => {
  describe('sseLiveSubscribersGauge', () => {
    it('is 0 before any subscription', async () => {
      expect(await gaugeValue(sseLiveSubscribersGauge)).toBe(0);
    });

    it('increments to 1 after one subscribe', async () => {
      subscribeToSseStream('stream-a', () => {});
      expect(await gaugeValue(sseLiveSubscribersGauge)).toBe(1);
    });

    it('increments per subscriber across streams', async () => {
      subscribeToSseStream('stream-a', () => {});
      subscribeToSseStream('stream-a', () => {});
      subscribeToSseStream('stream-b', () => {});
      expect(await gaugeValue(sseLiveSubscribersGauge)).toBe(3);
    });

    it('decrements back to 0 after unsubscribe', async () => {
      const unsub = subscribeToSseStream('stream-a', () => {});
      expect(await gaugeValue(sseLiveSubscribersGauge)).toBe(1);
      unsub();
      expect(await gaugeValue(sseLiveSubscribersGauge)).toBe(0);
    });

    it('decrements correctly when only some subscribers disconnect', async () => {
      const unsub1 = subscribeToSseStream('stream-a', () => {});
      subscribeToSseStream('stream-a', () => {});
      expect(await gaugeValue(sseLiveSubscribersGauge)).toBe(2);
      unsub1();
      expect(await gaugeValue(sseLiveSubscribersGauge)).toBe(1);
    });

    it('is idempotent: calling unsubscribe twice does not double-decrement', async () => {
      const unsub = subscribeToSseStream('stream-a', () => {});
      unsub();
      unsub(); // second call is a no-op
      expect(await gaugeValue(sseLiveSubscribersGauge)).toBe(0);
    });
  });

  describe('sseEventListenersGauge', () => {
    it('is 0 before any subscription', async () => {
      expect(await gaugeValue(sseEventListenersGauge)).toBe(0);
    });

    it('becomes 1 when dispatcher is attached on first subscribe', async () => {
      subscribeToSseStream('stream-a', () => {});
      expect(await gaugeValue(sseEventListenersGauge)).toBe(1);
      // Confirm it matches the actual EventEmitter count
      expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(1);
    });

    it('stays at 1 with multiple subscribers (single shared dispatcher)', async () => {
      subscribeToSseStream('stream-a', () => {});
      subscribeToSseStream('stream-b', () => {});
      subscribeToSseStream('stream-b', () => {});
      expect(await gaugeValue(sseEventListenersGauge)).toBe(1);
    });

    it('drops to 0 when last subscriber disconnects', async () => {
      const unsub1 = subscribeToSseStream('stream-a', () => {});
      const unsub2 = subscribeToSseStream('stream-b', () => {});
      unsub1();
      expect(await gaugeValue(sseEventListenersGauge)).toBe(1); // dispatcher still needed
      unsub2();
      expect(await gaugeValue(sseEventListenersGauge)).toBe(0);
    });
  });

  describe('deRegisterBusinessMetrics removes SSE gauges', () => {
    it('removes both SSE gauges from the registry', async () => {
      // Confirm they exist first
      expect(await gaugeValue(sseLiveSubscribersGauge)).toBeDefined();
      deRegisterBusinessMetrics();
      // After de-registration the metrics.ts registry no longer holds them
      const { registry } = await import('../../src/metrics.js');
      expect(registry.getSingleMetric('fluxora_sse_live_subscribers')).toBeUndefined();
      expect(registry.getSingleMetric('fluxora_sse_event_listeners')).toBeUndefined();
    });
  });
});
