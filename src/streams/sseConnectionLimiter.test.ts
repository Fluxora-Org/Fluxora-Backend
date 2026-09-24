import { describe, it, expect, beforeEach } from 'vitest';
import {
  tryAcquireSseConnection,
  resolveSseConnectionLimits,
  _resetSseConnectionLimiter,
  getActiveSseConnectionCount,
  getActiveSseConnectionCountForIp,
  DEFAULT_SSE_MAX_CONNECTIONS_PER_IP,
  DEFAULT_SSE_MAX_GLOBAL_CONNECTIONS,
  DEFAULT_SSE_MAX_CONNECTIONS_PER_API_KEY,
} from './sseConnectionLimiter.js';
import {
  sseConnectionsRejectedTotal,
  sseActiveConnectionsGauge,
  isValidRejectionReason,
} from '../metrics/businessMetrics.js';

const KEY = 'test-api-key';

// ── helpers ────────────────────────────────────────────────────────────────

async function getRejectedCount(reason: string): Promise<number> {
  const snap = await sseConnectionsRejectedTotal.get();
  const entry = snap.values.find((v) => String(v.labels['reason']) === reason);
  return entry?.value ?? 0;
}

async function getActiveGaugeValue(): Promise<number> {
  const snap = await sseActiveConnectionsGauge.get();
  return snap.values[0]?.value ?? 0;
}

// ── per-API-key cap ────────────────────────────────────────────────────────

describe('tryAcquireSseConnection per-API-key cap', () => {
  beforeEach(() => {
    _resetSseConnectionLimiter();
  });

  it('rejects when the per-API-key cap is reached', () => {
    const limits = resolveSseConnectionLimits();
    // Lower the per-key cap so the test is deterministic.
    const capped = { ...limits, maxConnectionsPerApiKey: 2 };

    const a = tryAcquireSseConnection('1.1.1.1', capped, KEY);
    const b = tryAcquireSseConnection('1.1.1.1', capped, KEY);
    const c = tryAcquireSseConnection('1.1.1.1', capped, KEY);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toBe('per_key_limit');
    }
  });

  it('tracks per-key usage independently of the per-IP cap', () => {
    const capped = {
      ...resolveSseConnectionLimits(),
      maxConnectionsPerApiKey: 1,
      maxConnectionsPerIp: 100,
    };

    const first = tryAcquireSseConnection('9.9.9.9', capped, KEY);
    expect(first.ok).toBe(true);

    // Same key, different IP — still rejected by the per-key dimension.
    const second = tryAcquireSseConnection('8.8.8.8', capped, KEY);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('per_key_limit');
    }
  });

  it('releases per-key capacity so the cap recovers', () => {
    const capped = {
      ...resolveSseConnectionLimits(),
      maxConnectionsPerApiKey: 1,
    };

    const first = tryAcquireSseConnection('1.1.1.1', capped, KEY);
    expect(first.ok).toBe(true);
    if (first.ok) first.connection.release();

    const second = tryAcquireSseConnection('1.1.1.1', capped, KEY);
    expect(second.ok).toBe(true);
  });

  it('does not enforce per-key cap when no API key is supplied', () => {
    const capped = {
      ...resolveSseConnectionLimits(),
      maxConnectionsPerApiKey: 1,
    };

    const a = tryAcquireSseConnection('1.1.1.1', capped);
    const b = tryAcquireSseConnection('1.1.1.1', capped);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('exposes the default per-API-key cap via the resolver', () => {
    expect(DEFAULT_SSE_MAX_CONNECTIONS_PER_API_KEY).toBeGreaterThan(0);
    expect(resolveSseConnectionLimits().maxConnectionsPerApiKey).toBe(
      DEFAULT_SSE_MAX_CONNECTIONS_PER_API_KEY,
    );
  });
});

// ── per-IP limit ───────────────────────────────────────────────────────────

