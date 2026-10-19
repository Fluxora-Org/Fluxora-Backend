import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BanStore } from '../redis/banStore.js';
import { HybridBanStore, InMemoryBanStore } from '../redis/banStore.js';
import type { RedisClient } from '../redis/client.js';
import { getClientIp as extractClientIp } from '../lib/ipExtraction.js';
import { logger } from '../lib/logger.js';
import {
  _resetLimiter,
  checkAndReserve,
  getActiveConnectionCount,
  getBanStore,
  getClientIp,
  gracefulDrain,
  isShuttingDown,
  setBanStore,
  trackConnection,
  untrackConnection,
  wireRedisBanStore,
} from './connectionLimiter.js';

// ── helpers ────────────────────────────────────────────────────────────────

type EnvKey =
  | 'WS_MAX_CONNECTIONS_PER_IP'
  | 'WS_RECONNECT_LIMIT'
  | 'WS_RECONNECT_WINDOW_MS'
  | 'WS_ABUSE_THRESHOLD'
  | 'WS_BAN_TTL_S';

const ENV_KEYS: readonly EnvKey[] = [
  'WS_MAX_CONNECTIONS_PER_IP',
  'WS_RECONNECT_LIMIT',
  'WS_RECONNECT_WINDOW_MS',
  'WS_ABUSE_THRESHOLD',
  'WS_BAN_TTL_S',
];

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  EnvKey,
  string | undefined
>;

const LIMITER_DEFAULTS: Record<EnvKey, string> = {
  WS_MAX_CONNECTIONS_PER_IP: '10',
  WS_RECONNECT_LIMIT: '1000',
  WS_RECONNECT_WINDOW_MS: '60000',
  // Keep abuse banning out of the way unless a test opts in.
  WS_ABUSE_THRESHOLD: '1000',
  WS_BAN_TTL_S: '3600',
};

function setLimiterEnv(overrides: Partial<Record<EnvKey, string>> = {}): void {
  for (const key of ENV_KEYS) {
    process.env[key] = overrides[key] ?? LIMITER_DEFAULTS[key];
  }
}

interface MockBanStore {
  isBanned: ReturnType<typeof vi.fn>;
  ban: ReturnType<typeof vi.fn>;
  unban: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function createMockBanStore(): MockBanStore {
  return {
    isBanned: vi.fn(async () => ({ banned: false })),
    ban: vi.fn(async () => {}),
    unban: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function installBanStore(store: MockBanStore): void {
  setBanStore(store as unknown as BanStore);
}

const CLOSE_PAYLOAD = JSON.stringify({ reason: 'Server restarting' });

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setLimiterEnv();
  _resetLimiter();
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetLimiter();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ── re-export ──────────────────────────────────────────────────────────────

describe('getClientIp re-export', () => {
  it('forwards the canonical IP extractor from lib/ipExtraction', () => {
    expect(getClientIp).toBe(extractClientIp);
  });
});

// ── checkAndReserve — connection cap ───────────────────────────────────────

describe('checkAndReserve — per-key connection cap', () => {
  it('reserves a slot on the normal path and reports it as active', async () => {
    const result = await checkAndReserve('203.0.113.1');

    expect(result).toEqual({ allowed: true });
    expect(getActiveConnectionCount()).toBe(1);

    untrackConnection('203.0.113.1');
    expect(getActiveConnectionCount()).toBe(0);
  });

  it('allows exactly the configured maximum and rejects the next attempt', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '2' });
    const ip = '203.0.113.2';

    expect(await checkAndReserve(ip)).toEqual({ allowed: true });
    expect(await checkAndReserve(ip)).toEqual({ allowed: true });

    const rejected = await checkAndReserve(ip);
    expect(rejected).toEqual({ allowed: false, code: 4029, reason: 'Too many connections' });
    // A rejection must not reserve a slot.
    expect(getActiveConnectionCount()).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(
      'ws_connection_rejected',
      undefined,
      expect.objectContaining({
        event: 'ws_connection_rejected',
        reason: 'Too many connections',
        ip,
      })
    );
  });

  it('accepts a new connection again once a slot is released', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '1' });
    const ip = '203.0.113.3';

    expect((await checkAndReserve(ip)).allowed).toBe(true);
    expect((await checkAndReserve(ip)).allowed).toBe(false);

    untrackConnection(ip);

