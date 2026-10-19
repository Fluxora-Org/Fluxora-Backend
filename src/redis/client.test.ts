/**
 * src/redis/client.test.ts
 *
 * Input-validation coverage for src/redis/client.ts (issue #1771).
 *
 * Drives the public surface (`DefaultRedisClientFactory.createClient`,
 * `NoOpRedisClient`) with a mocked ioredis module — no live Redis server.
 * Asserts that malformed, empty, wrong-type and oversized inputs are rejected
 * with a typed `RedisInputError` *before* any Redis write/command is issued,
 * that the caller can tell which field and which rule failed, and that valid
 * boundary values are unaffected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── ioredis mock ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const pipeline = {
    zadd: vi.fn(),
    zremrangebyscore: vi.fn(),
    zcard: vi.fn(),
    pexpire: vi.fn(),
    exec: vi.fn(async (): Promise<Array<[Error | null, unknown]>> => []),
  };
  const raw = {
    on: vi.fn(),
    connect: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    get: vi.fn(async (): Promise<string | null> => null),
    set: vi.fn(async (): Promise<string> => 'OK'),
    del: vi.fn(async (): Promise<number> => 1),
    incr: vi.fn(async (): Promise<number> => 1),
    exists: vi.fn(async (): Promise<number> => 0),
    eval: vi.fn(async (): Promise<number> => 1),
    zcount: vi.fn(async (): Promise<number> => 0),
    multi: vi.fn(() => pipeline),
    status: 'ready',
    commandQueue: { length: 0 },
  };
  return { raw, pipeline };
});

vi.mock('ioredis', () => ({
  // Regular function (not arrow) so `new ioredis.Redis(...)` works.
  Redis: vi.fn(function RedisMock() {
    return mocks.raw;
  }),
  Cluster: vi.fn(function ClusterMock() {
    return mocks.raw;
  }),
}));

import {
  DefaultRedisClientFactory,
  NoOpRedisClient,
  RedisInputError,
  _resetRedisClientRegistry,
  _resetTrackedClients,
  type RedisClient,
} from './client.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const VALID_CONFIG = { url: 'redis://localhost:6379', enabled: true } as const;

/** Create a real IORedisClient over the mocked raw ioredis connection. */
async function makeClient(): Promise<RedisClient> {
  return new DefaultRedisClientFactory().createClient({ ...VALID_CONFIG });
}

/** Every command method on the raw mock that counts as a Redis call. */
function rawCommandMocks() {
  return [
    mocks.raw.get,
    mocks.raw.set,
    mocks.raw.del,
    mocks.raw.incr,
    mocks.raw.exists,
    mocks.raw.eval,
    mocks.raw.zcount,
  ];
}

function clearRawCalls(): void {
  for (const fn of rawCommandMocks()) fn.mockClear();
  mocks.raw.multi.mockClear();
  mocks.pipeline.zadd.mockClear();
  mocks.pipeline.zremrangebyscore.mockClear();
  mocks.pipeline.zcard.mockClear();
  mocks.pipeline.pexpire.mockClear();
  mocks.pipeline.exec.mockClear();
}

/** Assert that no Redis command was issued at all. */
function expectNoRedisCalls(): void {
  for (const fn of rawCommandMocks()) {
    expect(fn, `${fn.getMockName()} must not be called on validation failure`).not.toHaveBeenCalled();
  }
}

function makeOversized(length: number): string {
  return 'x'.repeat(length);
}

beforeEach(() => {
  clearRawCalls();
  _resetTrackedClients();
  _resetRedisClientRegistry();
});

afterEach(() => {
  vi.clearAllMocks();
  _resetTrackedClients();
  _resetRedisClientRegistry();
});

// ─────────────────────────────────────────────────────────────────────────────
// RedisInputError
// ─────────────────────────────────────────────────────────────────────────────