describe('tryAcquireSseConnection per-IP limit', () => {
  beforeEach(() => {
    _resetSseConnectionLimiter();
  });

  it('rejects when the per-IP cap is reached', () => {
    const limits = { ...resolveSseConnectionLimits(), maxConnectionsPerIp: 2, maxGlobalConnections: 1000 };
    const ip = '10.0.0.1';

    const a = tryAcquireSseConnection(ip, limits);
    const b = tryAcquireSseConnection(ip, limits);
    const c = tryAcquireSseConnection(ip, limits);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toBe('per_ip_limit');
    }
  });

  it('returns the documented error message when per-IP limit is exceeded', () => {
    const limits = { ...resolveSseConnectionLimits(), maxConnectionsPerIp: 1, maxGlobalConnections: 1000 };
    const ip = '10.0.0.2';

    tryAcquireSseConnection(ip, limits);
    const rejected = tryAcquireSseConnection(ip, limits);

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.message).toContain('Too many active SSE connections from this IP');
      expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
      expect(typeof rejected.activeConnections).toBe('number');
      expect(typeof rejected.activeConnectionsForIp).toBe('number');
      expect(rejected.limits).toBeDefined();
    }
  });

  it('allows connections from different IPs independently', () => {
    const limits = { ...resolveSseConnectionLimits(), maxConnectionsPerIp: 1, maxGlobalConnections: 1000 };

    const a = tryAcquireSseConnection('192.168.1.1', limits);
    const b = tryAcquireSseConnection('192.168.1.2', limits);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('releases per-IP capacity after connection is released', () => {
    const limits = { ...resolveSseConnectionLimits(), maxConnectionsPerIp: 1, maxGlobalConnections: 1000 };
    const ip = '10.0.0.3';

    const first = tryAcquireSseConnection(ip, limits);
    expect(first.ok).toBe(true);
    if (first.ok) first.connection.release();

    const second = tryAcquireSseConnection(ip, limits);
    expect(second.ok).toBe(true);
  });

  it('getActiveSseConnectionCountForIp tracks per-IP count correctly', () => {
    const limits = { ...resolveSseConnectionLimits(), maxConnectionsPerIp: 10, maxGlobalConnections: 1000 };
    const ip = '10.0.0.5';

    expect(getActiveSseConnectionCountForIp(ip)).toBe(0);

    const a = tryAcquireSseConnection(ip, limits);
    expect(getActiveSseConnectionCountForIp(ip)).toBe(1);

    const b = tryAcquireSseConnection(ip, limits);
    expect(getActiveSseConnectionCountForIp(ip)).toBe(2);

    if (a.ok) a.connection.release();
    expect(getActiveSseConnectionCountForIp(ip)).toBe(1);

    if (b.ok) b.connection.release();
    expect(getActiveSseConnectionCountForIp(ip)).toBe(0);
  });

  it('exposes the default per-IP cap via the resolver', () => {
    expect(DEFAULT_SSE_MAX_CONNECTIONS_PER_IP).toBeGreaterThan(0);
    expect(resolveSseConnectionLimits().maxConnectionsPerIp).toBe(DEFAULT_SSE_MAX_CONNECTIONS_PER_IP);
  });
});

// ── global limit ───────────────────────────────────────────────────────────

describe('tryAcquireSseConnection global limit', () => {
  beforeEach(() => {
    _resetSseConnectionLimiter();
  });

  it('rejects when the global cap is reached', () => {
    const limits = {
      ...resolveSseConnectionLimits(),
      maxConnectionsPerIp: 100,
      maxGlobalConnections: 2,
    };

    const a = tryAcquireSseConnection('1.1.1.1', limits);
    const b = tryAcquireSseConnection('2.2.2.2', limits);
    const c = tryAcquireSseConnection('3.3.3.3', limits);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toBe('global_limit');
    }
  });

  it('returns the documented error message when global limit is exceeded', () => {
    const limits = {
      ...resolveSseConnectionLimits(),
      maxConnectionsPerIp: 100,
      maxGlobalConnections: 1,
    };

    tryAcquireSseConnection('1.1.1.1', limits);
    const rejected = tryAcquireSseConnection('2.2.2.2', limits);

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.message).toContain('Too many active SSE connections');
      expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
      expect(typeof rejected.activeConnections).toBe('number');
      expect(rejected.limits).toBeDefined();
    }
  });

  it('releases global capacity after connection is released', () => {
    const limits = {
      ...resolveSseConnectionLimits(),
      maxConnectionsPerIp: 100,
      maxGlobalConnections: 1,
    };

    const first = tryAcquireSseConnection('1.1.1.1', limits);
    expect(first.ok).toBe(true);
    if (first.ok) first.connection.release();

    const second = tryAcquireSseConnection('2.2.2.2', limits);
    expect(second.ok).toBe(true);
  });

  it('exposes the default global cap via the resolver', () => {
    expect(DEFAULT_SSE_MAX_GLOBAL_CONNECTIONS).toBeGreaterThan(0);
    expect(resolveSseConnectionLimits().maxGlobalConnections).toBe(DEFAULT_SSE_MAX_GLOBAL_CONNECTIONS);
  });
});

