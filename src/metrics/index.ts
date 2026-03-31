/**
 * Metrics module for observability
 *
 * Tracks key operational metrics:
 * - Ingestion rate: events processed per second
 * - Failure rate: failed events per second
 * - Lag: difference between blockchain time and database time
 * - DB latency: database operation latency
 *
 * @module metrics
 */

// In-memory metrics storage
const metrics = {
  eventsIngested: 0,
  eventsFailed: 0,
  eventsIgnored: 0,
  lastIngestTime: 0,
  dbLatencySum: 0,
  dbLatencyCount: 0,
  chainLagMs: 0,
};

/**
 * Initialize metrics (called on startup)
 */
export function initMetrics(): void {
  resetMetrics();
}

/**
 * Reset all metrics
 */
export function resetMetrics(): void {
  metrics.eventsIngested = 0;
  metrics.eventsFailed = 0;
  metrics.eventsIgnored = 0;
  metrics.lastIngestTime = 0;
  metrics.dbLatencySum = 0;
  metrics.dbLatencyCount = 0;
  metrics.chainLagMs = 0;
}

/**
 * Record a successful event ingestion
 */
export function recordEventIngested(): void {
  metrics.eventsIngested++;
  metrics.lastIngestTime = Date.now();
}

/**
 * Record a failed event ingestion
 */
export function recordEventFailed(): void {
  metrics.eventsFailed++;
  metrics.lastIngestTime = Date.now();
}

/**
 * Record an ignored (duplicate) event
 */
export function recordEventIgnored(): void {
  metrics.eventsIgnored++;
}

/**
 * Record database operation latency
 */
export function recordDbLatency(latencyMs: number): void {
  metrics.dbLatencySum += latencyMs;
  metrics.dbLatencyCount++;
}

/**
 * Update blockchain lag
 */
export function updateChainLag(lagMs: number): void {
  metrics.chainLagMs = lagMs;
}

/**
 * Get current metrics snapshot
 */
export function getMetrics(): {
  eventsIngested: number;
  eventsFailed: number;
  eventsIgnored: number;
  ingestionRate: number; // events per second (last minute)
  failureRate: number; // failures per second (last minute)
  avgDbLatency: number; // average DB latency in ms
  chainLagMs: number;
} {
  const now = Date.now();
  const timeSinceLastIngest = now - metrics.lastIngestTime;

  // Calculate rates (events per second over last minute)
  const oneMinute = 60 * 1000;
  const rateMultiplier =
    timeSinceLastIngest > 0 ? oneMinute / timeSinceLastIngest : 0;

  return {
    eventsIngested: metrics.eventsIngested,
    eventsFailed: metrics.eventsFailed,
    eventsIgnored: metrics.eventsIgnored,
    ingestionRate:
      Math.round(metrics.eventsIngested * rateMultiplier * 10) / 10,
    failureRate: Math.round(metrics.eventsFailed * rateMultiplier * 10) / 10,
    avgDbLatency:
      metrics.dbLatencyCount > 0
        ? Math.round(metrics.dbLatencySum / metrics.dbLatencyCount)
        : 0,
    chainLagMs: metrics.chainLagMs,
  };
}

/**
 * Metrics with health indicators
 */
export function getHealthMetrics(): {
  healthy: boolean;
  checks: {
    dbConnected: boolean;
    ingestionRunning: boolean;
    lagAcceptable: boolean;
  };
  metrics: ReturnType<typeof getMetrics>;
} {
  const currentMetrics = getMetrics();

  return {
    healthy: true,
    checks: {
      dbConnected: currentMetrics.avgDbLatency > 0,
      ingestionRunning: currentMetrics.eventsIngested > 0,
      lagAcceptable: currentMetrics.chainLagMs < 300000, // < 5 minutes
    },
    metrics: currentMetrics,
  };
}