describe('RedisInputError', () => {
  it('is an Error with name RedisInputError and a machine-readable field', () => {
    const err = new RedisInputError('key', 'must be a non-empty string');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RedisInputError');
    expect(err.field).toBe('key');
    expect(err.message).toContain('key');
    expect(err.message).toContain('must be a non-empty string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get
// ─────────────────────────────────────────────────────────────────────────────

describe('get — input validation', () => {
  it('rejects an empty key with RedisInputError before any Redis call', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.get('')).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a whitespace-only key', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.get('   ')).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a non-string key (wrong type)', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.get(42 as unknown as string)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects null / undefined keys', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.get(null as unknown as string)).rejects.toThrow(RedisInputError);
    await expect(client.get(undefined as unknown as string)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects an oversized key (> 1024 chars)', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.get(makeOversized(1025))).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('accepts a key of exactly 1024 chars (boundary)', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.get(makeOversized(1024))).resolves.toBeNull();
    expect(mocks.raw.get).toHaveBeenCalledWith(makeOversized(1024));
  });

  it('reports which field failed in the error', async () => {
    const client = await makeClient();
    try {
      await client.get('');
      expect.unreachable('get("") must reject');
    } catch (err) {
      expect(err).toBeInstanceOf(RedisInputError);
      expect((err as RedisInputError).field).toBe('key');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// set
// ─────────────────────────────────────────────────────────────────────────────

describe('set — input validation', () => {
  it('rejects an empty key before any Redis call', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('', 'value')).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a whitespace-only key', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('  ', 'value')).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a non-string key', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set({} as unknown as string, 'value')).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a null / undefined value', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('k', null as unknown as string)).rejects.toThrow(RedisInputError);
    await expect(client.set('k', undefined as unknown as string)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a non-string value (wrong type)', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('k', 123 as unknown as string)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects an oversized key (> 1024 chars)', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set(makeOversized(1025), 'v')).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects an oversized value (> 1 MiB)', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('k', makeOversized(1_048_577))).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('accepts a key of exactly 1024 chars and a value of exactly 1 MiB', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set(makeOversized(1024), makeOversized(1_048_576))).resolves.toBeUndefined();
    expect(mocks.raw.set).toHaveBeenCalledWith(makeOversized(1024), makeOversized(1_048_576));
  });

  it('accepts an empty-string value (valid in Redis)', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('k', '')).resolves.toBeUndefined();
    expect(mocks.raw.set).toHaveBeenCalledWith('k', '');
  });

  it('rejects ex = 0 (was silently ignored) with RedisInputError', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('k', 'v', { ex: 0 })).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a negative ex', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('k', 'v', { ex: -1 })).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a non-integer / NaN ex', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('k', 'v', { ex: 1.5 })).rejects.toThrow(RedisInputError);
    await expect(client.set('k', 'v', { ex: Number.NaN })).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a negative pxat', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('k', 'v', { pxat: -1 })).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a non-integer pxat', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('k', 'v', { pxat: 1.5 })).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('accepts a valid ex and issues SET … EX', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('k', 'v', { ex: 60 })).resolves.toBeUndefined();
    expect(mocks.raw.set).toHaveBeenCalledWith('k', 'v', 'EX', 60);
  });

  it('accepts a valid pxat and issues SET … PXAT', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.set('k', 'v', { pxat: 1_700_000_000_000 })).resolves.toBeUndefined();
    expect(mocks.raw.set).toHaveBeenCalledWith('k', 'v', 'PXAT', 1_700_000_000_000);
  });

  it('reports which field failed for a bad ex', async () => {
    const client = await makeClient();
    try {
      await client.set('k', 'v', { ex: 0 });
      expect.unreachable('set with ex:0 must reject');
    } catch (err) {
      expect(err).toBeInstanceOf(RedisInputError);
      expect((err as RedisInputError).field).toBe('options.ex');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setNx
// ─────────────────────────────────────────────────────────────────────────────

describe('setNx — input validation', () => {
  it('rejects an empty key before any Redis call', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.setNx('', 'owner', 1_000)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a whitespace-only key', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.setNx(' \t ', 'owner', 1_000)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a non-string key', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.setNx(null as unknown as string, 'owner', 1_000)).rejects.toThrow(
      RedisInputError,
    );
    expectNoRedisCalls();
  });

  it('rejects a null / non-string value', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.setNx('k', null as unknown as string, 1_000)).rejects.toThrow(
      RedisInputError,
    );
    await expect(client.setNx('k', 9 as unknown as string, 1_000)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects an oversized key (> 1024 chars)', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.setNx(makeOversized(1025), 'owner', 1_000)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects an oversized value (> 1 MiB)', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.setNx('k', makeOversized(1_048_577), 1_000)).rejects.toThrow(
      RedisInputError,
    );
    expectNoRedisCalls();
  });

  it('rejects pxMs = 0 / negative / non-integer / NaN', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.setNx('k', 'owner', 0)).rejects.toThrow(RedisInputError);
    await expect(client.setNx('k', 'owner', -5)).rejects.toThrow(RedisInputError);
    await expect(client.setNx('k', 'owner', 1.5)).rejects.toThrow(RedisInputError);
    await expect(client.setNx('k', 'owner', Number.NaN)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('accepts valid inputs and issues SET … PX … NX', async () => {
    const mocksSet = mocks.raw.set;
    mocksSet.mockResolvedValueOnce('OK');
    const client = await makeClient();
    clearRawCalls();

    await expect(client.setNx('k', 'owner', 5_000)).resolves.toBe(true);
    expect(mocksSet).toHaveBeenCalledWith('k', 'owner', 'PX', 5_000, 'NX');
  });

  it('reports which field failed for a bad pxMs', async () => {
    const client = await makeClient();
    try {
      await client.setNx('k', 'owner', 0);
      expect.unreachable('setNx with pxMs:0 must reject');
    } catch (err) {
      expect(err).toBeInstanceOf(RedisInputError);
      expect((err as RedisInputError).field).toBe('pxMs');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// del / incr / exists / delIfValue
// ─────────────────────────────────────────────────────────────────────────────

describe('del — input validation', () => {
  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['non-string', 7 as unknown as string],
    ['null', null as unknown as string],
    ['oversized', makeOversized(1025)],
  ])('rejects a %s key before any Redis call', async (_label, badKey) => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.del(badKey)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('accepts a boundary-length key', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.del(makeOversized(1024))).resolves.toBeUndefined();
    expect(mocks.raw.del).toHaveBeenCalledWith(makeOversized(1024));
  });
});

describe('incr — input validation', () => {
  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['non-string', {} as unknown as string],
    ['null', null as unknown as string],
    ['oversized', makeOversized(1025)],
  ])('rejects a %s key before any Redis call', async (_label, badKey) => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.incr(badKey)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('accepts a boundary-length key', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.incr(makeOversized(1024))).resolves.toBe(1);
    expect(mocks.raw.incr).toHaveBeenCalledWith(makeOversized(1024));
  });
});

