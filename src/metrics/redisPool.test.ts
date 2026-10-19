import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const gaugeSet = vi.fn();
const counterInc = vi.fn();
const removeSingleMetric = vi.fn();
const metricsStore = new Map<string, unknown>();

vi.mock('../metrics.js', () => ({
  registry: {
    getSingleMetric: (name: string) => metricsStore.get(name) ?? null,
    removeSingleMetric: (name: string) => {
      removeSingleMetric(name);
      metricsStore.delete(name);
    },
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('prom-client', () => {
  class Gauge {
    name: string;
    constructor(opts: { name: string }) {
      this.name = opts.name;
      metricsStore.set(opts.name, this);
    }
    set = gaugeSet;
  }
  class Counter {
    name: string;
    constructor(opts: { name: string }) {
      this.name = opts.name;
      metricsStore.set(opts.name, this);
    }
    inc = counterInc;
  }
  return { Gauge, Counter };
});

// Import after mocks so constructors use the mocked registry / prom-client
const {
  statusToValue,
  recordRedisReconnect,
  recordRedisCommandFailure,
  syncRedisGauges,
  deRegisterRedisPoolMetrics,
} = await import('./redisPool.js');

describe('statusToValue', () => {
  it('maps known ioredis statuses to documented enum values', () => {
    expect(statusToValue('end')).toBe(0);
    expect(statusToValue('connecting')).toBe(1);
    expect(statusToValue('reconnecting')).toBe(2);
    expect(statusToValue('ready')).toBe(3);
    expect(statusToValue('connect')).toBe(3);
    expect(statusToValue('close')).toBe(4);
    expect(statusToValue('wait')).toBe(1);
  });

  it('returns -1 for unknown status (failure / boundary)', () => {
    expect(statusToValue('')).toBe(-1);
    expect(statusToValue('weird')).toBe(-1);
    expect(statusToValue('READY')).toBe(-1); // case-sensitive
  });
});

describe('recordRedisReconnect', () => {
  beforeEach(() => {
    counterInc.mockClear();
  });

  it('increments reconnects counter for the instance label (normal path)', () => {
    recordRedisReconnect('dedup');
    expect(counterInc).toHaveBeenCalledWith({ instance: 'dedup' });
  });

  it('accepts empty instance name as a boundary label value', () => {
    recordRedisReconnect('');
    expect(counterInc).toHaveBeenCalledWith({ instance: '' });
  });
});

describe('recordRedisCommandFailure', () => {
  beforeEach(() => {
    counterInc.mockClear();
  });

  it('increments command failures for the instance (normal path)', () => {
    recordRedisCommandFailure('idempotency');
    expect(counterInc).toHaveBeenCalledWith({ instance: 'idempotency' });
  });
});

describe('syncRedisGauges', () => {
  beforeEach(() => {
    gaugeSet.mockClear();
  });

  it('sets queue length and status gauges (normal path)', () => {
    syncRedisGauges({
      commandQueueLength: 3,
      status: 'ready',
      instanceName: 'default',
    });

    expect(gaugeSet).toHaveBeenCalledWith({ instance: 'default' }, 3);
    expect(gaugeSet).toHaveBeenCalledWith({ instance: 'default' }, 3); // status ready → 3
  });

  it('handles zero queue length boundary', () => {
    syncRedisGauges({
      commandQueueLength: 0,
      status: 'end',
      instanceName: 'default',
    });
    expect(gaugeSet).toHaveBeenCalledWith({ instance: 'default' }, 0); // queue
    expect(gaugeSet).toHaveBeenCalledWith({ instance: 'default' }, 0); // status end
  });

  it('maps unknown status to -1 on the status gauge', () => {
    syncRedisGauges({
      commandQueueLength: 1,
      status: 'nope',
      instanceName: 'webhook-rate-limit',
    });
    expect(gaugeSet).toHaveBeenCalledWith({ instance: 'webhook-rate-limit' }, 1);
    expect(gaugeSet).toHaveBeenCalledWith({ instance: 'webhook-rate-limit' }, -1);
  });
});

describe('deRegisterRedisPoolMetrics', () => {
  it('removes all five redis pool metric names', () => {
    removeSingleMetric.mockClear();
    deRegisterRedisPoolMetrics();
    expect(removeSingleMetric).toHaveBeenCalledWith('redis_command_queue_length');
    expect(removeSingleMetric).toHaveBeenCalledWith('redis_connection_status');
    expect(removeSingleMetric).toHaveBeenCalledWith('redis_queue_length_warnings_total');
    expect(removeSingleMetric).toHaveBeenCalledWith('redis_reconnects_total');
    expect(removeSingleMetric).toHaveBeenCalledWith('redis_command_failures_total');
    expect(removeSingleMetric).toHaveBeenCalledTimes(5);
  });
});
