import { MetricsSnapshot, CircuitState } from './types.js';

/**
 * MetricsCollector tracks request metrics including counters and latency histogram
 */
export class MetricsCollector {
  private totalRequests: number = 0;
  private successfulRequests: number = 0;
  private failedRequests: Map<string, number> = new Map();
  private retryAttempts: number = 0;
  private latencies: number[] = [];

  /**
   * Record that a request was initiated
   */
  recordRequest(): void {
    this.totalRequests++;
  }

  /**
   * Record a successful request with its latency
   * @param latency - Request latency in milliseconds
   */
  recordSuccess(latency: number): void {
    this.successfulRequests++;
    this.latencies.push(latency);
  }

  /**
   * Record a failed request with its error type and latency
   * @param errorType - Type of error that occurred
   * @param latency - Request latency in milliseconds
   */
  recordFailure(errorType: string, latency: number): void {
    const currentCount = this.failedRequests.get(errorType) || 0;
    this.failedRequests.set(errorType, currentCount + 1);
    this.latencies.push(latency);
  }

  /**
   * Record a retry attempt
   */
  recordRetry(): void {
    this.retryAttempts++;
  }

  /**
   * Get a snapshot of current metrics
   * @param circuitBreakerState - Current circuit breaker state
   * @param consecutiveFailures - Current consecutive failure count
   * @returns MetricsSnapshot with all current metrics
   */
  getSnapshot(circuitBreakerState: CircuitState, consecutiveFailures: number): MetricsSnapshot {
    return {
      totalRequests: this.totalRequests,
      successfulRequests: this.successfulRequests,
      failedRequests: this.convertFailedRequestsToRecord(),
      retryAttempts: this.retryAttempts,
      circuitBreakerState,
      consecutiveFailures,
      latencyHistogram: this.calculateLatencyHistogram(),
    };
  }

  /**
   * Reset all metrics counters and histogram
   */
  reset(): void {
    this.totalRequests = 0;
    this.successfulRequests = 0;
    this.failedRequests.clear();
    this.retryAttempts = 0;
    this.latencies = [];
  }

  /**
   * Convert failed requests Map to Record for snapshot
   */
  private convertFailedRequestsToRecord(): Record<string, number> {
    const record: Record<string, number> = {};
    this.failedRequests.forEach((count, errorType) => {
      record[errorType] = count;
    });
    return record;
  }

  /**
   * Calculate latency histogram percentiles
   */
  private calculateLatencyHistogram(): {
    p50: number;
    p95: number;
    p99: number;
    max: number;
  } {
    if (this.latencies.length === 0) {
      return { p50: 0, p95: 0, p99: 0, max: 0 };
    }

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const len = sorted.length;

    return {
      p50: this.getPercentile(sorted, 0.5),
      p95: this.getPercentile(sorted, 0.95),
      p99: this.getPercentile(sorted, 0.99),
      max: sorted[len - 1],
    };
  }

  /**
   * Get percentile value from sorted array
   * @param sorted - Sorted array of latencies
   * @param percentile - Percentile to calculate (0-1)
   */
  private getPercentile(sorted: number[], percentile: number): number {
    const index = Math.ceil(sorted.length * percentile) - 1;
    return sorted[Math.max(0, index)];
  }
}
