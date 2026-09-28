
import { describe, it, expect, vi } from 'vitest';
import { probeStartupDependencies } from '../src/config/health.js';

describe('startup dependency outage behaviour', () => {
  it('fails fast when Postgres, the hard dependency, is unavailable', async () => {
    const onProcessExit = vi.fn((reason: string): never => {
      throw new Error(reason);
    });

    await expect(
      probeStartupDependencies({
        probes: [
          {
            name: 'postgres',
            tier: 'hard',
            probe: async () => {
              throw new Error('Connection refused');
            },
          },
          {
            name: 'redis',
            tier: 'soft',
            probe: async () => undefined,
          },
        ],
        onProcessExit,
      }),
    ).rejects.toThrow('Hard dependency "postgres" failed startup probe');

    expect(onProcessExit).toHaveBeenCalledTimes(1);
    expect(onProcessExit).toHaveBeenCalledWith(
      expect.stringContaining('Hard dependency "postgres" failed startup probe'),
    );
  });

  it('continues startup in degraded mode when Redis is unavailable', async () => {
    let attempts = 0;

    const results = await probeStartupDependencies({
      probes: [
        {
          name: 'postgres',
          tier: 'hard',
          probe: async () => undefined,
        },
        {
          name: 'redis',
          tier: 'soft',
          probe: async () => {
            attempts += 1;
            throw new Error('ECONNREFUSED');
          },
        },
      ],
      budgetMs: 20,
      baseRetryMs: 1,
      maxRetryMs: 2,
    });

    const redis = results.find((result) => result.name === 'redis');

    expect(redis).toBeDefined();
    expect(redis?.tier).toBe('soft');
    expect(redis?.outcome).toBe('degraded');
    expect(redis?.attempts).toBeGreaterThan(0);
    expect(attempts).toBe(redis?.attempts);
  });

  it('continues startup in degraded mode when Stellar RPC is unavailable', async () => {
    let attempts = 0;

    const results = await probeStartupDependencies({
      probes: [
        {
          name: 'postgres',
          tier: 'hard',
          probe: async () => undefined,
        },
        {
          name: 'stellar_rpc',
          tier: 'soft',
          probe: async () => {
            attempts += 1;
            throw new Error('RPC unavailable');
          },
        },
      ],
      budgetMs: 20,
      baseRetryMs: 1,
      maxRetryMs: 2,
    });

    const rpc = results.find((result) => result.name === 'stellar_rpc');

    expect(rpc).toBeDefined();
    expect(rpc?.tier).toBe('soft');
    expect(rpc?.outcome).toBe('degraded');
    expect(rpc?.attempts).toBeGreaterThan(0);
    expect(attempts).toBe(rpc?.attempts);
  });

  it('automatically recovers when an unavailable soft dependency returns', async () => {
    let available = false;

    const firstResults = await probeStartupDependencies({
      probes: [
        {
          name: 'postgres',
          tier: 'hard',
          probe: async () => undefined,
        },
        {
          name: 'redis',
          tier: 'soft',
          probe: async () => {
            if (!available) {
              throw new Error('Redis unavailable');
            }
          },
        },
      ],
      budgetMs: 20,
      baseRetryMs: 1,
      maxRetryMs: 2,
    });

    expect(firstResults.find((result) => result.name === 'redis')?.outcome).toBe(
      'degraded',
    );

    available = true;

    const recoveredResults = await probeStartupDependencies({
      probes: [
        {
          name: 'postgres',
          tier: 'hard',
          probe: async () => undefined,
        },
        {
          name: 'redis',
          tier: 'soft',
          probe: async () => undefined,
        },
      ],
      budgetMs: 20,
      baseRetryMs: 1,
      maxRetryMs: 2,
    });

    expect(
      recoveredResults.find((result) => result.name === 'redis')?.outcome,
    ).toBe('success');
  });
});