describe('exists — input validation', () => {
  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['non-string', false as unknown as string],
    ['null', null as unknown as string],
    ['oversized', makeOversized(1025)],
  ])('rejects a %s key before any Redis call', async (_label, badKey) => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.exists(badKey)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('accepts a boundary-length key', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.exists(makeOversized(1024))).resolves.toBe(false);
    expect(mocks.raw.exists).toHaveBeenCalledWith(makeOversized(1024));
  });
});

describe('delIfValue — input validation', () => {
  it('rejects an empty key before any Redis call', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.delIfValue!('', 'owner')).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects a non-string / null value', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.delIfValue!('k', null as unknown as string)).rejects.toThrow(
      RedisInputError,
    );
    expectNoRedisCalls();
  });

  it('rejects an oversized key', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.delIfValue!(makeOversized(1025), 'owner')).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('accepts valid inputs and issues the CAS eval', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.delIfValue!('k', 'owner')).resolves.toBeUndefined();
    expect(mocks.raw.eval).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// multi() pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('multi() pipeline — input validation', () => {
  it('zadd rejects an empty key before queueing', async () => {
    const client = await makeClient();
    clearRawCalls();

    const pipeline = client.multi();
    expect(() => pipeline.zadd('', 'NX', 1, 'member')).toThrow(RedisInputError);
    expect(mocks.pipeline.zadd).not.toHaveBeenCalled();
  });

  it('zadd rejects a non-finite score', async () => {
    const client = await makeClient();
    clearRawCalls();

    const pipeline = client.multi();
    expect(() => pipeline.zadd('k', 'NX', Number.NaN, 'member')).toThrow(RedisInputError);
    expect(() => pipeline.zadd('k', 'NX', Infinity, 'member')).toThrow(RedisInputError);
    expect(mocks.pipeline.zadd).not.toHaveBeenCalled();
  });

  it('accepts an empty member (valid Redis zset member)', async () => {
    const client = await makeClient();
    clearRawCalls();

    const pipeline = client.multi();
    expect(() => pipeline.zadd('k', 'NX', 1, '')).not.toThrow();
    expect(mocks.pipeline.zadd).toHaveBeenCalledWith('k', 'NX', 1, '');
  });

  it('rejects a non-string member', async () => {
    const client = await makeClient();
    clearRawCalls();

    const pipeline = client.multi();
    expect(() => pipeline.zadd('k', 'NX', 1, null as unknown as string)).toThrow(RedisInputError);
    expect(mocks.pipeline.zadd).not.toHaveBeenCalled();
  });

  it('zremrangebyscore rejects an empty key', async () => {
    const client = await makeClient();
    clearRawCalls();

    const pipeline = client.multi();
    expect(() => pipeline.zremrangebyscore('', 0, 1)).toThrow(RedisInputError);
    expect(mocks.pipeline.zremrangebyscore).not.toHaveBeenCalled();
  });

  it('zremrangebyscore rejects invalid min/max bounds', async () => {
    const client = await makeClient();
    clearRawCalls();

    const pipeline = client.multi();
    expect(() => pipeline.zremrangebyscore('k', 'not-a-score', 1)).toThrow(RedisInputError);
    expect(() => pipeline.zremrangebyscore('k', 0, Number.NaN)).toThrow(RedisInputError);
    expect(mocks.pipeline.zremrangebyscore).not.toHaveBeenCalled();
  });

  it('zremrangebyscore accepts -inf / +inf bounds', async () => {
    const client = await makeClient();
    clearRawCalls();

    const pipeline = client.multi();
    expect(() => pipeline.zremrangebyscore('k', '-inf', '+inf')).not.toThrow();
    expect(mocks.pipeline.zremrangebyscore).toHaveBeenCalledWith('k', '-inf', '+inf');
  });

  it('zcard rejects an empty key', async () => {
    const client = await makeClient();
    clearRawCalls();

    const pipeline = client.multi();
    expect(() => pipeline.zcard('')).toThrow(RedisInputError);
    expect(mocks.pipeline.zcard).not.toHaveBeenCalled();
  });

  it('pexpire rejects an empty key and a negative / non-integer ms', async () => {
    const client = await makeClient();
    clearRawCalls();

    const pipeline = client.multi();
    expect(() => pipeline.pexpire('', 1_000)).toThrow(RedisInputError);
    expect(() => pipeline.pexpire('k', -1)).toThrow(RedisInputError);
    expect(() => pipeline.pexpire('k', 1.5)).toThrow(RedisInputError);
    expect(mocks.pipeline.pexpire).not.toHaveBeenCalled();
  });

  it('pexpire accepts ms = 0 (Redis deletes the key) and a valid positive ms', async () => {
    const client = await makeClient();
    clearRawCalls();

    const pipeline = client.multi();
    expect(() => pipeline.pexpire('k', 0)).not.toThrow();
    expect(() => pipeline.pexpire('k', 5_000)).not.toThrow();
    expect(mocks.pipeline.pexpire).toHaveBeenCalledWith('k', 0);
    expect(mocks.pipeline.pexpire).toHaveBeenCalledWith('k', 5_000);
  });

  it('accepts a valid pipeline and exec resolves', async () => {
    const client = await makeClient();
    clearRawCalls();

    const pipeline = client.multi();
    pipeline
      .zadd('k', 'NX', 1, 'member')
      .zremrangebyscore('k', '-inf', '+inf')
      .zcard('k')
      .pexpire('k', 1_000);
    await expect(pipeline.exec()).resolves.toEqual([]);
    expect(mocks.pipeline.exec).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zcount
// ─────────────────────────────────────────────────────────────────────────────

describe('zcount — input validation', () => {
  it('rejects an empty key before any Redis call', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.zcount('', 0, 1)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('rejects invalid min / max bounds', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.zcount('k', 'nope', 1)).rejects.toThrow(RedisInputError);
    await expect(client.zcount('k', 0, Number.NaN)).rejects.toThrow(RedisInputError);
    expectNoRedisCalls();
  });

  it('accepts numeric and inf bounds', async () => {
    const client = await makeClient();
    clearRawCalls();

    await expect(client.zcount('k', '-inf', 10)).resolves.toBe(0);
    expect(mocks.raw.zcount).toHaveBeenCalledWith('k', '-inf', 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DefaultRedisClientFactory — config validation
// ─────────────────────────────────────────────────────────────────────────────

describe('DefaultRedisClientFactory.createClient — config validation', () => {
  it('rejects an empty url with RedisInputError before connecting', async () => {
    const factory = new DefaultRedisClientFactory();
    clearRawCalls();

    await expect(factory.createClient({ url: '', enabled: true })).rejects.toThrow(RedisInputError);
    expect(mocks.raw.connect).not.toHaveBeenCalled();
  });

  it('rejects a non-string url', async () => {
    const factory = new DefaultRedisClientFactory();
    clearRawCalls();

    await expect(
      factory.createClient({ url: null as unknown as string, enabled: true }),
    ).rejects.toThrow(RedisInputError);
    expect(mocks.raw.connect).not.toHaveBeenCalled();
  });

  it('rejects a malformed url with RedisInputError (not a raw TypeError)', async () => {
    const factory = new DefaultRedisClientFactory();
    clearRawCalls();

    await expect(
      factory.createClient({ url: 'not a url at all', enabled: true }),
    ).rejects.toThrow(RedisInputError);
    expect(mocks.raw.connect).not.toHaveBeenCalled();
  });

  it('rejects sentinel mode without sentinelHosts with RedisInputError', async () => {
    const factory = new DefaultRedisClientFactory();
    clearRawCalls();

    await expect(
      factory.createClient({ ...VALID_CONFIG, mode: 'sentinel' }),
    ).rejects.toThrow(RedisInputError);
    expect(mocks.raw.connect).not.toHaveBeenCalled();
  });

  it('rejects a malformed sentinelHosts entry with RedisInputError', async () => {
    const factory = new DefaultRedisClientFactory();
    clearRawCalls();

    await expect(
      factory.createClient({
        ...VALID_CONFIG,
        mode: 'sentinel',
        sentinelHosts: 'no-port-here',
      }),
    ).rejects.toThrow(RedisInputError);
    expect(mocks.raw.connect).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric sentinel port with RedisInputError', async () => {
    const factory = new DefaultRedisClientFactory();
    clearRawCalls();

    await expect(
      factory.createClient({
        ...VALID_CONFIG,
        mode: 'sentinel',
        sentinelHosts: 'host:abc',
      }),
    ).rejects.toThrow(RedisInputError);
  });

  it('rejects cluster mode without clusterNodes with RedisInputError', async () => {
    const factory = new DefaultRedisClientFactory();
    clearRawCalls();

    await expect(
      factory.createClient({ ...VALID_CONFIG, mode: 'cluster' }),
    ).rejects.toThrow(RedisInputError);
    expect(mocks.raw.connect).not.toHaveBeenCalled();
  });

  it('rejects a malformed clusterNodes entry with RedisInputError', async () => {
    const factory = new DefaultRedisClientFactory();
    clearRawCalls();

    await expect(
      factory.createClient({
        ...VALID_CONFIG,
        mode: 'cluster',
        clusterNodes: 'missing-port',
      }),
    ).rejects.toThrow(RedisInputError);
    expect(mocks.raw.connect).not.toHaveBeenCalled();
  });

  it('accepts a valid standalone config and returns a working client', async () => {
    const factory = new DefaultRedisClientFactory();
    clearRawCalls();

    const client = await factory.createClient(VALID_CONFIG);
    expect(mocks.raw.connect).toHaveBeenCalled();
    await expect(client.get('k')).resolves.toBeNull();
  });

  it('accepts valid sentinel hosts and returns a working client', async () => {
    const factory = new DefaultRedisClientFactory();
    clearRawCalls();

    const client = await factory.createClient({
      ...VALID_CONFIG,
      mode: 'sentinel',
      sentinelHosts: 'sentinel-a:26379,sentinel-b:26379',
      sentinelName: 'mymaster',
    });
    expect(mocks.raw.connect).toHaveBeenCalled();
    await expect(client.get('k')).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NoOpRedisClient — same typed-error contract
// ─────────────────────────────────────────────────────────────────────────────

describe('NoOpRedisClient — input validation', () => {
  it('rejects an empty key on get', async () => {
    const client = new NoOpRedisClient();
    await expect(client.get('')).rejects.toThrow(RedisInputError);
  });

  it('rejects an empty key on set', async () => {
    const client = new NoOpRedisClient();
    await expect(client.set('', 'v')).rejects.toThrow(RedisInputError);
  });

  it('rejects a null value on set', async () => {
    const client = new NoOpRedisClient();
    await expect(client.set('k', null as unknown as string)).rejects.toThrow(RedisInputError);
  });

  it('rejects an empty key on setNx', async () => {
    const client = new NoOpRedisClient();
    await expect(client.setNx('', 'owner', 1_000)).rejects.toThrow(RedisInputError);
  });

  it('rejects pxMs = 0 on setNx', async () => {
    const client = new NoOpRedisClient();
    await expect(client.setNx('k', 'owner', 0)).rejects.toThrow(RedisInputError);
  });

  it('rejects an empty key on del / incr / exists', async () => {
    const client = new NoOpRedisClient();
    await expect(client.del('')).rejects.toThrow(RedisInputError);
    await expect(client.incr('')).rejects.toThrow(RedisInputError);
    await expect(client.exists('')).rejects.toThrow(RedisInputError);
  });

  it('still accepts valid inputs with the documented no-op semantics', async () => {
    const client = new NoOpRedisClient();
    await expect(client.get('any-key')).resolves.toBeNull();
    await expect(client.set('k', 'v')).resolves.toBeUndefined();
    await expect(client.setNx('lock:key', 'owner', 5_000)).resolves.toBe(true);
    await expect(client.del('k')).resolves.toBeUndefined();
    await expect(client.incr('counter')).resolves.toBe(1);
    await expect(client.exists('k')).resolves.toBe(false);
    await expect(client.multi().exec()).resolves.toEqual([]);
    await expect(client.zcount('k', 0, 1)).resolves.toBe(0);
    await expect(client.close()).resolves.toBeUndefined();
  });
});