// ── global counter & gauge metrics ────────────────────────────────────────

describe('tryAcquireSseConnection metrics', () => {
  beforeEach(() => {
    _resetSseConnectionLimiter();
  });

  it('getActiveSseConnectionCount starts at 0', () => {
    expect(getActiveSseConnectionCount()).toBe(0);
  });

  it('getActiveSseConnectionCount increments on each accepted connection', () => {
    const limits = { ...resolveSseConnectionLimits(), maxConnectionsPerIp: 100, maxGlobalConnections: 1000 };
    tryAcquireSseConnection('1.1.1.1', limits);
    expect(getActiveSseConnectionCount()).toBe(1);
    tryAcquireSseConnection('1.1.1.1', limits);
    expect(getActiveSseConnectionCount()).toBe(2);
  });

  it('getActiveSseConnectionCount decrements when connection is released', () => {
    const limits = { ...resolveSseConnectionLimits(), maxConnectionsPerIp: 100, maxGlobalConnections: 1000 };
    const conn = tryAcquireSseConnection('1.1.1.1', limits);
    expect(getActiveSseConnectionCount()).toBe(1);
    if (conn.ok) conn.connection.release();
    expect(getActiveSseConnectionCount()).toBe(0);
  });

  it('sseActiveConnectionsGauge tracks accepted connections', async () => {
    const limits = { ...resolveSseConnectionLimits(), maxConnectionsPerIp: 100, maxGlobalConnections: 1000 };
    const a = tryAcquireSseConnection('1.1.1.1', limits);
    expect(await getActiveGaugeValue()).toBe(1);
    tryAcquireSseConnection('2.2.2.2', limits);
    expect(await getActiveGaugeValue()).toBe(2);
    if (a.ok) a.connection.release();
    expect(await getActiveGaugeValue()).toBe(1);
  });

  it('sseConnectionsRejectedTotal increments on per_ip_limit rejection', async () => {
    const before = await getRejectedCount('per_ip_limit');
    const limits = { ...resolveSseConnectionLimits(), maxConnectionsPerIp: 1, maxGlobalConnections: 1000 };
    tryAcquireSseConnection('1.1.1.1', limits);
    tryAcquireSseConnection('1.1.1.1', limits); // rejected

    expect(await getRejectedCount('per_ip_limit')).toBe(before + 1);
  });

  it('sseConnectionsRejectedTotal increments on per_key_limit rejection', async () => {
    const before = await getRejectedCount('per_key_limit');
    const limits = { ...resolveSseConnectionLimits(), maxConnectionsPerApiKey: 1, maxConnectionsPerIp: 100, maxGlobalConnections: 1000 };
    tryAcquireSseConnection('1.1.1.1', limits, KEY);
    tryAcquireSseConnection('1.1.1.1', limits, KEY); // rejected

    expect(await getRejectedCount('per_key_limit')).toBe(before + 1);
  });

  it('sseConnectionsRejectedTotal increments on global_limit rejection', async () => {
    const before = await getRejectedCount('global_limit');
    const limits = { ...resolveSseConnectionLimits(), maxConnectionsPerIp: 100, maxGlobalConnections: 1 };
    tryAcquireSseConnection('1.1.1.1', limits);
    tryAcquireSseConnection('2.2.2.2', limits); // rejected

    expect(await getRejectedCount('global_limit')).toBe(before + 1);
  });

  it('isValidRejectionReason covers all three limit reasons', () => {
    expect(isValidRejectionReason('per_ip_limit')).toBe(true);
    expect(isValidRejectionReason('per_key_limit')).toBe(true);
    expect(isValidRejectionReason('global_limit')).toBe(true);
    expect(isValidRejectionReason('unknown_reason')).toBe(false);
  });
});

