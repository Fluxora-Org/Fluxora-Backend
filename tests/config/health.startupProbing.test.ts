/**
 * Tiered Startup Dependency Probing — comprehensive test suite
 *
 * Covers:
 *  - probeStartupDependencies() exported API
 *  - Hard-tier (Postgres): fast-fail on first error, calls onProcessExit
 *  - Soft-tier (Redis, Stellar RPC): retry-with-backoff, degrades on budget exhaustion
 *  - Budget enforcement: soft probes stop retrying when budget is exhausted
 *  - Concurrent soft probes: multiple soft deps run in parallel
 *  - Logging: structured log events emitted at each stage
 *  - Error sanitisation: connection strings stripped from logged errors
 *  - New env-var defaults: startupProbeBudgetMs, startupProbePostgresTimeoutMs, etc.
 *  - Config defaults from EnvSchema
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  probeStartupDependencies,
  type StartupProbeConfig,
  type StartupProbeOptions,
  type StartupProbeResult,
} from '../../src/config/health.js';
import { loadConfig } from '../../src/config/env.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a probe that always resolves immediately. */
function makeSuccessProbe(name: string, tier: StartupProbeConfig['tier'] = 'soft'): StartupProbeConfig {
  return { name, tier, probe: vi.fn().mockResolvedValue(undefined) };
}

/**
 * Build a probe that fails `failCount` times then succeeds.
 * Returns a spy so callers can assert call count.
 */
function makeEventuallySuccessProbe(
  name: string,
  tier: StartupProbeConfig['tier'],
  failCount: number,
): { config: StartupProbeConfig; spy: ReturnType<typeof vi.fn<[], Promise<void>>> } {
  let calls = 0;
  const spy = vi.fn<[], Promise<void>>(async () => {
    calls++;
    if (calls <= failCount) throw new Error(`attempt ${calls} failed`);
  });
  return { config: { name, tier, probe: spy }, spy };
}

/** Build a probe that always rejects with the given error message. */
function makeFailProbe(
  name: string,
  tier: StartupProbeConfig['tier'],
  message = 'connection refused',
): StartupProbeConfig {
  return {
    name,
    tier,
    probe: vi.fn().mockRejectedValue(new Error(message)),
  };
}

/**
 * A never-resolving exit handler used as the `onProcessExit` test seam.
 * Returns a Promise<never> so TypeScript is satisfied and the probe call
 * doesn't continue after the exit handler is invoked.
 */
function makeExitCapture() {
  const calls: string[] = [];
  const handler = (reason: string): never => {
    calls.push(reason);
    throw new Error(`PROCESS_EXIT: ${reason}`);
  };
  return { calls, handler };
}

// ─── Hard-tier probes ─────────────────────────────────────────────────────────

