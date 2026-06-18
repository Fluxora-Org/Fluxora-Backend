/**
 * Tests for src/redis/client.ts
 *
 * All ioredis constructors are mocked so no real Redis connection is made.
 * Covers: standalone, sentinel, cluster, NoOpRedisClient, factory swap,
 * error paths, pipeline wrapper, and log event emission.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared with vi.hoisted so vi.mock factories
// can reference them before module initialisation.
// ---------------------------------------------------------------------------

const {
  mockOn,
  mockConnect,
  mockQuit,
  mockGet,
  mockSet,
  mockExists,
  mockZcount,
  mockPipelineExec,
  mockPipeline,
  mockRedisInstance,
  MockRedis,
  MockCluster,
  mockLogger,
} = vi.hoisted(() => {
  const mockOn = vi.fn().mockReturnThis();
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockQuit = vi.fn().mockResolvedValue('OK');
  const mockGet = vi.fn().mockResolvedValue(null);
  const mockSet = vi.fn().mockResolvedValue('OK');
  const mockExists = vi.fn().mockResolvedValue(0);
  const mockZcount = vi.fn().mockResolvedValue(0);
  const mockPipelineExec = vi.fn().mockResolvedValue([]);
  const mockPipeline = {
    zadd: vi.fn().mockReturnThis(),
    zremrangebyscore: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    pexpire: vi.fn().mockReturnThis(),
    exec: mockPipelineExec,
  };
  const mockRedisInstance = {
    on: mockOn,
    connect: mockConnect,
    quit: mockQuit,
    get: mockGet,
    set: mockSet,
    exists: mockExists,
    zcount: mockZcount,
    multi: vi.fn().mockReturnValue(mockPipeline),
  };
  const MockRedis = vi.fn().mockImplementation(function() { return mockRedisInstance; });
  const MockCluster = vi.fn().mockImplementation(function() { return mockRedisInstance; });
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  return {
    mockOn, mockConnect, mockQuit, mockGet, mockSet, mockExists, mockZcount,
    mockPipelineExec, mockPipeline, mockRedisInstance, MockRedis, MockCluster, mockLogger,
  };
});

vi.mock('ioredis', () => ({ Redis: MockRedis, Cluster: MockCluster }));
vi.mock('../../src/logging/logger.js', () => ({ logger: mockLogger }));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  DefaultRedisClientFactory,
  NoOpRedisClient,
  setRedisClientFactory,
  getRedisClientFactory,
  createRedisClient,
  type RedisConfig,
} from '../../src/redis/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig = (overrides: Partial<RedisConfig> = {}): RedisConfig => ({
  url: 'redis://localhost:6379',
  enabled: true,
  ...overrides,
});

function resetMocks() {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockOn.mockReturnThis();
  MockRedis.mockImplementation(function() { return mockRedisInstance; });
  MockCluster.mockImplementation(function() { return mockRedisInstance; });
  mockPipeline.zadd.mockReturnThis();
  mockPipeline.zremrangebyscore.mockReturnThis();
  mockPipeline.zcard.mockReturnThis();
  mockPipeline.pexpire.mockReturnThis();
  mockPipelineExec.mockResolvedValue([]);
  mockRedisInstance.multi.mockReturnValue(mockPipeline);
}

// ---------------------------------------------------------------------------
// DefaultRedisClientFactory — standalone
// ---------------------------------------------------------------------------

describe('DefaultRedisClientFactory — standalone', () => {
  beforeEach(resetMocks);

  it('creates a Redis client with parsed host/port', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(baseConfig({ url: 'redis://myhost:6380' }));

    expect(MockRedis).toHaveBeenCalledWith(
      6380,
      'myhost',
      expect.objectContaining({ lazyConnect: true }),
    );
    expect(mockConnect).toHaveBeenCalled();
  });

  it('passes password from URL', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(baseConfig({ url: 'redis://:s3cr3t@localhost:6379' }));

    expect(MockRedis).toHaveBeenCalledWith(
      6379,
      'localhost',
      expect.objectContaining({ password: 's3cr3t' }),
    );
  });

  it('defaults to port 6379 when URL has no port', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(baseConfig({ url: 'redis://localhost' }));

    expect(MockRedis).toHaveBeenCalledWith(6379, 'localhost', expect.any(Object));
  });

  it('attaches event listeners for structured logging', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(baseConfig());

    const events = mockOn.mock.calls.map(([event]: [string]) => event);
    expect(events).toContain('connect');
    expect(events).toContain('ready');
    expect(events).toContain('reconnecting');
    expect(events).toContain('error');
    expect(events).toContain('close');
    expect(events).toContain('end');
  });

  it('logs info on connect event', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(baseConfig());

    const handler = mockOn.mock.calls.find(([e]: [string]) => e === 'connect')?.[1] as () => void;
    handler?.();
    expect(mockLogger.info).toHaveBeenCalledWith('redis:connect', { mode: 'standalone' });
  });

  it('logs info on ready event', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(baseConfig());

    const handler = mockOn.mock.calls.find(([e]: [string]) => e === 'ready')?.[1] as () => void;
    handler?.();
    expect(mockLogger.info).toHaveBeenCalledWith('redis:ready', { mode: 'standalone' });
  });

  it('logs warn on reconnecting event', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(baseConfig());

    const handler = mockOn.mock.calls.find(([e]: [string]) => e === 'reconnecting')?.[1] as () => void;
    handler?.();
    expect(mockLogger.warn).toHaveBeenCalledWith('redis:reconnecting', { mode: 'standalone' });
  });

  it('logs warn on close event', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(baseConfig());

    const handler = mockOn.mock.calls.find(([e]: [string]) => e === 'close')?.[1] as () => void;
    handler?.();
    expect(mockLogger.warn).toHaveBeenCalledWith('redis:close', { mode: 'standalone' });
  });

  it('logs warn on end event', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(baseConfig());

    const handler = mockOn.mock.calls.find(([e]: [string]) => e === 'end')?.[1] as () => void;
    handler?.();
    expect(mockLogger.warn).toHaveBeenCalledWith('redis:end', { mode: 'standalone' });
  });

  it('logs error on error event', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(baseConfig());

    const handler = mockOn.mock.calls.find(([e]: [string]) => e === 'error')?.[1] as (e: Error) => void;
    handler?.(new Error('ECONNREFUSED'));
    expect(mockLogger.error).toHaveBeenCalledWith('redis:error', {
      mode: 'standalone',
      error: 'ECONNREFUSED',
    });
  });

  it('propagates connect failure', async () => {
    mockConnect.mockRejectedValueOnce(new Error('connection refused'));
    const factory = new DefaultRedisClientFactory();
    await expect(factory.createClient(baseConfig())).rejects.toThrow('connection refused');
  });
});

// ---------------------------------------------------------------------------
// DefaultRedisClientFactory — sentinel
// ---------------------------------------------------------------------------

describe('DefaultRedisClientFactory — sentinel', () => {
  beforeEach(resetMocks);

  it('creates a Sentinel client with parsed hosts', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({
        mode: 'sentinel',
        sentinelHosts: 'sentinel1:26379,sentinel2:26380',
        sentinelName: 'mymaster',
      }),
    );

    expect(MockRedis).toHaveBeenCalledWith(
      expect.objectContaining({
        sentinels: [
          { host: 'sentinel1', port: 26379 },
          { host: 'sentinel2', port: 26380 },
        ],
        name: 'mymaster',
      }),
    );
  });

  it('defaults sentinel name to "mymaster"', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({ mode: 'sentinel', sentinelHosts: 'sentinel1:26379' }),
    );

    expect(MockRedis).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mymaster' }),
    );
  });

  it('passes password from URL to sentinel client', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({
        url: 'redis://:pass123@localhost:6379',
        mode: 'sentinel',
        sentinelHosts: 'sentinel1:26379',
      }),
    );

    expect(MockRedis).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'pass123' }),
    );
  });

  it('throws when sentinelHosts is missing', async () => {
    const factory = new DefaultRedisClientFactory();
    await expect(
      factory.createClient(baseConfig({ mode: 'sentinel' })),
    ).rejects.toThrow('REDIS_SENTINEL_HOSTS is required');
  });

  it('attaches log listeners in sentinel mode', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({ mode: 'sentinel', sentinelHosts: 'sentinel1:26379' }),
    );

    const events = mockOn.mock.calls.map(([e]: [string]) => e);
    expect(events).toContain('connect');
    expect(events).toContain('error');
  });

  it('logs warn on reconnecting in sentinel mode', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({ mode: 'sentinel', sentinelHosts: 'sentinel1:26379' }),
    );

    const handler = mockOn.mock.calls.find(([e]: [string]) => e === 'reconnecting')?.[1] as () => void;
    handler?.();
    expect(mockLogger.warn).toHaveBeenCalledWith('redis:reconnecting', { mode: 'sentinel' });
  });

  it('handles invalid REDIS_URL gracefully (no password) in sentinel mode', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({ url: 'not-a-url', mode: 'sentinel', sentinelHosts: 'sentinel1:26379' }),
    );
    expect(MockRedis).toHaveBeenCalledWith(
      expect.objectContaining({ password: undefined }),
    );
  });
});

// ---------------------------------------------------------------------------
// DefaultRedisClientFactory — cluster
// ---------------------------------------------------------------------------

describe('DefaultRedisClientFactory — cluster', () => {
  beforeEach(resetMocks);

  it('creates a Cluster client with parsed nodes', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({
        mode: 'cluster',
        clusterNodes: 'node1:7000,node2:7001,node3:7002',
      }),
    );

    expect(MockCluster).toHaveBeenCalledWith(
      [
        { host: 'node1', port: 7000 },
        { host: 'node2', port: 7001 },
        { host: 'node3', port: 7002 },
      ],
      expect.objectContaining({ lazyConnect: true }),
    );
    expect(mockConnect).toHaveBeenCalled();
  });

  it('passes password via redisOptions', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({
        url: 'redis://:clusterpass@localhost:6379',
        mode: 'cluster',
        clusterNodes: 'node1:7000',
      }),
    );

    expect(MockCluster).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        redisOptions: expect.objectContaining({ password: 'clusterpass' }),
      }),
    );
  });

  it('throws when clusterNodes is missing', async () => {
    const factory = new DefaultRedisClientFactory();
    await expect(
      factory.createClient(baseConfig({ mode: 'cluster' })),
    ).rejects.toThrow('REDIS_CLUSTER_NODES is required');
  });

  it('attaches log listeners in cluster mode', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({ mode: 'cluster', clusterNodes: 'node1:7000' }),
    );

    const events = mockOn.mock.calls.map(([e]: [string]) => e);
    expect(events).toContain('connect');
    expect(events).toContain('error');
  });

  it('logs warn on close in cluster mode', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({ mode: 'cluster', clusterNodes: 'node1:7000' }),
    );

    const handler = mockOn.mock.calls.find(([e]: [string]) => e === 'close')?.[1] as () => void;
    handler?.();
    expect(mockLogger.warn).toHaveBeenCalledWith('redis:close', { mode: 'cluster' });
  });

  it('handles invalid REDIS_URL gracefully (no password) in cluster mode', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({ url: 'not-a-url', mode: 'cluster', clusterNodes: 'node1:7000' }),
    );
    expect(MockCluster).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        redisOptions: expect.objectContaining({ password: undefined }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// parseHostPorts edge cases (exercised via factory)
// ---------------------------------------------------------------------------

describe('host:port parsing edge cases', () => {
  beforeEach(resetMocks);

  it('throws on malformed sentinel host entry (no colon)', async () => {
    const factory = new DefaultRedisClientFactory();
    await expect(
      factory.createClient(baseConfig({ mode: 'sentinel', sentinelHosts: 'badentry' })),
    ).rejects.toThrow('Invalid host:port entry');
  });

  it('throws on malformed cluster node entry (non-numeric port)', async () => {
    const factory = new DefaultRedisClientFactory();
    await expect(
      factory.createClient(baseConfig({ mode: 'cluster', clusterNodes: 'node1:abc' })),
    ).rejects.toThrow('Invalid host:port entry');
  });

  it('handles single sentinel host', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({ mode: 'sentinel', sentinelHosts: 'sentinel1:26379' }),
    );
    expect(MockRedis).toHaveBeenCalledWith(
      expect.objectContaining({
        sentinels: [{ host: 'sentinel1', port: 26379 }],
      }),
    );
  });

  it('trims whitespace around host:port entries', async () => {
    const factory = new DefaultRedisClientFactory();
    await factory.createClient(
      baseConfig({ mode: 'sentinel', sentinelHosts: ' sentinel1:26379 , sentinel2:26380 ' }),
    );
    expect(MockRedis).toHaveBeenCalledWith(
      expect.objectContaining({
        sentinels: [
          { host: 'sentinel1', port: 26379 },
          { host: 'sentinel2', port: 26380 },
        ],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// RedisClient interface methods (via IORedisClient)
// ---------------------------------------------------------------------------

describe('RedisClient interface methods', () => {
  let client: Awaited<ReturnType<DefaultRedisClientFactory['createClient']>>;

  beforeEach(async () => {
    resetMocks();
    const factory = new DefaultRedisClientFactory();
    client = await factory.createClient(baseConfig());
  });

  it('get() delegates to ioredis.get', async () => {
    mockGet.mockResolvedValueOnce('value');
    expect(await client.get('key')).toBe('value');
    expect(mockGet).toHaveBeenCalledWith('key');
  });

  it('get() returns null when key missing', async () => {
    mockGet.mockResolvedValueOnce(null);
    expect(await client.get('missing')).toBeNull();
  });

  it('set() without TTL calls set(key, value)', async () => {
    await client.set('k', 'v');
    expect(mockSet).toHaveBeenCalledWith('k', 'v');
  });

  it('set() with TTL calls set(key, value, EX, seconds)', async () => {
    await client.set('k', 'v', { ex: 60 });
    expect(mockSet).toHaveBeenCalledWith('k', 'v', 'EX', 60);
  });

  it('exists() returns true when ioredis returns 1', async () => {
    mockExists.mockResolvedValueOnce(1);
    expect(await client.exists('k')).toBe(true);
  });

  it('exists() returns false when ioredis returns 0', async () => {
    mockExists.mockResolvedValueOnce(0);
    expect(await client.exists('k')).toBe(false);
  });

  it('close() calls quit()', async () => {
    await client.close();
    expect(mockQuit).toHaveBeenCalled();
  });

  it('zcount() delegates to ioredis.zcount', async () => {
    mockZcount.mockResolvedValueOnce(5);
    expect(await client.zcount('key', '-inf', '+inf')).toBe(5);
    expect(mockZcount).toHaveBeenCalledWith('key', '-inf', '+inf');
  });
});

// ---------------------------------------------------------------------------
// Pipeline (multi) wrapper
// ---------------------------------------------------------------------------

describe('RedisPipeline wrapper', () => {
  let client: Awaited<ReturnType<DefaultRedisClientFactory['createClient']>>;

  beforeEach(async () => {
    resetMocks();
    const factory = new DefaultRedisClientFactory();
    client = await factory.createClient(baseConfig());
  });

  it('multi() returns a chainable pipeline', () => {
    const pipeline = client.multi();
    expect(pipeline).toBeDefined();
    expect(typeof pipeline.zadd).toBe('function');
    expect(typeof pipeline.exec).toBe('function');
  });

  it('pipeline methods are chainable', () => {
    const pipeline = client.multi();
    const result = pipeline
      .zadd('key', 'NX', 1, 'member')
      .zremrangebyscore('key', '-inf', 0)
      .zcard('key')
      .pexpire('key', 1000);
    expect(result).toBe(pipeline);
  });

  it('pipeline delegates zadd to ioredis pipeline', () => {
    client.multi().zadd('key', 'NX', 1, 'member');
    expect(mockPipeline.zadd).toHaveBeenCalledWith('key', 'NX', 1, 'member');
  });

  it('pipeline delegates zremrangebyscore to ioredis pipeline', () => {
    client.multi().zremrangebyscore('key', '-inf', 0);
    expect(mockPipeline.zremrangebyscore).toHaveBeenCalledWith('key', '-inf', 0);
  });

  it('pipeline delegates zcard to ioredis pipeline', () => {
    client.multi().zcard('key');
    expect(mockPipeline.zcard).toHaveBeenCalledWith('key');
  });

  it('pipeline delegates pexpire to ioredis pipeline', () => {
    client.multi().pexpire('key', 500);
    expect(mockPipeline.pexpire).toHaveBeenCalledWith('key', 500);
  });

  it('exec() returns pipeline results', async () => {
    const results: Array<[Error | null, unknown]> = [[null, 1]];
    mockPipelineExec.mockResolvedValueOnce(results);
    expect(await client.multi().exec()).toEqual(results);
  });
});

// ---------------------------------------------------------------------------
// NoOpRedisClient
// ---------------------------------------------------------------------------

describe('NoOpRedisClient', () => {
  let noop: NoOpRedisClient;

  beforeEach(() => { noop = new NoOpRedisClient(); });

  it('get() returns null', async () => {
    expect(await noop.get('k')).toBeNull();
  });

  it('set() resolves without error', async () => {
    await expect(noop.set('k', 'v')).resolves.toBeUndefined();
  });

  it('exists() returns false', async () => {
    expect(await noop.exists('k')).toBe(false);
  });

  it('close() resolves without error', async () => {
    await expect(noop.close()).resolves.toBeUndefined();
  });

  it('zcount() returns 0', async () => {
    expect(await noop.zcount('k', '-inf', '+inf')).toBe(0);
  });

  it('multi() returns a no-op pipeline', async () => {
    const pipeline = noop.multi();
    const result = pipeline
      .zadd('k', 'NX', 1, 'm')
      .zremrangebyscore('k', '-inf', 0)
      .zcard('k')
      .pexpire('k', 100);
    expect(result).toBe(pipeline);
    expect(await pipeline.exec()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Module-level factory helpers
// ---------------------------------------------------------------------------

describe('factory helpers', () => {
  afterEach(() => {
    setRedisClientFactory(new DefaultRedisClientFactory());
  });

  it('getRedisClientFactory returns the current factory', () => {
    const f = new DefaultRedisClientFactory();
    setRedisClientFactory(f);
    expect(getRedisClientFactory()).toBe(f);
  });

  it('createRedisClient uses the current factory', async () => {
    resetMocks();
    const mockFactory = { createClient: vi.fn().mockResolvedValue(new NoOpRedisClient()) };
    setRedisClientFactory(mockFactory);
    const client = await createRedisClient(baseConfig());
    expect(mockFactory.createClient).toHaveBeenCalledWith(baseConfig());
    expect(client).toBeInstanceOf(NoOpRedisClient);
  });

  it('setRedisClientFactory replaces the factory', () => {
    const original = getRedisClientFactory();
    const replacement = { createClient: vi.fn() };
    setRedisClientFactory(replacement);
    expect(getRedisClientFactory()).toBe(replacement);
    setRedisClientFactory(original);
  });
});