    expect((await checkAndReserve(ip)).allowed).toBe(true);
  });

  it('rejects the first attempt when the maximum is zero', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '0' });

    const result = await checkAndReserve('203.0.113.4');

    expect(result).toEqual({ allowed: false, code: 4029, reason: 'Too many connections' });
    expect(getActiveConnectionCount()).toBe(0);
  });

  it('falls back to the documented defaults when the settings are empty', async () => {
    setLimiterEnv({
      WS_MAX_CONNECTIONS_PER_IP: '',
      WS_RECONNECT_LIMIT: '',
      WS_RECONNECT_WINDOW_MS: '',
      WS_ABUSE_THRESHOLD: '',
      WS_BAN_TTL_S: '',
    });
    const ip = '203.0.113.5';

    for (let i = 0; i < 10; i += 1) {
      expect((await checkAndReserve(ip)).allowed).toBe(true);
    }

    expect(await checkAndReserve(ip)).toEqual({
      allowed: false,
      code: 4029,
      reason: 'Too many connections',
    });
  });
});

// ── checkAndReserve — key resolution ───────────────────────────────────────

describe('checkAndReserve — identity vs IP keys', () => {
  it('applies the cap independently per authenticated identity', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '1' });
    const ip = '203.0.113.10';

    expect((await checkAndReserve(ip, 'alice')).allowed).toBe(true);
    expect((await checkAndReserve(ip, 'alice')).allowed).toBe(false);
    // Same IP, different identity → its own bucket.
    expect((await checkAndReserve(ip, 'bob')).allowed).toBe(true);
    // No identity → the raw-IP bucket is independent of both identities.
    expect((await checkAndReserve(ip)).allowed).toBe(true);
  });

  it('trims identities so padded and unpadded values share one bucket', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '1' });
    const ip = '203.0.113.11';

    expect((await checkAndReserve(ip, '  carol  ')).allowed).toBe(true);
    expect((await checkAndReserve(ip, 'carol')).allowed).toBe(false);
  });

  it('falls back to the IP bucket when the identity is empty or whitespace', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '1' });
    const ip = '203.0.113.12';

    expect((await checkAndReserve(ip, '   ')).allowed).toBe(true);
    expect((await checkAndReserve(ip)).allowed).toBe(false);
    expect((await checkAndReserve(ip, '')).allowed).toBe(false);
  });
});

// ── reconnect rate limiting ────────────────────────────────────────────────

describe('checkAndReserve — reconnect rate limiting', () => {
  it('rejects attempts beyond the reconnect limit within the window', async () => {
    setLimiterEnv({ WS_RECONNECT_LIMIT: '2' });
    const ip = '198.51.100.1';

    expect((await checkAndReserve(ip)).allowed).toBe(true);
    untrackConnection(ip);
    expect((await checkAndReserve(ip)).allowed).toBe(true);
    untrackConnection(ip);

    expect(await checkAndReserve(ip)).toEqual({
      allowed: false,
      code: 4029,
      reason: 'Reconnect rate exceeded',
    });
  });

  it('rejects immediately when the reconnect limit is zero', async () => {
    setLimiterEnv({ WS_RECONNECT_LIMIT: '0' });

    expect(await checkAndReserve('198.51.100.2')).toEqual({
      allowed: false,
      code: 4029,
      reason: 'Reconnect rate exceeded',
    });
  });

  it('treats the window boundary as exclusive (an attempt at exactly the window age expires)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);
    setLimiterEnv({ WS_RECONNECT_LIMIT: '1', WS_RECONNECT_WINDOW_MS: '60000' });
    const ip = '198.51.100.3';

    // t0 — recorded as an attempt.
    expect((await checkAndReserve(ip)).allowed).toBe(true);
    untrackConnection(ip);

    // One millisecond inside the window — still counted.
    vi.setSystemTime(new Date(t0.getTime() + 59_999));
    expect(await checkAndReserve(ip)).toEqual({
      allowed: false,
      code: 4029,
      reason: 'Reconnect rate exceeded',
    });

    // Exactly at the window edge — the old attempt has expired.
    vi.setSystemTime(new Date(t0.getTime() + 60_000));
    expect((await checkAndReserve(ip)).allowed).toBe(true);
  });

  it('never rate-limits when the window is zero', async () => {
    setLimiterEnv({ WS_RECONNECT_LIMIT: '1', WS_RECONNECT_WINDOW_MS: '0' });
    const ip = '198.51.100.4';

    for (let i = 0; i < 5; i += 1) {
      expect((await checkAndReserve(ip)).allowed).toBe(true);
      untrackConnection(ip);
    }
  });

  it('keeps reconnect history separate per identity', async () => {
    setLimiterEnv({ WS_RECONNECT_LIMIT: '1' });
    const ip = '198.51.100.5';

    expect((await checkAndReserve(ip, 'dave')).allowed).toBe(true);
    untrackConnection(ip, 'dave');
    expect((await checkAndReserve(ip, 'dave')).allowed).toBe(false);

    // A different identity has its own history.
    expect((await checkAndReserve(ip, 'erin')).allowed).toBe(true);
  });
});

