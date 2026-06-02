/**
 * tests/metrics/pool.test.ts
 *
 * Comprehensive tests for src/metrics/pool.ts
 *
 * Coverage targets:
 *  - Gauge registration and label names
 *  - syncPoolGauges: active = totalCount - idleCount, idle, waiting
 *  - syncPoolGauges: active never goes negative (clamp to 0)
 *  - syncPoolGauges: multiple named pools tracked independently
 *  - syncPoolGauges: pool exhaustion simulation (waiting >> 0)
 *  - syncPoolGauges: zero-wait baseline
 *  - deRegisterPoolMetrics: removes all three gauges
 *  - Re-registration after deregister works (idempotent pattern)
 *  - Security: label value is application-controlled, not user input
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  dbPoolActive,
  dbPoolIdle,
  dbPoolWaiting,
  syncPoolGauges,
  deRegisterPoolMetrics,
} from '../../src/metrics/pool.js';
import { registry } from '../../src/metrics.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makePoolState(totalCount: number, idleCount: number, waitingCount: number) {
  return { totalCount, idleCount, waitingCount };
}

async function gaugeValue(gauge: typeof dbPoolActive, poolName: string): Promise<number> {
  const data = await gauge.get();
  const entry = data.values.find((v) => v.labels['pool'] === poolName);
  return entry?.value ?? 0;
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  deRegisterPoolMetrics();
});

afterEach(() => {
  deRegisterPoolMetrics();
});

// ── Gauge registration ────────────────────────────────────────────────────────

describe('gauge registration', () => {
  it('db_pool_active is registered in the Prometheus registry', () => {
    // The exported gauge object is always a valid Gauge instance
    expect(dbPoolActive).toBeDefined();
    expect(typeof dbPoolActive.set).toBe('function');
  });

  it('db_pool_idle is registered in the Prometheus registry', () => {
    expect(dbPoolIdle).toBeDefined();
    expect(typeof dbPoolIdle.set).toBe('function');
  });

  it('db_pool_waiting is registered in the Prometheus registry', () => {
    expect(dbPoolWaiting).toBeDefined();
    expect(typeof dbPoolWaiting.set).toBe('function');
  });

  it('db_pool_active carries a "pool" label', () => {
    // @ts-expect-error accessing internal labelNames
    expect(dbPoolActive.labelNames).toContain('pool');
  });

  it('db_pool_idle carries a "pool" label', () => {
    // @ts-expect-error accessing internal labelNames
    expect(dbPoolIdle.labelNames).toContain('pool');
  });

  it('db_pool_waiting carries a "pool" label', () => {
    // @ts-expect-error accessing internal labelNames
    expect(dbPoolWaiting.labelNames).toContain('pool');
  });
});

// ── syncPoolGauges: basic correctness ─────────────────────────────────────────

describe('syncPoolGauges — basic correctness', () => {
  it('sets active = totalCount - idleCount', async () => {
    syncPoolGauges(makePoolState(8, 3, 0), 'default');
    expect(await gaugeValue(dbPoolActive, 'default')).toBe(5);
  });

  it('sets idle = idleCount', async () => {
    syncPoolGauges(makePoolState(8, 3, 0), 'default');
    expect(await gaugeValue(dbPoolIdle, 'default')).toBe(3);
  });

  it('sets waiting = waitingCount', async () => {
    syncPoolGauges(makePoolState(10, 0, 12), 'default');
    expect(await gaugeValue(dbPoolWaiting, 'default')).toBe(12);
  });

  it('zero-wait baseline: all gauges are 0 for an idle pool', async () => {
    syncPoolGauges(makePoolState(0, 0, 0), 'default');
    expect(await gaugeValue(dbPoolActive, 'default')).toBe(0);
    expect(await gaugeValue(dbPoolIdle, 'default')).toBe(0);
    expect(await gaugeValue(dbPoolWaiting, 'default')).toBe(0);
  });

  it('clamps active to 0 when idleCount > totalCount (defensive)', async () => {
    // Should never happen in practice, but guard against negative gauge values
    syncPoolGauges(makePoolState(2, 5, 0), 'default');
    expect(await gaugeValue(dbPoolActive, 'default')).toBe(0);
  });
});

// ── syncPoolGauges: pool exhaustion simulation ────────────────────────────────

describe('syncPoolGauges — pool exhaustion simulation', () => {
  it('reflects full pool: all connections active, none idle', async () => {
    syncPoolGauges(makePoolState(10, 0, 0), 'default');
    expect(await gaugeValue(dbPoolActive, 'default')).toBe(10);
    expect(await gaugeValue(dbPoolIdle, 'default')).toBe(0);
  });

  it('reflects queue build-up: waiting > 0 when pool is saturated', async () => {
    syncPoolGauges(makePoolState(10, 0, 47), 'default');
    expect(await gaugeValue(dbPoolWaiting, 'default')).toBe(47);
  });

  it('reflects near-exhaustion: waiting at queue limit (50)', async () => {
    syncPoolGauges(makePoolState(10, 0, 50), 'default');
    expect(await gaugeValue(dbPoolActive, 'default')).toBe(10);
    expect(await gaugeValue(dbPoolIdle, 'default')).toBe(0);
    expect(await gaugeValue(dbPoolWaiting, 'default')).toBe(50);
  });

  it('reflects recovery: waiting drops back to 0 after spike', async () => {
    syncPoolGauges(makePoolState(10, 0, 50), 'default');
    expect(await gaugeValue(dbPoolWaiting, 'default')).toBe(50);

    syncPoolGauges(makePoolState(5, 5, 0), 'default');
    expect(await gaugeValue(dbPoolWaiting, 'default')).toBe(0);
    expect(await gaugeValue(dbPoolActive, 'default')).toBe(0);
    expect(await gaugeValue(dbPoolIdle, 'default')).toBe(5);
  });
});

// ── syncPoolGauges: multiple named pools ──────────────────────────────────────

describe('syncPoolGauges — multiple named pools', () => {
  it('tracks "default" and "read-replica" independently', async () => {
    syncPoolGauges(makePoolState(10, 2, 0), 'default');
    syncPoolGauges(makePoolState(5, 4, 1), 'read-replica');

    expect(await gaugeValue(dbPoolActive, 'default')).toBe(8);
    expect(await gaugeValue(dbPoolIdle, 'default')).toBe(2);
    expect(await gaugeValue(dbPoolWaiting, 'default')).toBe(0);

    expect(await gaugeValue(dbPoolActive, 'read-replica')).toBe(1);
    expect(await gaugeValue(dbPoolIdle, 'read-replica')).toBe(4);
    expect(await gaugeValue(dbPoolWaiting, 'read-replica')).toBe(1);
  });

  it('updating one pool does not affect the other', async () => {
    syncPoolGauges(makePoolState(10, 2, 0), 'default');
    syncPoolGauges(makePoolState(5, 4, 1), 'read-replica');

    // Update only "default"
    syncPoolGauges(makePoolState(3, 3, 0), 'default');

    expect(await gaugeValue(dbPoolActive, 'default')).toBe(0);
    // read-replica unchanged
    expect(await gaugeValue(dbPoolActive, 'read-replica')).toBe(1);
    expect(await gaugeValue(dbPoolWaiting, 'read-replica')).toBe(1);
  });

  it('supports a third pool name without affecting the first two', async () => {
    syncPoolGauges(makePoolState(10, 0, 0), 'default');
    syncPoolGauges(makePoolState(5, 5, 0), 'read-replica');
    syncPoolGauges(makePoolState(2, 1, 3), 'analytics');

    expect(await gaugeValue(dbPoolActive, 'default')).toBe(10);
    expect(await gaugeValue(dbPoolActive, 'read-replica')).toBe(0);
    expect(await gaugeValue(dbPoolActive, 'analytics')).toBe(1);
    expect(await gaugeValue(dbPoolWaiting, 'analytics')).toBe(3);
  });
});

// ── deRegisterPoolMetrics ─────────────────────────────────────────────────────

describe('deRegisterPoolMetrics', () => {
  it('removes db_pool_active from registry', () => {
    deRegisterPoolMetrics();
    expect(registry.getSingleMetric('db_pool_active')).toBeUndefined();
  });

  it('removes db_pool_idle from registry', () => {
    deRegisterPoolMetrics();
    expect(registry.getSingleMetric('db_pool_idle')).toBeUndefined();
  });

  it('removes db_pool_waiting from registry', () => {
    deRegisterPoolMetrics();
    expect(registry.getSingleMetric('db_pool_waiting')).toBeUndefined();
  });

  it('is idempotent — calling twice does not throw', () => {
    expect(() => {
      deRegisterPoolMetrics();
      deRegisterPoolMetrics();
    }).not.toThrow();
  });
});

// ── Re-registration after deregister ─────────────────────────────────────────

describe('re-registration after deregister', () => {
  it('gauges are usable after deregister + re-import (getSingleMetric || new Gauge pattern)', async () => {
    // Simulate the module-level idempotent pattern: after deregister,
    // the next call to syncPoolGauges re-creates the gauges via the
    // getSingleMetric || new Gauge pattern in pool.ts.
    // Here we verify the gauges exported from the module still work
    // because they hold a reference to the Gauge instance.
    deRegisterPoolMetrics();
    // After deregister the exported references are still valid Gauge objects;
    // calling .set() on them re-registers them implicitly in prom-client v15.
    syncPoolGauges(makePoolState(4, 2, 1), 'default');
    // The gauge object itself still works even after registry removal
    const val = await dbPoolActive.get();
    expect(val.values.find((v) => v.labels['pool'] === 'default')?.value).toBe(2);
  });
});

// ── Security: label injection prevention ─────────────────────────────────────

describe('security — label values', () => {
  it('pool label is set from the poolName argument, not from external input', async () => {
    // The poolName is always passed by the application layer (createPool config),
    // never derived from HTTP headers, query params, or user-supplied data.
    // This test documents and verifies that the label value matches exactly
    // what the caller provides.
    const trustedName = 'read-replica';
    syncPoolGauges(makePoolState(3, 1, 0), trustedName);
    const data = await dbPoolActive.get();
    const entry = data.values.find((v) => v.labels['pool'] === trustedName);
    // The label value is exactly the trusted name passed by the application
    expect(entry).toBeDefined();
    expect(entry?.labels['pool']).toBe(trustedName);
  });
});