// ── connection acceptance & properties ────────────────────────────────────

describe('tryAcquireSseConnection accepted connection', () => {
  beforeEach(() => {
    _resetSseConnectionLimiter();
  });

  it('returns ok=true with connection object carrying ip, acceptedAt, and limits', () => {
    const limits = resolveSseConnectionLimits();
    const result = tryAcquireSseConnection('5.5.5.5', limits);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.ip).toBe('5.5.5.5');
      expect(typeof result.connection.acceptedAt).toBe('number');
      expect(result.connection.acceptedAt).toBeGreaterThan(0);
      expect(result.connection.limits).toBe(limits);
      expect(typeof result.connection.release).toBe('function');
    }
  });

  it('release is idempotent — calling it twice does not double-decrement', () => {
    const limits = resolveSseConnectionLimits();
    const result = tryAcquireSseConnection('6.6.6.6', limits);

    expect(getActiveSseConnectionCount()).toBe(1);
    if (result.ok) {
      result.connection.release();
      result.connection.release(); // second call is a no-op
    }
    expect(getActiveSseConnectionCount()).toBe(0);
  });

  it('normalises an empty IP string to "unknown"', () => {
    const limits = resolveSseConnectionLimits();
    const result = tryAcquireSseConnection('', limits);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.ip).toBe('unknown');
    }
  });
});

// ── env-driven resolver ────────────────────────────────────────────────────

describe('resolveSseConnectionLimits', () => {
  it('reads SSE_MAX_CONNECTIONS_PER_IP from the environment', () => {
    const limits = resolveSseConnectionLimits({ SSE_MAX_CONNECTIONS_PER_IP: '7' });
    expect(limits.maxConnectionsPerIp).toBe(7);
  });

  it('reads SSE_MAX_GLOBAL_CONNECTIONS from the environment', () => {
    const limits = resolveSseConnectionLimits({ SSE_MAX_GLOBAL_CONNECTIONS: '42' });
    expect(limits.maxGlobalConnections).toBe(42);
  });

  it('reads SSE_MAX_CONNECTIONS_PER_API_KEY from the environment', () => {
    const limits = resolveSseConnectionLimits({ SSE_MAX_CONNECTIONS_PER_API_KEY: '25' });
    expect(limits.maxConnectionsPerApiKey).toBe(25);
  });

  it('falls back to defaults when env vars are absent', () => {
    const limits = resolveSseConnectionLimits({});
    expect(limits.maxConnectionsPerIp).toBe(DEFAULT_SSE_MAX_CONNECTIONS_PER_IP);
    expect(limits.maxGlobalConnections).toBe(DEFAULT_SSE_MAX_GLOBAL_CONNECTIONS);
    expect(limits.maxConnectionsPerApiKey).toBe(DEFAULT_SSE_MAX_CONNECTIONS_PER_API_KEY);
  });

  it('ignores non-numeric env values and falls back to defaults', () => {
    const limits = resolveSseConnectionLimits({ SSE_MAX_CONNECTIONS_PER_IP: 'not-a-number' });
    expect(limits.maxConnectionsPerIp).toBe(DEFAULT_SSE_MAX_CONNECTIONS_PER_IP);
  });

  it('ignores zero and falls back to defaults (below min=1)', () => {
    const limits = resolveSseConnectionLimits({ SSE_MAX_CONNECTIONS_PER_IP: '0' });
    expect(limits.maxConnectionsPerIp).toBe(DEFAULT_SSE_MAX_CONNECTIONS_PER_IP);
  });
});