// ── ban integration ────────────────────────────────────────────────────────

describe('checkAndReserve — ban integration', () => {
  it('rejects a banned IP and rolls the reservation back', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '1' });
    const store = createMockBanStore();
    store.isBanned.mockResolvedValue({ banned: true });
    installBanStore(store);
    const ip = '198.51.100.10';

    const result = await checkAndReserve(ip);

    expect(result).toEqual({ allowed: false, code: 4029, reason: 'IP banned due to abuse' });
    expect(store.isBanned).toHaveBeenCalledWith(ip);
    // The reservation taken before the async ban check must be released.
    expect(getActiveConnectionCount()).toBe(0);

    // Proves the per-key slot was released, not merely the global counter.
    store.isBanned.mockResolvedValue({ banned: false });
    expect((await checkAndReserve(ip)).allowed).toBe(true);
  });

  it('proceeds with the reservation when the ban store throws', async () => {
    const store = createMockBanStore();
    store.isBanned.mockRejectedValue(new Error('redis unavailable'));
    installBanStore(store);

    const result = await checkAndReserve('198.51.100.11');

    // BanStore implementations fall back internally; the limiter must not
    // turn a store error into a rejected connection.
    expect(result).toEqual({ allowed: true });
    expect(getActiveConnectionCount()).toBe(1);
  });

  it('exposes and replaces the active ban store', () => {
    expect(getBanStore()).toBeInstanceOf(InMemoryBanStore);

    const store = createMockBanStore();
    installBanStore(store);

    expect(getBanStore()).toBe(store);
  });

  it('wires a Redis-backed hybrid store for durable bans', async () => {
    const client = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      del: vi.fn(async () => {}),
    };

    wireRedisBanStore(client as unknown as RedisClient);

    expect(getBanStore()).toBeInstanceOf(HybridBanStore);

    const result = await checkAndReserve('198.51.100.12');
    expect(result.allowed).toBe(true);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('fluxora:ws:ban:'));
  });

  it('logs Redis ban store failures through the wired error callback', async () => {
    const client = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new Error('redis offline'))
        .mockRejectedValueOnce('plain string failure'),
      set: vi.fn(async () => {}),
      del: vi.fn(async () => {}),
    };
    wireRedisBanStore(client as unknown as RedisClient);

    const result = await checkAndReserve('198.51.100.13');

    expect(warnSpy).toHaveBeenCalledWith('Redis ban store error on isBanned', undefined, {
      error: 'redis offline',
    });
    // HybridBanStore fails closed, so the limiter rejects the connection.
    expect(result).toEqual({ allowed: false, code: 4029, reason: 'IP banned due to abuse' });

    // Non-Error rejections are stringified rather than dropped.
    await checkAndReserve('198.51.100.13');
    expect(warnSpy).toHaveBeenCalledWith('Redis ban store error on isBanned', undefined, {
      error: 'plain string failure',
    });
  });
});

// ── abuse rejection → ban delegation ───────────────────────────────────────

