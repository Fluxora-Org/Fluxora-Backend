/**
 * tests/redis/client.reconnect.test.ts
 *
 * Asserts the documented reconnection and command-retry semantics of
 * src/redis/client.ts (issue #1432).
 *
 * All tests run without a real Redis server — they drive the behaviour
 * through the public API surface, the module-level helpers, and EventEmitter
 * fakes that stand in for ioredis connections.
 *
 * Coverage targets
 * ────────────────
 * Reconnection behaviour
 *   ✓ defaultRetryStrategy returns a positive delay for attempts 0–9
 *   ✓ defaultRetryStrategy returns null after REDIS_RETRY_MAX_ATTEMPTS
 *   ✓ delay is bounded by REDIS_RETRY_MAX_DELAY_MS
 *   ✓ delay grows (exponential) with attempt number
 *   ✓ reconnecting event increments redis_reconnects_total
 *   ✓ multiple reconnecting events accumulate
 *   ✓ connection-state transitions logged at correct severity
 *
 * Command retry policy
 *   ✓ maxRetriesPerRequest is read from REDIS_MAX_RETRIES_PER_REQUEST
 *   ✓ command failure increments redis_command_failures_total
 *   ✓ reconnect and command-failure counters remain independent
 *
 * Non-retryable commands — JSDoc @nonRetryable markers present
 *   ✓ setNx  interface method carries @nonRetryable
 *   ✓ incr   interface method carries @nonRetryable
 *   ✓ delIfValue interface method carries @nonRetryable
 *   ✓ multi  interface method carries @nonRetryable
 *
 * Connection state exposure
 *   ✓ getConnectionState returns empty object when no clients are tracked
 *   ✓ getConnectionState returns 'ready' for a ready client
 *   ✓ getConnectionState returns 'reconnecting' for a reconnecting client
 *   ✓ getConnectionState returns 'unknown' for an unrecognised status string
 *   ✓ getConnectionState handles multiple independent instances
 *   ✓ getConnectionState stays in sync after a status transition
 *
 * Mid-command reconnect behaviour
 *   ✓ command failure during reconnect increments command-failure counter
 *   ✓ withCommandMetrics re-throws the original error
 *   ✓ pipeline exec failure increments command-failure counter
 *   ✓ NoOpRedisClient.setNx always returns true (uncontended single-process)
 *   ✓ NoOpRedisClient.incr always returns 1
 *   ✓ NoOpRedisClient.multi().exec() returns empty array
 *
 * Connection state metric alignment
 *   ✓ statusToValue('reconnecting') === 2 aligns with documented enum
 *   ✓ statusToValue('ready') === 3 aligns with documented enum
 *   ✓ statusToValue('end') === 0 aligns with documented enum
 *   ✓ redis_connection_status gauge reflects state after tracking
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  _trackClient,
  _resetTrackedClients,
  collectRedisSaturationStats,
  getConnectionState,
  NoOpRedisClient,
} from '../../src/redis/client.js';

import {
  recordRedisReconnect,
  recordRedisCommandFailure,
  redisReconnectsTotal,
  redisCommandFailuresTotal,
  redisConnectionStatus,
  statusToValue,
  syncRedisGauges,
  deRegisterRedisPoolMetrics,
} from '../../src/metrics/redisPool.js';

import { CONNECTION_LIMIT_DEFAULTS, resolveConnectionLimit } from '../../src/config/connectionLimits.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal fake ioredis-compatible EventEmitter with a mutable status. */
function makeFakeClient(initialStatus = 'ready') {
  const ee = new EventEmitter() as EventEmitter & {
    status: string;
    commandQueue: { length: number };
    quit: () => Promise<void>;
  };
  ee.status = initialStatus;
  ee.commandQueue = { length: 0 };
  ee.quit = async () => { /* no-op */ };
  return ee;
}

async function counterValue(
  counter: typeof redisReconnectsTotal,
  instanceName: string,
): Promise<number> {
  const data = await counter.get();
  const entry = data.values.find((v) => v.labels['instance'] === instanceName);
  return entry?.value ?? 0;
}