describe('probeStartupDependencies — hard tier (fast-fail)', () => {
  it('returns a success result when the hard probe resolves', async () => {
    const probe = makeSuccessProbe('postgres', 'hard');
    const results = await probeStartupDependencies({ probes: [probe] });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject<Partial<StartupProbeResult>>({
      name: 'postgres',
      tier: 'hard',
      outcome: 'success',
      attempts: 1,
    });
    expect(results[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('calls onProcessExit (not retry) when the hard probe rejects', async () => {
    const { calls, handler } = makeExitCapture();
    const probe = makeFailProbe('postgres', 'hard', 'ECONNREFUSED');

    await expect(
      probeStartupDependencies({ probes: [probe], onProcessExit: handler }),
    ).rejects.toThrow('PROCESS_EXIT');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('postgres');
    expect(calls[0]).toContain('ECONNREFUSED');
    expect((probe.probe as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('includes the sanitised error in the exit reason (strips postgres:// URLs)', async () => {
    const { calls, handler } = makeExitCapture();
    const probe = makeFailProbe(
      'postgres',
      'hard',
      'connect ECONNREFUSED postgresql://user:secret@db.internal:5432/fluxora',
    );

    await expect(
      probeStartupDependencies({ probes: [probe], onProcessExit: handler }),
    ).rejects.toThrow('PROCESS_EXIT');

    expect(calls[0]).not.toContain('secret');
    expect(calls[0]).not.toContain('postgresql://');
    expect(calls[0]).toContain('[redacted');
  });

  it('only makes a single attempt for a hard probe', async () => {
    const { calls, handler } = makeExitCapture();
    const spy = vi.fn().mockRejectedValue(new Error('fail'));
    const probe: StartupProbeConfig = { name: 'postgres', tier: 'hard', probe: spy };

    await expect(
      probeStartupDependencies({ probes: [probe], onProcessExit: handler }),
    ).rejects.toThrow('PROCESS_EXIT');

    expect(spy.mock.calls).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('hard probe timeout fires when probe hangs', async () => {
    const { calls, handler } = makeExitCapture();
    const hangingProbe: StartupProbeConfig = {
      name: 'postgres',
      tier: 'hard',
      timeoutMs: 50,
      probe: vi.fn(() => new Promise<void>(() => { /* never resolves */ })),
    };

    await expect(
      probeStartupDependencies({ probes: [hangingProbe], onProcessExit: handler }),
    ).rejects.toThrow('PROCESS_EXIT');

    expect(calls[0]).toContain('timed out');
  });

  it('runs hard probes before soft probes', async () => {
    const order: string[] = [];
    const hard: StartupProbeConfig = {
      name: 'hard_dep',
      tier: 'hard',
      probe: vi.fn(async () => { order.push('hard'); }),
    };
    const soft: StartupProbeConfig = {
      name: 'soft_dep',
      tier: 'soft',
      probe: vi.fn(async () => { order.push('soft'); }),
    };

    // Interleave: soft first in array, hard second — hard should still run first
    await probeStartupDependencies({ probes: [soft, hard] });

    expect(order[0]).toBe('hard');
  });

  it('does not attempt soft probes when a hard probe fails', async () => {
    const { handler } = makeExitCapture();
    const softSpy = vi.fn().mockResolvedValue(undefined);
    const softProbe: StartupProbeConfig = { name: 'redis', tier: 'soft', probe: softSpy };
    const hardProbe = makeFailProbe('postgres', 'hard');

    await expect(
      probeStartupDependencies({
        probes: [hardProbe, softProbe],
        onProcessExit: handler,
      }),
    ).rejects.toThrow('PROCESS_EXIT');

    expect(softSpy.mock.calls).toHaveLength(0);
  });
});

// ─── Soft-tier probes ─────────────────────────────────────────────────────────

describe('probeStartupDependencies — soft tier (retry-with-backoff)', () => {
  it('returns success on first attempt when probe resolves immediately', async () => {
    const probe = makeSuccessProbe('redis', 'soft');
    const results = await probeStartupDependencies({
      probes: [probe],
      budgetMs: 5_000,
      baseRetryMs: 1,
      maxRetryMs: 10,
    });

    expect(results[0]).toMatchObject<Partial<StartupProbeResult>>({
      name: 'redis',
      tier: 'soft',
      outcome: 'success',
      attempts: 1,
    });
  });

  it('retries a soft probe that fails and eventually succeeds', async () => {
    const { config: probe, spy } = makeEventuallySuccessProbe('redis', 'soft', 2);

    const results = await probeStartupDependencies({
      probes: [probe],
      budgetMs: 30_000,
      baseRetryMs: 1,
      maxRetryMs: 5,
    });

    expect(results[0]).toMatchObject<Partial<StartupProbeResult>>({
      name: 'redis',
      tier: 'soft',
      outcome: 'success',
    });
    expect(results[0]!.attempts).toBeGreaterThanOrEqual(3);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('marks outcome as degraded when budget is exhausted', async () => {
    // Zero budget so no retries are possible after the first failure
    const probe = makeFailProbe('redis', 'soft', 'connection refused');

    const results = await probeStartupDependencies({
      probes: [probe],
      budgetMs: 1, // exhausted immediately
      baseRetryMs: 1,
      maxRetryMs: 5,
    });

    expect(results[0]).toMatchObject<Partial<StartupProbeResult>>({
      name: 'redis',
      tier: 'soft',
      outcome: 'degraded',
    });
    expect(results[0]!.error).toBeDefined();
  });

  it('does NOT call onProcessExit for a degraded soft probe', async () => {
    const { calls, handler } = makeExitCapture();
    const probe = makeFailProbe('stellar_rpc', 'soft');

    // Should resolve (not throw) even though the probe degrades
    const results = await probeStartupDependencies({
      probes: [probe],
      budgetMs: 1,
      onProcessExit: handler,
      baseRetryMs: 1,
      maxRetryMs: 5,
    });

    expect(results[0]!.outcome).toBe('degraded');
    expect(calls).toHaveLength(0);
  });

  it('sanitises the last error message for degraded soft probes', async () => {
    const probe = makeFailProbe(
      'redis',
      'soft',
      'connect ECONNREFUSED redis://admin:secret@cache.internal:6379',
    );

    const results = await probeStartupDependencies({
      probes: [probe],
      budgetMs: 1,
      baseRetryMs: 1,
      maxRetryMs: 5,
    });

    expect(results[0]!.error).not.toContain('secret');
    expect(results[0]!.error).not.toContain('redis://');
  });

  it('soft probe timeout fires per attempt when probe hangs', async () => {
    let attempts = 0;
    const hangingProbe: StartupProbeConfig = {
      name: 'redis',
      tier: 'soft',
      timeoutMs: 30,
      probe: vi.fn(async () => {
        attempts++;
        await new Promise<void>(() => { /* never resolves */ });
      }),
    };

    const results = await probeStartupDependencies({
      probes: [hangingProbe],
      budgetMs: 120, // enough for ~1-2 attempts at 30 ms each
      baseRetryMs: 1,
      maxRetryMs: 5,
    });

    expect(results[0]!.outcome).toBe('degraded');
    expect(results[0]!.error).toContain('timed out');
    expect(attempts).toBeGreaterThanOrEqual(1);
  });
});

// ─── Budget enforcement ───────────────────────────────────────────────────────

describe('probeStartupDependencies — budget enforcement', () => {
  it('stops retrying after budget is consumed and returns degraded', async () => {
    let callCount = 0;
    const probe: StartupProbeConfig = {
      name: 'redis',
      tier: 'soft',
      timeoutMs: 10,
      probe: vi.fn(async () => {
        callCount++;
        throw new Error('always fails');
      }),
    };

    const start = Date.now();
    const results = await probeStartupDependencies({
      probes: [probe],
      budgetMs: 100,
      baseRetryMs: 1,
      maxRetryMs: 5,
    });
    const elapsed = Date.now() - start;

    expect(results[0]!.outcome).toBe('degraded');
    // Should not have spent significantly more than the budget
    expect(elapsed).toBeLessThan(1_000);
    // At least one attempt was made
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it('returns latencyMs and attempts in the degraded result', async () => {
    const probe = makeFailProbe('redis', 'soft');

    const results = await probeStartupDependencies({
      probes: [probe],
      budgetMs: 1,
      baseRetryMs: 1,
      maxRetryMs: 5,
    });

    expect(typeof results[0]!.latencyMs).toBe('number');
    expect(results[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof results[0]!.attempts).toBe('number');
    expect(results[0]!.attempts).toBeGreaterThanOrEqual(1);
  });
});

// ─── Concurrent soft probes ───────────────────────────────────────────────────

describe('probeStartupDependencies — concurrent soft probes', () => {
  it('runs multiple soft probes in parallel and returns all results', async () => {
    const redis = makeSuccessProbe('redis', 'soft');
    const stellar = makeSuccessProbe('stellar_rpc', 'soft');

    const results = await probeStartupDependencies({
      probes: [redis, stellar],
      budgetMs: 5_000,
      baseRetryMs: 1,
      maxRetryMs: 10,
    });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name)).toContain('redis');
    expect(results.map((r) => r.name)).toContain('stellar_rpc');
    expect(results.every((r) => r.outcome === 'success')).toBe(true);
  });

  it('returns degraded for one soft dep and success for another independently', async () => {
    const successProbe = makeSuccessProbe('redis', 'soft');
    const failProbe = makeFailProbe('stellar_rpc', 'soft');

    const results = await probeStartupDependencies({
      probes: [successProbe, failProbe],
      budgetMs: 1,
      baseRetryMs: 1,
      maxRetryMs: 5,
    });

    const redis = results.find((r) => r.name === 'redis')!;
    const stellar = results.find((r) => r.name === 'stellar_rpc')!;

    expect(redis.outcome).toBe('success');
    expect(stellar.outcome).toBe('degraded');
  });

  it('hard+soft mix: hard success followed by both soft results', async () => {
    const hard = makeSuccessProbe('postgres', 'hard');
    const soft1 = makeSuccessProbe('redis', 'soft');
    const soft2 = makeSuccessProbe('stellar_rpc', 'soft');

    const results = await probeStartupDependencies({
      probes: [hard, soft1, soft2],
      budgetMs: 5_000,
      baseRetryMs: 1,
      maxRetryMs: 10,
    });

    expect(results).toHaveLength(3);
    expect(results.find((r) => r.name === 'postgres')?.outcome).toBe('success');
    expect(results.find((r) => r.name === 'redis')?.outcome).toBe('success');
    expect(results.find((r) => r.name === 'stellar_rpc')?.outcome).toBe('success');
  });

  it('total wall-clock time for concurrent soft probes is less than sequential sum', async () => {
    const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

    // Each probe takes ~50 ms. Sequentially that is ~100 ms; concurrently ~50 ms.
    const probe1: StartupProbeConfig = { name: 'redis', tier: 'soft', probe: vi.fn(() => delay(50)) };
    const probe2: StartupProbeConfig = { name: 'stellar_rpc', tier: 'soft', probe: vi.fn(() => delay(50)) };

    const start = Date.now();
    await probeStartupDependencies({ probes: [probe1, probe2], budgetMs: 5_000, baseRetryMs: 1, maxRetryMs: 10 });
    const elapsed = Date.now() - start;

    // Concurrent execution should finish in well under 90 ms (not ~100 ms serial)
    expect(elapsed).toBeLessThan(90);
  });
});

// ─── Return shape ─────────────────────────────────────────────────────────────

describe('probeStartupDependencies — return shape', () => {
  it('returns an empty array when no probes are provided', async () => {
    const results = await probeStartupDependencies({ probes: [] });
    expect(results).toEqual([]);
  });

  it('each result includes name, tier, outcome, attempts, latencyMs', async () => {
    const probe = makeSuccessProbe('redis', 'soft');
    const results = await probeStartupDependencies({ probes: [probe], budgetMs: 5_000, baseRetryMs: 1, maxRetryMs: 10 });

    const r = results[0]!;
    expect(typeof r.name).toBe('string');
    expect(r.tier).toMatch(/^(hard|soft)$/);
    expect(r.outcome).toMatch(/^(success|degraded)$/);
    expect(typeof r.attempts).toBe('number');
    expect(typeof r.latencyMs).toBe('number');
  });

  it('error field is absent on success', async () => {
    const probe = makeSuccessProbe('redis', 'soft');
    const results = await probeStartupDependencies({ probes: [probe], budgetMs: 5_000, baseRetryMs: 1, maxRetryMs: 10 });
    expect(results[0]!.error).toBeUndefined();
  });

  it('error field is present and sanitised on degraded', async () => {
    const probe = makeFailProbe('redis', 'soft', 'redis://user:pass@host:6379 timeout');
    const results = await probeStartupDependencies({ probes: [probe], budgetMs: 1, baseRetryMs: 1, maxRetryMs: 5 });
    expect(results[0]!.error).toBeDefined();
    expect(results[0]!.error).not.toContain('pass');
    expect(results[0]!.error).not.toContain('redis://');
  });

  it('results preserve insertion order: hard probes first, then soft probes', async () => {
    const soft1 = makeSuccessProbe('redis', 'soft');
    const soft2 = makeSuccessProbe('stellar_rpc', 'soft');
    const hard = makeSuccessProbe('postgres', 'hard');

    // Pass soft before hard in the array — hard should still appear first in results
    const results = await probeStartupDependencies({
      probes: [soft1, hard, soft2],
      budgetMs: 5_000,
      baseRetryMs: 1,
      maxRetryMs: 10,
    });

    expect(results[0]!.name).toBe('postgres');
  });
});

// ─── Logging behaviour ────────────────────────────────────────────────────────

describe('probeStartupDependencies — structured logging', () => {
  it('logs startup_probe:begin with dependency list', async () => {
    const infoSpy = vi.spyOn(
      await import('../../src/lib/logger.js').then((m) => m.logger),
      'info',
    );

    const probe = makeSuccessProbe('redis', 'soft');
    await probeStartupDependencies({ probes: [probe], budgetMs: 5_000, baseRetryMs: 1, maxRetryMs: 10 });

    const beginCall = infoSpy.mock.calls.find(([msg]) => msg === 'startup_probe:begin');
    expect(beginCall).toBeDefined();
    // Third argument is the meta object
    expect(beginCall![2]).toMatchObject({ dependencies: expect.any(Array) });

    infoSpy.mockRestore();
  });

  it('logs startup_probe:attempt with tier and dependency name', async () => {
    const infoSpy = vi.spyOn(
      await import('../../src/lib/logger.js').then((m) => m.logger),
      'info',
    );

    const probe = makeSuccessProbe('postgres', 'hard');
    await probeStartupDependencies({ probes: [probe] });

    const attemptCall = infoSpy.mock.calls.find(([msg]) => msg === 'startup_probe:attempt');
    expect(attemptCall).toBeDefined();
    expect(attemptCall![2]).toMatchObject({ dependency: 'postgres', tier: 'hard', attempt: 1 });

    infoSpy.mockRestore();
  });

  it('logs startup_probe:success on a passing probe', async () => {
    const infoSpy = vi.spyOn(
      await import('../../src/lib/logger.js').then((m) => m.logger),
      'info',
    );

    const probe = makeSuccessProbe('postgres', 'hard');
    await probeStartupDependencies({ probes: [probe] });

    const successCall = infoSpy.mock.calls.find(([msg]) => msg === 'startup_probe:success');
    expect(successCall).toBeDefined();
    expect(successCall![2]).toMatchObject({ outcome: 'success', dependency: 'postgres' });

    infoSpy.mockRestore();
  });

  it('logs startup_probe:retry (warn) on a soft probe failure before retry', async () => {
    const warnSpy = vi.spyOn(
      await import('../../src/lib/logger.js').then((m) => m.logger),
      'warn',
    );

    const { config: probe } = makeEventuallySuccessProbe('redis', 'soft', 1);
    await probeStartupDependencies({ probes: [probe], budgetMs: 10_000, baseRetryMs: 1, maxRetryMs: 5 });

    const retryCall = warnSpy.mock.calls.find(([msg]) => msg === 'startup_probe:retry');
    expect(retryCall).toBeDefined();
    expect(retryCall![2]).toMatchObject({ dependency: 'redis', tier: 'soft', outcome: 'retry' });

    warnSpy.mockRestore();
  });

  it('logs startup_probe:degraded (warn) when soft probe budget is exhausted', async () => {
    const warnSpy = vi.spyOn(
      await import('../../src/lib/logger.js').then((m) => m.logger),
      'warn',
    );

    const probe = makeFailProbe('redis', 'soft');
    await probeStartupDependencies({ probes: [probe], budgetMs: 1, baseRetryMs: 1, maxRetryMs: 5 });

    const degradedCall = warnSpy.mock.calls.find(([msg]) => msg === 'startup_probe:degraded');
    expect(degradedCall).toBeDefined();
    expect(degradedCall![2]).toMatchObject({ dependency: 'redis', outcome: 'degraded' });

    warnSpy.mockRestore();
  });

  it('logs startup_probe:fatal (error) when hard probe fails', async () => {
    const errorSpy = vi.spyOn(
      await import('../../src/lib/logger.js').then((m) => m.logger),
      'error',
    );

    const { handler } = makeExitCapture();
    const probe = makeFailProbe('postgres', 'hard');

    await expect(
      probeStartupDependencies({ probes: [probe], onProcessExit: handler }),
    ).rejects.toThrow('PROCESS_EXIT');

    const fatalCall = errorSpy.mock.calls.find(([msg]) => msg === 'startup_probe:fatal');
    expect(fatalCall).toBeDefined();
    expect(fatalCall![2]).toMatchObject({ dependency: 'postgres', outcome: 'fatal' });

    errorSpy.mockRestore();
  });

  it('logs startup_probe:complete with outcome summary', async () => {
    const infoSpy = vi.spyOn(
      await import('../../src/lib/logger.js').then((m) => m.logger),
      'info',
    );

    const probe = makeSuccessProbe('redis', 'soft');
    await probeStartupDependencies({ probes: [probe], budgetMs: 5_000, baseRetryMs: 1, maxRetryMs: 10 });

    const completeCall = infoSpy.mock.calls.find(([msg]) => msg === 'startup_probe:complete');
    expect(completeCall).toBeDefined();
    expect(completeCall![2]).toMatchObject({ outcome: 'healthy', degradedDependencies: [] });

    infoSpy.mockRestore();
  });

  it('logs startup_probe:complete with degraded list when a soft dep fails', async () => {
    const infoSpy = vi.spyOn(
      await import('../../src/lib/logger.js').then((m) => m.logger),
      'info',
    );

    const probe = makeFailProbe('stellar_rpc', 'soft');
    await probeStartupDependencies({ probes: [probe], budgetMs: 1, baseRetryMs: 1, maxRetryMs: 5 });

    const completeCall = infoSpy.mock.calls.find(([msg]) => msg === 'startup_probe:complete');
    expect(completeCall).toBeDefined();
    expect(completeCall![2]).toMatchObject({
      outcome: 'degraded',
      degradedDependencies: ['stellar_rpc'],
    });

    infoSpy.mockRestore();
  });
});

// ─── Env-var config defaults ──────────────────────────────────────────────────

describe('Startup probe env-var configuration defaults', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('startupProbeBudgetMs defaults to 30 000 ms', () => {
    delete process.env.STARTUP_PROBE_BUDGET_MS;
    const cfg = loadConfig();
    expect(cfg.startupProbeBudgetMs).toBe(30_000);
  });

  it('startupProbePostgresTimeoutMs defaults to 5 000 ms', () => {
    delete process.env.STARTUP_PROBE_POSTGRES_TIMEOUT_MS;
    const cfg = loadConfig();
    expect(cfg.startupProbePostgresTimeoutMs).toBe(5_000);
  });

  it('startupProbeRedisTimeoutMs defaults to 3 000 ms', () => {
    delete process.env.STARTUP_PROBE_REDIS_TIMEOUT_MS;
    const cfg = loadConfig();
    expect(cfg.startupProbeRedisTimeoutMs).toBe(3_000);
  });

  it('startupProbeStellarTimeoutMs defaults to 5 000 ms', () => {
    delete process.env.STARTUP_PROBE_STELLAR_TIMEOUT_MS;
    const cfg = loadConfig();
    expect(cfg.startupProbeStellarTimeoutMs).toBe(5_000);
  });

  it('reads STARTUP_PROBE_BUDGET_MS from env', () => {
    process.env.STARTUP_PROBE_BUDGET_MS = '60000';
    const cfg = loadConfig();
    expect(cfg.startupProbeBudgetMs).toBe(60_000);
  });

  it('reads STARTUP_PROBE_POSTGRES_TIMEOUT_MS from env', () => {
    process.env.STARTUP_PROBE_POSTGRES_TIMEOUT_MS = '2000';
    const cfg = loadConfig();
    expect(cfg.startupProbePostgresTimeoutMs).toBe(2_000);
  });

  it('reads STARTUP_PROBE_REDIS_TIMEOUT_MS from env', () => {
    process.env.STARTUP_PROBE_REDIS_TIMEOUT_MS = '1500';
    const cfg = loadConfig();
    expect(cfg.startupProbeRedisTimeoutMs).toBe(1_500);
  });

  it('reads STARTUP_PROBE_STELLAR_TIMEOUT_MS from env', () => {
    process.env.STARTUP_PROBE_STELLAR_TIMEOUT_MS = '8000';
    const cfg = loadConfig();
    expect(cfg.startupProbeStellarTimeoutMs).toBe(8_000);
  });

  it('rejects STARTUP_PROBE_BUDGET_MS = 0 (minimum is 1)', () => {
    process.env.STARTUP_PROBE_BUDGET_MS = '0';
    expect(() => loadConfig()).toThrow();
  });

  it('rejects STARTUP_PROBE_POSTGRES_TIMEOUT_MS = 0 (minimum is 1)', () => {
    process.env.STARTUP_PROBE_POSTGRES_TIMEOUT_MS = '0';
    expect(() => loadConfig()).toThrow();
  });

  it('rejects STARTUP_PROBE_REDIS_TIMEOUT_MS = 0 (minimum is 1)', () => {
    process.env.STARTUP_PROBE_REDIS_TIMEOUT_MS = '0';
    expect(() => loadConfig()).toThrow();
  });

  it('rejects STARTUP_PROBE_STELLAR_TIMEOUT_MS = 0 (minimum is 1)', () => {
    process.env.STARTUP_PROBE_STELLAR_TIMEOUT_MS = '0';
    expect(() => loadConfig()).toThrow();
  });
});

// ─── Security: credential sanitisation ────────────────────────────────────────

describe('probeStartupDependencies — security: credential sanitisation', () => {
  it('strips redis:// URLs from error messages in degraded results', async () => {
    const probe = makeFailProbe(
      'redis',
      'soft',
      'Failed to connect redis://admin:hunter2@cache.prod:6379/0',
    );
    const results = await probeStartupDependencies({
      probes: [probe],
      budgetMs: 1,
      baseRetryMs: 1,
      maxRetryMs: 5,
    });
    expect(results[0]!.error).toBeDefined();
    expect(results[0]!.error).not.toContain('hunter2');
    expect(results[0]!.error).not.toContain('redis://');
    expect(results[0]!.error).not.toContain('cache.prod');
  });

  it('strips postgresql:// URLs from error messages in hard-fail exit reason', async () => {
    const { calls, handler } = makeExitCapture();
    const probe = makeFailProbe(
      'postgres',
      'hard',
      'postgresql://pguser:mysecret@db.prod.internal:5432/fluxora refused',
    );

    await expect(
      probeStartupDependencies({ probes: [probe], onProcessExit: handler }),
    ).rejects.toThrow('PROCESS_EXIT');

    expect(calls[0]).not.toContain('mysecret');
    expect(calls[0]).not.toContain('postgresql://');
    expect(calls[0]).not.toContain('db.prod.internal');
    expect(calls[0]).toContain('[redacted');
  });

  it('strips user:password@host credentials from error messages', async () => {
    const probe = makeFailProbe(
      'redis',
      'soft',
      'Error: connect to admin:password@redis-primary.internal failed',
    );
    const results = await probeStartupDependencies({
      probes: [probe],
      budgetMs: 1,
      baseRetryMs: 1,
      maxRetryMs: 5,
    });
    expect(results[0]!.error).not.toContain('password');
    expect(results[0]!.error).toContain('[redacted');
  });

  it('does not redact non-credential error messages', async () => {
    const probe = makeFailProbe('redis', 'soft', 'Connection timed out after 3000ms');
    const results = await probeStartupDependencies({
      probes: [probe],
      budgetMs: 1,
      baseRetryMs: 1,
      maxRetryMs: 5,
    });
    expect(results[0]!.error).toContain('timed out');
    expect(results[0]!.error).toContain('3000ms');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('probeStartupDependencies — edge cases', () => {
  it('handles a mix of multiple hard probes (all pass)', async () => {
    const hard1 = makeSuccessProbe('postgres', 'hard');
    const hard2 = makeSuccessProbe('pg_replica', 'hard');

    const results = await probeStartupDependencies({ probes: [hard1, hard2] });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.outcome === 'success')).toBe(true);
  });

  it('stops on the first failing hard probe (second hard probe not attempted)', async () => {
    const { handler } = makeExitCapture();
    const fail = makeFailProbe('postgres', 'hard');
    const spy = vi.fn().mockResolvedValue(undefined);
    const second: StartupProbeConfig = { name: 'pg_replica', tier: 'hard', probe: spy };

    await expect(
      probeStartupDependencies({ probes: [fail, second], onProcessExit: handler }),
    ).rejects.toThrow('PROCESS_EXIT');

    expect(spy.mock.calls).toHaveLength(0);
  });

  it('probe with timeoutMs = undefined uses the default 5 000 ms timeout', async () => {
    // The probe resolves before the default timeout — just verify it works
    const probe: StartupProbeConfig = {
      name: 'postgres',
      tier: 'hard',
      // timeoutMs intentionally omitted
      probe: vi.fn().mockResolvedValue(undefined),
    };
    const results = await probeStartupDependencies({ probes: [probe] });
    expect(results[0]!.outcome).toBe('success');
  });

  it('zero soft probes with one hard success returns single-element array', async () => {
    const hard = makeSuccessProbe('postgres', 'hard');
    const results = await probeStartupDependencies({ probes: [hard] });
    expect(results).toHaveLength(1);
    expect(results[0]!.tier).toBe('hard');
  });

  it('handles a probe that throws a non-Error object', async () => {
    const probe: StartupProbeConfig = {
      name: 'redis',
      tier: 'soft',
      probe: vi.fn(async () => { throw 'string error'; }),
    };
    const results = await probeStartupDependencies({
      probes: [probe],
      budgetMs: 1,
      baseRetryMs: 1,
      maxRetryMs: 5,
    });
    expect(results[0]!.outcome).toBe('degraded');
    expect(typeof results[0]!.error).toBe('string');
  });
});