describe('rejection accounting and abuse bans', () => {
  it('bans only after the rejection count exceeds the threshold, then clears history', async () => {
    setLimiterEnv({
      WS_MAX_CONNECTIONS_PER_IP: '0',
      WS_ABUSE_THRESHOLD: '2',
      WS_BAN_TTL_S: '120',
    });
    const store = createMockBanStore();
    installBanStore(store);
    const ip = '192.0.2.20';

    await checkAndReserve(ip);
    await checkAndReserve(ip);
    // Exactly at the threshold — no ban yet.
    expect(store.ban).not.toHaveBeenCalled();

    await checkAndReserve(ip);
    expect(store.ban).toHaveBeenCalledTimes(1);
    expect(store.ban).toHaveBeenCalledWith({ ip, ttlSeconds: 120 });

    // History is cleared after a ban, so the next rejection starts a new window.
    await checkAndReserve(ip);
    expect(store.ban).toHaveBeenCalledTimes(1);
  });

  it('bans on the first rejection when the threshold is zero', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '0', WS_ABUSE_THRESHOLD: '0' });
    const store = createMockBanStore();
    installBanStore(store);
    const ip = '192.0.2.21';

    await checkAndReserve(ip);

    expect(store.ban).toHaveBeenCalledTimes(1);
    expect(store.ban).toHaveBeenCalledWith({ ip, ttlSeconds: 3600 });
  });

  it('counts rejections inside the 60s abuse window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-02-01T00:00:00.000Z');
    vi.setSystemTime(t0);
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '0', WS_ABUSE_THRESHOLD: '1' });
    const store = createMockBanStore();
    installBanStore(store);

    await checkAndReserve('192.0.2.22');
    expect(store.ban).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(t0.getTime() + 59_999));
    await checkAndReserve('192.0.2.22');
    expect(store.ban).toHaveBeenCalledTimes(1);
  });

  it('drops rejections that fall outside the 60s abuse window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-02-01T00:00:00.000Z');
    vi.setSystemTime(t0);
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '0', WS_ABUSE_THRESHOLD: '1' });
    const store = createMockBanStore();
    installBanStore(store);

    await checkAndReserve('192.0.2.23');
    expect(store.ban).not.toHaveBeenCalled();

    // Exactly 60s later the first rejection has aged out of the window.
    vi.setSystemTime(new Date(t0.getTime() + 60_000));
    await checkAndReserve('192.0.2.23');

    expect(store.ban).not.toHaveBeenCalled();
  });

  it('logs instead of throwing when persisting a ban fails', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '0', WS_ABUSE_THRESHOLD: '0' });
    const store = createMockBanStore();
    store.ban.mockRejectedValueOnce(new Error('redis down'));
    installBanStore(store);
    const ip = '192.0.2.24';

    await checkAndReserve(ip);
    // Allow the fire-and-forget ban rejection handler to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to persist ban to store',
      undefined,
      expect.objectContaining({ ip, error: 'redis down' })
    );

    // Non-Error rejections are stringified rather than dropped.
    store.ban.mockRejectedValueOnce('plain string failure');
    await checkAndReserve(ip);
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to persist ban to store',
      undefined,
      expect.objectContaining({ ip, error: 'plain string failure' })
    );
  });
});

// ── tracking helpers ───────────────────────────────────────────────────────

describe('trackConnection / untrackConnection', () => {
  it('trackConnection consumes a connection slot for the key', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '1' });
    const ip = '192.0.2.30';

    trackConnection(ip);

    expect(await checkAndReserve(ip)).toEqual({
      allowed: false,
      code: 4029,
      reason: 'Too many connections',
    });

    untrackConnection(ip);
    expect((await checkAndReserve(ip)).allowed).toBe(true);
  });

  it('tracks the same key used by checkAndReserve for trimmed identities', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '1' });
    const ip = '192.0.2.31';

    trackConnection(ip, 'frank');

    expect((await checkAndReserve(ip, ' frank ')).allowed).toBe(false);
    untrackConnection(ip, 'frank');
    expect((await checkAndReserve(ip, 'frank')).allowed).toBe(true);
  });

  it('frees only one slot when more than one is still held', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '2' });
    const ip = '192.0.2.35';

    expect((await checkAndReserve(ip)).allowed).toBe(true);
    expect((await checkAndReserve(ip)).allowed).toBe(true);

    untrackConnection(ip);

    // The key was decremented to one held slot, not cleared: only one more
    // connection fits under the cap of two.
    expect((await checkAndReserve(ip)).allowed).toBe(true);
    expect((await checkAndReserve(ip)).allowed).toBe(false);

    untrackConnection(ip);
    untrackConnection(ip);
    expect((await checkAndReserve(ip)).allowed).toBe(true);
  });

  it('clamps at zero and is safe to call when nothing is tracked', () => {
    expect(getActiveConnectionCount()).toBe(0);

    expect(() => untrackConnection('192.0.2.32')).not.toThrow();
    expect(() => untrackConnection('192.0.2.32', 'ghost')).not.toThrow();

    expect(getActiveConnectionCount()).toBe(0);
  });

  it('never lets the global counter go negative on double-decrement', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '5' });
    const ip = '192.0.2.33';

    expect((await checkAndReserve(ip)).allowed).toBe(true);
    expect(getActiveConnectionCount()).toBe(1);

    untrackConnection(ip);
    untrackConnection(ip);

    expect(getActiveConnectionCount()).toBe(0);
  });

  it('getActiveConnectionCount only counts reserved connections', () => {
    expect(getActiveConnectionCount()).toBe(0);

    // trackConnection adjusts the per-key cap but not the global gauge feed.
    trackConnection('192.0.2.34');
    expect(getActiveConnectionCount()).toBe(0);
  });
});

