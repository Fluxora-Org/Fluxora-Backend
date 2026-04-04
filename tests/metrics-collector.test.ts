import { MetricsCollector } from '../src/stellar/metrics-collector';
import { CircuitState } from '../src/stellar/types';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  describe('recordRequest', () => {
    it('should increment total requests counter', () => {
      collector.recordRequest();
      collector.recordRequest();
      collector.recordRequest();

      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);
      expect(snapshot.totalRequests).toBe(3);
    });
  });

  describe('recordSuccess', () => {
    it('should increment successful requests counter', () => {
      collector.recordSuccess(100);
      collector.recordSuccess(200);

      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);
      expect(snapshot.successfulRequests).toBe(2);
    });

    it('should record latency for histogram', () => {
      collector.recordSuccess(100);

      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);
      expect(snapshot.latencyHistogram.max).toBe(100);
    });
  });

  describe('recordFailure', () => {
    it('should increment failed requests counter by error type', () => {
      collector.recordFailure('TIMEOUT', 1000);
      collector.recordFailure('TIMEOUT', 1500);
      collector.recordFailure('NETWORK_ERROR', 2000);

      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);
      expect(snapshot.failedRequests['TIMEOUT']).toBe(2);
      expect(snapshot.failedRequests['NETWORK_ERROR']).toBe(1);
    });

    it('should record latency for failed requests', () => {
      collector.recordFailure('TIMEOUT', 1000);

      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);
      expect(snapshot.latencyHistogram.max).toBe(1000);
    });
  });

  describe('recordRetry', () => {
    it('should increment retry attempts counter', () => {
      collector.recordRetry();
      collector.recordRetry();
      collector.recordRetry();

      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);
      expect(snapshot.retryAttempts).toBe(3);
    });
  });

  describe('getSnapshot', () => {
    it('should return snapshot with all counters', () => {
      collector.recordRequest();
      collector.recordRequest();
      collector.recordSuccess(100);
      collector.recordFailure('TIMEOUT', 200);
      collector.recordRetry();

      const snapshot = collector.getSnapshot(CircuitState.OPEN, 5);

      expect(snapshot.totalRequests).toBe(2);
      expect(snapshot.successfulRequests).toBe(1);
      expect(snapshot.failedRequests['TIMEOUT']).toBe(1);
      expect(snapshot.retryAttempts).toBe(1);
      expect(snapshot.circuitBreakerState).toBe(CircuitState.OPEN);
      expect(snapshot.consecutiveFailures).toBe(5);
    });

    it('should include circuit breaker state in snapshot', () => {
      const snapshot = collector.getSnapshot(CircuitState.HALF_OPEN, 3);

      expect(snapshot.circuitBreakerState).toBe(CircuitState.HALF_OPEN);
      expect(snapshot.consecutiveFailures).toBe(3);
    });

    it('should return empty failed requests when no failures recorded', () => {
      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);

      expect(snapshot.failedRequests).toEqual({});
    });
  });

  describe('latency histogram', () => {
    it('should calculate p50, p95, p99, and max percentiles', () => {
      // Record 100 latencies from 1 to 100
      for (let i = 1; i <= 100; i++) {
        collector.recordSuccess(i);
      }

      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);

      expect(snapshot.latencyHistogram.p50).toBe(50);
      expect(snapshot.latencyHistogram.p95).toBe(95);
      expect(snapshot.latencyHistogram.p99).toBe(99);
      expect(snapshot.latencyHistogram.max).toBe(100);
    });

    it('should return zeros for empty latency data', () => {
      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);

      expect(snapshot.latencyHistogram.p50).toBe(0);
      expect(snapshot.latencyHistogram.p95).toBe(0);
      expect(snapshot.latencyHistogram.p99).toBe(0);
      expect(snapshot.latencyHistogram.max).toBe(0);
    });

    it('should handle single latency value', () => {
      collector.recordSuccess(42);

      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);

      expect(snapshot.latencyHistogram.p50).toBe(42);
      expect(snapshot.latencyHistogram.p95).toBe(42);
      expect(snapshot.latencyHistogram.p99).toBe(42);
      expect(snapshot.latencyHistogram.max).toBe(42);
    });

    it('should include latencies from both successes and failures', () => {
      collector.recordSuccess(100);
      collector.recordSuccess(200);
      collector.recordFailure('TIMEOUT', 300);
      collector.recordFailure('ERROR', 400);

      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);

      expect(snapshot.latencyHistogram.max).toBe(400);
      expect(snapshot.latencyHistogram.p50).toBe(200);
    });
  });

  describe('reset', () => {
    it('should clear all counters', () => {
      collector.recordRequest();
      collector.recordSuccess(100);
      collector.recordFailure('TIMEOUT', 200);
      collector.recordRetry();

      collector.reset();

      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);

      expect(snapshot.totalRequests).toBe(0);
      expect(snapshot.successfulRequests).toBe(0);
      expect(snapshot.failedRequests).toEqual({});
      expect(snapshot.retryAttempts).toBe(0);
    });

    it('should clear latency histogram', () => {
      collector.recordSuccess(100);
      collector.recordSuccess(200);

      collector.reset();

      const snapshot = collector.getSnapshot(CircuitState.CLOSED, 0);

      expect(snapshot.latencyHistogram.p50).toBe(0);
      expect(snapshot.latencyHistogram.p95).toBe(0);
      expect(snapshot.latencyHistogram.p99).toBe(0);
      expect(snapshot.latencyHistogram.max).toBe(0);
    });
  });
});