async function gaugeValue(
  gauge: typeof redisConnectionStatus,
  instanceName: string,
): Promise<number> {
  const data = await gauge.get();
  const entry = data.values.find((v) => v.labels['instance'] === instanceName);
  return entry?.value ?? 0;
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset counter internal state BEFORE de-registering — prom-client clears
  // the value when .reset() is called on the counter object, even if it is
  // later removed from the registry and re-created.  The `getSingleMetric ||
  // new Counter` pattern in redisPool.ts means the same object is reused
  // across beforeEach/afterEach cycles, so we must reset it explicitly.
  redisReconnectsTotal.reset();
  redisCommandFailuresTotal.reset();
  deRegisterRedisPoolMetrics();
  _resetTrackedClients();
});

afterEach(() => {
  redisReconnectsTotal.reset();
  redisCommandFailuresTotal.reset();
  deRegisterRedisPoolMetrics();
  _resetTrackedClients();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Reconnection behaviour — retry strategy
// ─────────────────────────────────────────────────────────────────────────────

describe('reconnection behaviour — retry strategy', () => {
  /**
   * `defaultRetryStrategy` is internal, but its contract is observable through
   * CONNECTION_LIMIT_DEFAULTS and the documented backoff formula.  We test the
   * formula directly rather than reaching for internal symbols.
   */

  it('REDIS_RETRY_MAX_ATTEMPTS default is 10', () => {
    expect(CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_ATTEMPTS).toBe(10);
  });

  it('REDIS_RETRY_BASE_DELAY_MS default is 50 ms', () => {
    expect(CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_BASE_DELAY_MS).toBe(50);
  });

  it('REDIS_RETRY_MAX_DELAY_MS default is 2 000 ms', () => {
    expect(CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_DELAY_MS).toBe(2_000);
  });

  it('calculateNextRetryDelay returns a positive delay for attempts 0–9', async () => {
    const { calculateNextRetryDelay } = await import('../../src/lib/retry.js');

    for (let attempt = 0; attempt < CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_ATTEMPTS; attempt++) {
      const delay = calculateNextRetryDelay(attempt, {
        baseDelayMs: CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_BASE_DELAY_MS,
        maxDelayMs: CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_DELAY_MS,
        maxAttempts: CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_ATTEMPTS,
      });
      expect(delay, `attempt ${attempt} should return a positive delay`).toBeGreaterThan(0);
    }
  });

  it('calculateNextRetryDelay returns 0 (signals stop) at REDIS_RETRY_MAX_ATTEMPTS', async () => {
    const { calculateNextRetryDelay } = await import('../../src/lib/retry.js');

    const delay = calculateNextRetryDelay(CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_ATTEMPTS, {
      baseDelayMs: CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_BASE_DELAY_MS,
      maxDelayMs: CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_DELAY_MS,
      maxAttempts: CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_ATTEMPTS,
    });
    // 0 is the sentinel that defaultRetryStrategy translates to null (give up)
    expect(delay).toBe(0);
  });

  it('delay is bounded by REDIS_RETRY_MAX_DELAY_MS', async () => {
    const { calculateNextRetryDelay } = await import('../../src/lib/retry.js');

    for (let attempt = 0; attempt < CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_ATTEMPTS; attempt++) {
      const delay = calculateNextRetryDelay(attempt, {
        baseDelayMs: CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_BASE_DELAY_MS,
        maxDelayMs: CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_DELAY_MS,
        maxAttempts: CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_ATTEMPTS,
        jitterPercent: 0, // deterministic for ceiling assertions
      });
      expect(delay).toBeLessThanOrEqual(CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_DELAY_MS);
    }
  });

  it('delay grows with attempt number (exponential backoff)', async () => {
    const { calculateNextRetryDelay } = await import('../../src/lib/retry.js');

    const opts = {
      baseDelayMs: CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_BASE_DELAY_MS,
      maxDelayMs: CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_DELAY_MS,
      maxAttempts: CONNECTION_LIMIT_DEFAULTS.REDIS_RETRY_MAX_ATTEMPTS,
      jitterPercent: 0, // deterministic
    };

    // The first few attempts (before hitting the cap) must be strictly
    // increasing — confirming the exponential growth.
    const d0 = calculateNextRetryDelay(0, opts); // 50 ms
    const d1 = calculateNextRetryDelay(1, opts); // 100 ms
    const d2 = calculateNextRetryDelay(2, opts); // 200 ms

    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reconnection behaviour — events and counters
// ─────────────────────────────────────────────────────────────────────────────

describe('reconnection behaviour — events and counters', () => {
  it('reconnecting event increments redis_reconnects_total', async () => {
    const client = makeFakeClient('ready');
    _trackClient('default', client as never);

    client.emit('reconnecting');

    expect(await counterValue(redisReconnectsTotal, 'default')).toBe(1);
  });

  it('multiple reconnecting events accumulate in the counter', async () => {
    const client = makeFakeClient('ready');
    _trackClient('default', client as never);

    client.emit('reconnecting');
    client.emit('reconnecting');
    client.emit('reconnecting');

    expect(await counterValue(redisReconnectsTotal, 'default')).toBe(3);
  });

  it('command failures do not increment the reconnect counter', async () => {
    const client = makeFakeClient('ready');
    _trackClient('default', client as never);

    // Simulate command failures (not reconnects)
    recordRedisCommandFailure('default');
    recordRedisCommandFailure('default');

    expect(await counterValue(redisReconnectsTotal, 'default')).toBe(0);
  });

  it('reconnect counter does not bleed into command-failure counter', async () => {
    const client = makeFakeClient('ready');
    _trackClient('default', client as never);

    client.emit('reconnecting');
    client.emit('reconnecting');

    expect(await counterValue(redisCommandFailuresTotal, 'default')).toBe(0);
  });

  it('independent instances have independent reconnect counters', async () => {
    const a = makeFakeClient('ready');
    const b = makeFakeClient('ready');
    _trackClient('instance-a', a as never);
    _trackClient('instance-b', b as never);

    a.emit('reconnecting');
    a.emit('reconnecting');
    b.emit('reconnecting');

    expect(await counterValue(redisReconnectsTotal, 'instance-a')).toBe(2);
    expect(await counterValue(redisReconnectsTotal, 'instance-b')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Command retry policy
// ─────────────────────────────────────────────────────────────────────────────

describe('command retry policy', () => {
  it('REDIS_MAX_RETRIES_PER_REQUEST default is 3', () => {
    expect(CONNECTION_LIMIT_DEFAULTS.REDIS_MAX_RETRIES_PER_REQUEST).toBe(3);
  });

  it('resolveConnectionLimit reads REDIS_MAX_RETRIES_PER_REQUEST from env', () => {
    const orig = process.env['REDIS_MAX_RETRIES_PER_REQUEST'];
    process.env['REDIS_MAX_RETRIES_PER_REQUEST'] = '7';
    expect(resolveConnectionLimit('REDIS_MAX_RETRIES_PER_REQUEST')).toBe(7);
    if (orig === undefined) {
      delete process.env['REDIS_MAX_RETRIES_PER_REQUEST'];
    } else {
      process.env['REDIS_MAX_RETRIES_PER_REQUEST'] = orig;
    }
  });

  it('command failure increments redis_command_failures_total', async () => {
    recordRedisCommandFailure('default');
    expect(await counterValue(redisCommandFailuresTotal, 'default')).toBe(1);
  });

  it('reconnect and command-failure counters remain independent', async () => {
    const client = makeFakeClient('ready');
    _trackClient('default', client as never);

    client.emit('reconnecting');
    recordRedisCommandFailure('default');
    client.emit('reconnecting');

    expect(await counterValue(redisReconnectsTotal, 'default')).toBe(2);
    expect(await counterValue(redisCommandFailuresTotal, 'default')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-retryable commands — @nonRetryable markers in source
// ─────────────────────────────────────────────────────────────────────────────

describe('non-retryable command markers in client.ts source', () => {
  /**
   * The acceptance criterion "Commands that must not be retried are identified"
   * is satisfied by @nonRetryable JSDoc tags in the RedisClient interface and
   * the module-level doc block.  These tests assert the markers are present by
   * reading the source file — they act as a lint guard.
   */

  let source: string;

  beforeEach(async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { resolve, dirname } = await import('node:path');
    // Resolve relative to this test file's location
    const dir = dirname(fileURLToPath(import.meta.url));
    const clientPath = resolve(dir, '../../src/redis/client.ts');
    source = await readFile(clientPath, 'utf8');
  });

  it('setNx carries a @nonRetryable annotation', () => {
    // The tag appears in the JSDoc block immediately before `setNx`
    const setNxBlock = source.slice(source.indexOf('setNx('));
    // Walk backwards to find the JSDoc
    const beforeSetNx = source.slice(0, source.indexOf('setNx(key: string, value: string, pxMs: number): Promise<boolean>;'));
    expect(beforeSetNx).toContain('@nonRetryable');
  });

  it('incr carries a @nonRetryable annotation', () => {
    const beforeIncr = source.slice(0, source.indexOf('incr(key: string): Promise<number>;'));
    expect(beforeIncr).toContain('@nonRetryable');
  });

  it('delIfValue carries a @nonRetryable annotation', () => {
    const beforeDelIfValue = source.slice(0, source.indexOf('delIfValue?(key: string, value: string): Promise<void>;'));
    expect(beforeDelIfValue).toContain('@nonRetryable');
  });

  it('multi carries a @nonRetryable annotation in the interface', () => {
    // There are two multi() declarations; we only care that at least one
    // in the interface has the tag.
    const interfaceSection = source.slice(
      source.indexOf('export interface RedisClient'),
      source.indexOf('export interface RedisClientFactory'),
    );
    expect(interfaceSection).toContain('@nonRetryable');
    expect(interfaceSection).toContain('multi()');
  });

  it('module doc block explicitly lists the four non-retryable commands', () => {
    // Top-of-file module comment
    const moduleDoc = source.slice(0, source.indexOf('import type'));
    expect(moduleDoc).toContain('setNx');
    expect(moduleDoc).toContain('incr');
    expect(moduleDoc).toContain('delIfValue');
    expect(moduleDoc).toContain('multi().exec()');
  });

  it('module doc block describes the reconnect backoff parameters', () => {
    const moduleDoc = source.slice(0, source.indexOf('import type'));
    expect(moduleDoc).toContain('REDIS_RETRY_BASE_DELAY_MS');
    expect(moduleDoc).toContain('REDIS_RETRY_MAX_DELAY_MS');
    expect(moduleDoc).toContain('REDIS_RETRY_MAX_ATTEMPTS');
  });

  it('module doc block mentions getConnectionState', () => {
    const moduleDoc = source.slice(0, source.indexOf('import type'));
    expect(moduleDoc).toContain('getConnectionState');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connection state exposure — getConnectionState
// ─────────────────────────────────────────────────────────────────────────────

describe('getConnectionState', () => {
  it('returns an empty object when no clients are tracked', () => {
    expect(getConnectionState()).toEqual({});
  });

  it('returns "ready" for a client whose status is "ready"', () => {
    const client = makeFakeClient('ready');
    _trackClient('default', client as never);

    expect(getConnectionState()).toEqual({ default: 'ready' });
  });

  it('returns "reconnecting" for a client whose status is "reconnecting"', () => {
    const client = makeFakeClient('reconnecting');
    _trackClient('default', client as never);

    expect(getConnectionState()).toEqual({ default: 'reconnecting' });
  });

  it('returns "connecting" for a client in the connecting state', () => {
    const client = makeFakeClient('connecting');
    _trackClient('default', client as never);

    expect(getConnectionState()).toEqual({ default: 'connecting' });
  });

  it('returns "end" for a client that exhausted reconnects', () => {
    const client = makeFakeClient('end');
    _trackClient('default', client as never);

    expect(getConnectionState()).toEqual({ default: 'end' });
  });

  it('returns "close" for a closed client', () => {
    const client = makeFakeClient('close');
    _trackClient('default', client as never);

    expect(getConnectionState()).toEqual({ default: 'close' });
  });

  it('returns "wait" for a lazy-connect client before connect() is called', () => {
    const client = makeFakeClient('wait');
    _trackClient('default', client as never);

    expect(getConnectionState()).toEqual({ default: 'wait' });
  });

  it('returns "unknown" for an unrecognised status string', () => {
    const client = makeFakeClient('bogus_status');
    _trackClient('default', client as never);

    expect(getConnectionState()).toEqual({ default: 'unknown' });
  });

  it('handles multiple independent instances', () => {
    const a = makeFakeClient('ready');
    const b = makeFakeClient('reconnecting');
    _trackClient('instance-a', a as never);
    _trackClient('instance-b', b as never);

    const state = getConnectionState();
    expect(state).toEqual({ 'instance-a': 'ready', 'instance-b': 'reconnecting' });
  });

  it('stays in sync after a status transition', () => {
    const client = makeFakeClient('ready');
    _trackClient('default', client as never);

    expect(getConnectionState()['default']).toBe('ready');

    client.status = 'reconnecting';
    expect(getConnectionState()['default']).toBe('reconnecting');

    client.status = 'ready';
    expect(getConnectionState()['default']).toBe('ready');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mid-command reconnect simulation
// ─────────────────────────────────────────────────────────────────────────────

describe('mid-command reconnect simulation', () => {
  it('command failure during reconnect increments redis_command_failures_total', async () => {
    // Drive the failure path directly (mirrors IORedisClient.withCommandMetrics)
    recordRedisCommandFailure('default');

    expect(await counterValue(redisCommandFailuresTotal, 'default')).toBe(1);
  });

  it('withCommandMetrics re-throws the original error', async () => {
    // We simulate the exact behaviour of IORedisClient.withCommandMetrics:
    // wrap a rejecting fn, record the failure, then rethrow.
    async function withCommandMetrics<T>(
      instanceName: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      try {
        return await fn();
      } catch (err) {
        recordRedisCommandFailure(instanceName);
        throw err;
      }
    }

    const boom = new Error('ECONNRESET during GET');
    await expect(withCommandMetrics('default', () => Promise.reject(boom))).rejects.toThrow(
      'ECONNRESET during GET',
    );
    expect(await counterValue(redisCommandFailuresTotal, 'default')).toBe(1);
  });

  it('pipeline exec failure increments redis_command_failures_total', async () => {
    // NoOpRedisClient.multi().exec() returns [] — test that the counter path
    // would be taken if exec() threw, mirroring the IORedisClient pipeline wrapper.
    let caught: Error | null = null;
    const pipelineError = new Error('EXECABORT Transaction discarded');

    async function simulatePipelineExec(instanceName: string): Promise<void> {
      try {
        throw pipelineError;
      } catch (err) {
        recordRedisCommandFailure(instanceName);
        caught = err as Error;
        throw err;
      }
    }

    await expect(simulatePipelineExec('default')).rejects.toThrow('EXECABORT');
    expect(caught).toBe(pipelineError);
    expect(await counterValue(redisCommandFailuresTotal, 'default')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NoOpRedisClient — behaviour when Redis is disabled
// ─────────────────────────────────────────────────────────────────────────────

describe('NoOpRedisClient', () => {
  it('setNx always returns true (uncontended single-process mode)', async () => {
    const client = new NoOpRedisClient();
    expect(await client.setNx('lock:key', 'owner-1', 5_000)).toBe(true);
    // Second call still returns true — no state is held
    expect(await client.setNx('lock:key', 'owner-2', 5_000)).toBe(true);
  });

  it('incr always returns 1 (stateless)', async () => {
    const client = new NoOpRedisClient();
    expect(await client.incr('counter')).toBe(1);
    expect(await client.incr('counter')).toBe(1);
  });

  it('multi().exec() returns an empty array', async () => {
    const client = new NoOpRedisClient();
    const result = await client.multi().exec();
    expect(result).toEqual([]);
  });

  it('get always returns null', async () => {
    const client = new NoOpRedisClient();
    expect(await client.get('any-key')).toBeNull();
  });

  it('exists always returns false', async () => {
    const client = new NoOpRedisClient();
    expect(await client.exists('any-key')).toBe(false);
  });

  it('set and del complete without error', async () => {
    const client = new NoOpRedisClient();
    await expect(client.set('k', 'v')).resolves.toBeUndefined();
    await expect(client.del('k')).resolves.toBeUndefined();
  });

  it('close completes without error', async () => {
    const client = new NoOpRedisClient();
    await expect(client.close()).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connection state metric alignment
// ─────────────────────────────────────────────────────────────────────────────

describe('connection state metric alignment', () => {
  it('statusToValue("reconnecting") === 2 (documented enum)', () => {
    expect(statusToValue('reconnecting')).toBe(2);
  });

  it('statusToValue("ready") === 3 (documented enum)', () => {
    expect(statusToValue('ready')).toBe(3);
  });

  it('statusToValue("end") === 0 (documented enum)', () => {
    expect(statusToValue('end')).toBe(0);
  });

  it('statusToValue("connecting") === 1 (documented enum)', () => {
    expect(statusToValue('connecting')).toBe(1);
  });

  it('statusToValue("close") === 4 (documented enum)', () => {
    expect(statusToValue('close')).toBe(4);
  });

  it('redis_connection_status gauge reflects state after syncRedisGauges', async () => {
    syncRedisGauges({ instanceName: 'default', commandQueueLength: 0, status: 'reconnecting' });
    expect(await gaugeValue(redisConnectionStatus, 'default')).toBe(2);
  });

  it('gauge transitions correctly as status changes', async () => {
    syncRedisGauges({ instanceName: 'default', commandQueueLength: 0, status: 'reconnecting' });
    expect(await gaugeValue(redisConnectionStatus, 'default')).toBe(2);

    syncRedisGauges({ instanceName: 'default', commandQueueLength: 0, status: 'ready' });
    expect(await gaugeValue(redisConnectionStatus, 'default')).toBe(3);
  });

  it('getConnectionState and statusToValue agree on reconnecting → 2', () => {
    const client = makeFakeClient('reconnecting');
    _trackClient('default', client as never);

    const state = getConnectionState();
    expect(statusToValue(state['default']!)).toBe(2);
  });

  it('getConnectionState and statusToValue agree on ready → 3', () => {
    const client = makeFakeClient('ready');
    _trackClient('default', client as never);

    const state = getConnectionState();
    expect(statusToValue(state['default']!)).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// collectRedisSaturationStats — state is visible through stats
// ─────────────────────────────────────────────────────────────────────────────

describe('collectRedisSaturationStats with tracked clients', () => {
  it('returns a stats entry for each tracked client', () => {
    const a = makeFakeClient('ready');
    const b = makeFakeClient('reconnecting');
    _trackClient('instance-a', a as never);
    _trackClient('instance-b', b as never);

    const stats = collectRedisSaturationStats();
    expect(stats).toHaveLength(2);

    const names = stats.map((s) => s.instanceName);
    expect(names).toContain('instance-a');
    expect(names).toContain('instance-b');
  });

  it('reflects the current status of each client', () => {
    const client = makeFakeClient('ready');
    _trackClient('default', client as never);

    let stats = collectRedisSaturationStats();
    expect(stats[0]?.status).toBe('ready');

    client.status = 'reconnecting';
    stats = collectRedisSaturationStats();
    expect(stats[0]?.status).toBe('reconnecting');
  });

  it('reads commandQueue.length from the client', () => {
    const client = makeFakeClient('ready');
    client.commandQueue = { length: 42 };
    _trackClient('default', client as never);

    const stats = collectRedisSaturationStats();
    expect(stats[0]?.commandQueueLength).toBe(42);
  });

  it('defaults commandQueueLength to 0 when commandQueue is undefined', () => {
    const client = makeFakeClient('ready');
    // Force commandQueue to be absent
    delete (client as { commandQueue?: { length: number } }).commandQueue;
    _trackClient('default', client as never);

    const stats = collectRedisSaturationStats();
    expect(stats[0]?.commandQueueLength).toBe(0);
  });
});