// ── graceful shutdown ──────────────────────────────────────────────────────

describe('gracefulDrain', () => {
  it('is not shutting down by default', () => {
    expect(isShuttingDown()).toBe(false);
  });

  it('rejects new connections while draining', async () => {
    await gracefulDrain({ clients: new Set() }, 0);

    expect(isShuttingDown()).toBe(true);
    expect(await checkAndReserve('192.0.2.40')).toEqual({
      allowed: false,
      code: 4029,
      reason: 'Server shutting down',
    });
  });

  it('sends a 1001 close frame to open clients only', async () => {
    const open = { readyState: 1, close: vi.fn() };
    const closing = { readyState: 2, close: vi.fn() };
    const closed = { readyState: 3, close: vi.fn() };

    await gracefulDrain({ clients: new Set([open, closing, closed]) }, 0);

    expect(open.close).toHaveBeenCalledWith(1001, CLOSE_PAYLOAD);
    expect(closing.close).not.toHaveBeenCalled();
    expect(closed.close).not.toHaveBeenCalled();
  });

  it('tolerates a client whose close() throws and still resolves', async () => {
    const broken = {
      readyState: 1,
      close: vi.fn(() => {
        throw new Error('socket already gone');
      }),
    };

    await expect(gracefulDrain({ clients: new Set([broken]) }, 0)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to send close frame to client',
      undefined,
      expect.objectContaining({ error: 'socket already gone' })
    );
  });

  it('stringifies non-Error close failures', async () => {
    const broken = {
      readyState: 1,
      close: vi.fn(() => {
        throw 'raw failure';
      }),
    };

    await gracefulDrain({ clients: new Set([broken]) }, 0);

    expect(warnSpy).toHaveBeenCalledWith('Failed to send close frame to client', undefined, {
      error: 'raw failure',
    });
  });

  it('handles a missing WebSocketServer or clients set', async () => {
    await expect(gracefulDrain(null, 0)).resolves.toBeUndefined();
    await expect(gracefulDrain({}, 0)).resolves.toBeUndefined();
  });

  it('returns immediately when a drain is already in progress', async () => {
    const open = { readyState: 1, close: vi.fn() };

    await gracefulDrain({ clients: new Set([open]) }, 0);
    await gracefulDrain({ clients: new Set([open]) }, 0);

    expect(infoSpy).toHaveBeenCalledWith('Graceful drain already in progress');
    expect(open.close).toHaveBeenCalledTimes(1);
  });

  it('gives up at the grace-period boundary and reports the remaining connections', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '5' });
    expect((await checkAndReserve('192.0.2.41')).allowed).toBe(true);

    // A zero grace period never waits, regardless of the wall clock.
    await gracefulDrain({ clients: new Set() }, 0);

    expect(getActiveConnectionCount()).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Grace period expired with 1 connections still active',
      undefined,
      { remainingConnections: 1 }
    );
  });

  it('resolves as soon as the last connection closes during the grace period', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '5' });
    const ip = '192.0.2.42';
    expect((await checkAndReserve(ip)).allowed).toBe(true);

    const drain = gracefulDrain({ clients: new Set() }, 1000);
    // The connection closes while the drain is waiting.
    untrackConnection(ip);
    await vi.advanceTimersByTimeAsync(100);
    await drain;

    expect(getActiveConnectionCount()).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith('All connections drained gracefully');
  });
});

// ── reset ──────────────────────────────────────────────────────────────────

describe('_resetLimiter', () => {
  it('clears counters, reconnect history, shutdown state and the ban store', async () => {
    setLimiterEnv({ WS_MAX_CONNECTIONS_PER_IP: '1', WS_RECONNECT_LIMIT: '1' });
    const customStore = createMockBanStore();
    installBanStore(customStore);
    const ip = '192.0.2.50';

    expect((await checkAndReserve(ip)).allowed).toBe(true);
    await gracefulDrain({ clients: new Set() }, 0);

    expect(getActiveConnectionCount()).toBe(1);
    expect(isShuttingDown()).toBe(true);

    _resetLimiter();

    expect(getActiveConnectionCount()).toBe(0);
    expect(isShuttingDown()).toBe(false);
    expect(getBanStore()).not.toBe(customStore);
    expect(getBanStore()).toBeInstanceOf(InMemoryBanStore);
    expect(customStore.close).toHaveBeenCalled();

    // Both the connection count and the reconnect attempt were cleared: with
    // a cap of 1 and a reconnect limit of 1 this can only succeed after reset.
    expect((await checkAndReserve(ip)).allowed).toBe(true);
  });
});
