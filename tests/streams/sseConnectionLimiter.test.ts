import { sseActiveConnectionsGauge, sseConnectionsRejectedTotal } from '../../src/metrics/businessMetrics.js';
import {
  DEFAULT_SSE_MAX_CONNECTIONS_PER_IP,
  DEFAULT_SSE_MAX_GLOBAL_CONNECTIONS,
  DEFAULT_SSE_MAX_CONNECTION_DURATION_MS,
  DEFAULT_SSE_RETRY_AFTER_SECONDS,
  _resetSseConnectionLimiter,
  getActiveSseConnectionCount,
  getActiveSseConnectionCountForIp,
  resolveSseConnectionLimits,
  tryAcquireSseConnection,
  type SseConnectionLimits,
} from '../../src/streams/sseConnectionLimiter.js';

const TEST_LIMITS: SseConnectionLimits = {
  maxConnectionsPerIp: 2,
  maxGlobalConnections: 3,
  maxConnectionDurationMs: 1000,
  retryAfterSeconds: 5,
};

async function getActiveGaugeValue(): Promise<number> {
  const snapshot = await sseActiveConnectionsGauge.get();
  return snapshot.values[0]?.value ?? 0;
}

describe('sseConnectionLimiter', () => {
  beforeEach(() => {
    _resetSseConnectionLimiter();
    sseConnectionsRejectedTotal.reset();
  });

  afterEach(() => {
    _resetSseConnectionLimiter();
    sseConnectionsRejectedTotal.reset();
  });

  it('resolves configured limits and falls back on invalid values', () => {
    expect(resolveSseConnectionLimits({
      SSE_MAX_CONNECTIONS_PER_IP: '4',
      SSE_MAX_GLOBAL_CONNECTIONS: '40',
      SSE_MAX_CONNECTION_DURATION_MS: '2500',
      SSE_RETRY_AFTER_SECONDS: '9',
    } as NodeJS.ProcessEnv)).toEqual({
      maxConnectionsPerIp: 4,
      maxGlobalConnections: 40,
      maxConnectionDurationMs: 2500,
      retryAfterSeconds: 9,
    });

    expect(resolveSseConnectionLimits({
      SSE_MAX_CONNECTIONS_PER_IP: '0',
      SSE_MAX_GLOBAL_CONNECTIONS: '100001',
      SSE_MAX_CONNECTION_DURATION_MS: 'not-a-number',
      SSE_RETRY_AFTER_SECONDS: '-1',
    } as NodeJS.ProcessEnv)).toEqual({
      maxConnectionsPerIp: DEFAULT_SSE_MAX_CONNECTIONS_PER_IP,
      maxGlobalConnections: DEFAULT_SSE_MAX_GLOBAL_CONNECTIONS,
      maxConnectionDurationMs: DEFAULT_SSE_MAX_CONNECTION_DURATION_MS,
      retryAfterSeconds: DEFAULT_SSE_RETRY_AFTER_SECONDS,
    });
  });

  it('tracks active connections by normalized IP and releases exactly once', async () => {
    const attempt = tryAcquireSseConnection(' 127.0.0.1 ', TEST_LIMITS);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) throw new Error('expected SSE connection to be accepted');

    expect(attempt.connection.ip).toBe('127.0.0.1');
    expect(getActiveSseConnectionCount()).toBe(1);
    expect(getActiveSseConnectionCountForIp('127.0.0.1')).toBe(1);
    expect(await getActiveGaugeValue()).toBe(1);

    attempt.connection.release();
    attempt.connection.release();

    expect(getActiveSseConnectionCount()).toBe(0);
    expect(getActiveSseConnectionCountForIp('127.0.0.1')).toBe(0);
    expect(await getActiveGaugeValue()).toBe(0);
  });

  it('rejects connections over the per-IP limit without incrementing counters', async () => {
    const first = tryAcquireSseConnection('203.0.113.9', TEST_LIMITS);
    const second = tryAcquireSseConnection('203.0.113.9', TEST_LIMITS);
    const third = tryAcquireSseConnection('203.0.113.9', TEST_LIMITS);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (third.ok) throw new Error('expected third SSE connection to be rejected');

    expect(third.reason).toBe('per_ip_limit');
    expect(third.retryAfterSeconds).toBe(TEST_LIMITS.retryAfterSeconds);
    expect(getActiveSseConnectionCount()).toBe(2);
    expect(getActiveSseConnectionCountForIp('203.0.113.9')).toBe(2);

    // Verify rejection metric increments
    const rejectedVal = await sseConnectionsRejectedTotal.get();
    expect(rejectedVal.values).toHaveLength(1);
    expect(rejectedVal.values[0]?.labels).toEqual({ reason: 'per_ip_limit' });
    expect(rejectedVal.values[0]?.value).toBe(1);
  });

  it('rejects connections over the global limit without incrementing counters', async () => {
    const limits: SseConnectionLimits = {
      ...TEST_LIMITS,
      maxConnectionsPerIp: 10,
      maxGlobalConnections: 2,
    };

    const first = tryAcquireSseConnection('203.0.113.1', limits);
    const second = tryAcquireSseConnection('203.0.113.2', limits);
    const third = tryAcquireSseConnection('203.0.113.3', limits);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (third.ok) throw new Error('expected third SSE connection to be rejected');

    expect(third.reason).toBe('global_limit');
    expect(third.retryAfterSeconds).toBe(limits.retryAfterSeconds);
    expect(getActiveSseConnectionCount()).toBe(2);
    expect(getActiveSseConnectionCountForIp('203.0.113.3')).toBe(0);

    // Verify rejection metric increments
    const rejectedVal = await sseConnectionsRejectedTotal.get();
    expect(rejectedVal.values).toHaveLength(1);
    expect(rejectedVal.values[0]?.labels).toEqual({ reason: 'global_limit' });
    expect(rejectedVal.values[0]?.value).toBe(1);
  });
});
