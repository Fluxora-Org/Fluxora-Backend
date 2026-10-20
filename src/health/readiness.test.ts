import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_READINESS_GRACE_PERIOD_MS,
  assessReadiness,
  checkInstanceReadiness,
} from './readiness.js';
import type {
  DependencyHealth,
  HealthCheckManager,
  HealthReport,
  HealthStatus,
} from '../config/health.js';

// A fixed instant so no assertion depends on the wall clock. `assessReadiness`
// is pure, so every test injects `now` explicitly (except the one that proves
// the `Date.now()` default, which uses fake timers).
const NOW = Date.parse('2024-06-01T12:00:00.000Z');
const CHECKED_AT = '2024-06-01T11:59:59.000Z';
const SECOND = 1_000;
const GRACE = DEFAULT_READINESS_GRACE_PERIOD_MS;

function dependency(
  name: string,
  status: HealthStatus,
  degradedSince?: string,
): DependencyHealth {
  return {
    name,
    status,
    lastChecked: CHECKED_AT,
    ...(degradedSince === undefined ? {} : { degradedSince }),
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function makeReport(
  status: HealthStatus,
  dependencies: DependencyHealth[] = [],
  uptime = 60,
): HealthReport {
  return {
    status,
    version: '0.1.0',
    timestamp: CHECKED_AT,
    uptime,
    dependencies,
  };
}

describe('DEFAULT_READINESS_GRACE_PERIOD_MS', () => {
  it('is the documented 30 seconds', () => {
    expect(DEFAULT_READINESS_GRACE_PERIOD_MS).toBe(30_000);
  });
});

describe('assessReadiness — healthy reports', () => {
  it('marks a healthy report with no dependencies as ready', () => {
    const assessment = assessReadiness(makeReport('healthy'), { now: NOW });

    expect(assessment).toEqual({
      ready: true,
      status: 'healthy',
      dependencies: {},
      blocking: [],
    });
    // Ready assessments never carry a reason.
    expect(assessment.reason).toBeUndefined();
  });

  it('flattens every dependency status into the shared map', () => {
    const report = makeReport('healthy', [
      dependency('postgres', 'healthy'),
      dependency('redis', 'healthy'),
      dependency('stellar_rpc', 'healthy'),
    ]);

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.ready).toBe(true);
    expect(assessment.status).toBe('healthy');
    expect(assessment.dependencies).toEqual({
      postgres: 'healthy',
      redis: 'healthy',
      stellar_rpc: 'healthy',
    });
    expect(assessment.blocking).toEqual([]);
  });

  it('is ready regardless of degradedSince values on healthy dependencies', () => {
    const report = makeReport('healthy', [
      dependency('postgres', 'healthy', iso(NOW - 10 * GRACE)),
      dependency('redis', 'healthy', 'not-a-date'),
    ]);

    expect(assessReadiness(report, { now: NOW }).ready).toBe(true);
  });
});

describe('assessReadiness — unhealthy reports', () => {
  it('is not ready when the aggregate status is unhealthy', () => {
    const report = makeReport('unhealthy', [dependency('postgres', 'unhealthy')]);

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment).toEqual({
      ready: false,
      status: 'unhealthy',
      dependencies: { postgres: 'unhealthy' },
      blocking: ['postgres'],
      reason: 'unhealthy',
    });
  });

  it('blocks only the unhealthy dependencies, not healthy or degraded ones', () => {
    const report = makeReport('unhealthy', [
      dependency('postgres', 'healthy'),
      dependency('redis', 'unhealthy'),
      dependency('stellar_rpc', 'degraded', iso(NOW - 10 * GRACE)),
      dependency('rpc_backup', 'unhealthy'),
    ]);

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.ready).toBe(false);
    expect(assessment.reason).toBe('unhealthy');
    expect(assessment.blocking).toEqual(['redis', 'rpc_backup']);
    expect(assessment.dependencies).toEqual({
      postgres: 'healthy',
      redis: 'unhealthy',
      stellar_rpc: 'degraded',
      rpc_backup: 'unhealthy',
    });
  });

  it('is not ready for an unhealthy report with no dependencies (empty boundary)', () => {
    const assessment = assessReadiness(makeReport('unhealthy'), { now: NOW });

    expect(assessment.ready).toBe(false);
    expect(assessment.reason).toBe('unhealthy');
    expect(assessment.blocking).toEqual([]);
    expect(assessment.dependencies).toEqual({});
  });

  it('reports unhealthy ahead of starting phase when uptime is zero', () => {
    const report = makeReport('unhealthy', [dependency('postgres', 'unhealthy')], 0);

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.reason).toBe('unhealthy');
  });
});

describe('assessReadiness — degraded during startup', () => {
  it('is not ready during startup even when the degradation is older than the grace period', () => {
    const report = makeReport(
      'degraded',
      [dependency('redis', 'degraded', iso(NOW - 10 * GRACE))],
      5,
    );

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.ready).toBe(false);
    expect(assessment.reason).toBe('degraded_during_startup');
    expect(assessment.blocking).toEqual(['redis']);
    expect(assessment.dependencies).toEqual({ redis: 'degraded' });
  });

  it('blocks all degraded dependencies during startup and ignores healthy ones', () => {
    const report = makeReport(
      'degraded',
      [
        dependency('postgres', 'healthy'),
        dependency('redis', 'degraded', iso(NOW - GRACE)),
        dependency('stellar_rpc', 'degraded'),
      ],
      0,
    );

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.reason).toBe('degraded_during_startup');
    expect(assessment.blocking).toEqual(['redis', 'stellar_rpc']);
  });

  it('is not ready for a degraded report with no dependencies in startup (empty boundary)', () => {
    const assessment = assessReadiness(makeReport('degraded', [], 0), { now: NOW });

    expect(assessment.ready).toBe(false);
    expect(assessment.reason).toBe('degraded_during_startup');
    expect(assessment.blocking).toEqual([]);
  });

  it('stays in startup just below the grace boundary', () => {
    // uptime is reported in whole seconds, so 1s is 1000ms < 1001ms.
    const report = makeReport(
      'degraded',
      [dependency('redis', 'degraded', iso(NOW))],
      1,
    );

    const assessment = assessReadiness(report, { now: NOW, gracePeriodMs: 1_001 });

    expect(assessment.reason).toBe('degraded_during_startup');
  });

  it('treats uptime exactly equal to the grace boundary as steady state', () => {
    // 1s uptime === 1000ms grace → the startup gate no longer applies and the
    // freshly degraded dependency is tolerated.
    const report = makeReport(
      'degraded',
      [dependency('redis', 'degraded', iso(NOW))],
      1,
    );

    const assessment = assessReadiness(report, { now: NOW, gracePeriodMs: SECOND });

    expect(assessment).toEqual({
      ready: true,
      status: 'degraded',
      dependencies: { redis: 'degraded' },
      blocking: [],
    });
  });
});

describe('assessReadiness — degraded in steady state', () => {
  it('tolerates a degradation younger than the grace period', () => {
    const report = makeReport(
      'degraded',
      [dependency('redis', 'degraded', iso(NOW - (GRACE - 1)))],
    );

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.ready).toBe(true);
    expect(assessment.status).toBe('degraded');
    expect(assessment.blocking).toEqual([]);
  });

  it('drains the instance when a degradation has lasted exactly the grace period', () => {
    const report = makeReport(
      'degraded',
      [dependency('redis', 'degraded', iso(NOW - GRACE))],
    );

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.ready).toBe(false);
    expect(assessment.reason).toBe('degraded_past_grace');
    expect(assessment.blocking).toEqual(['redis']);
  });

  it('drains the instance once a degradation is older than the grace period', () => {
    const report = makeReport(
      'degraded',
      [dependency('redis', 'degraded', iso(NOW - GRACE - 1))],
    );

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.ready).toBe(false);
    expect(assessment.reason).toBe('degraded_past_grace');
    expect(assessment.dependencies).toEqual({ redis: 'degraded' });
  });

  it('blocks only stale dependencies in a mixed report', () => {
    const report = makeReport('degraded', [
      dependency('postgres', 'healthy'),
      dependency('redis', 'degraded', iso(NOW - GRACE)),
      dependency('stellar_rpc', 'degraded', iso(NOW - (GRACE - 1))),
      dependency('cache', 'degraded'),
      dependency('rpc_backup', 'degraded', 'not-a-date'),
    ]);

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.ready).toBe(false);
    expect(assessment.reason).toBe('degraded_past_grace');
    expect(assessment.blocking).toEqual(['redis']);
    expect(assessment.dependencies).toEqual({
      postgres: 'healthy',
      redis: 'degraded',
      stellar_rpc: 'degraded',
      cache: 'degraded',
      rpc_backup: 'degraded',
    });
  });

  it('tolerates a degraded dependency with no degradedSince timestamp', () => {
    const report = makeReport('degraded', [dependency('redis', 'degraded')]);

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.ready).toBe(true);
    expect(assessment.blocking).toEqual([]);
  });

  it('tolerates a degraded dependency whose degradedSince cannot be parsed', () => {
    const report = makeReport('degraded', [
      dependency('redis', 'degraded', 'not-a-date'),
    ]);

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.ready).toBe(true);
  });

  it('tolerates a degradedSince timestamp in the future (negative elapsed time)', () => {
    const report = makeReport(
      'degraded',
      [dependency('redis', 'degraded', iso(NOW + GRACE))],
    );

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.ready).toBe(true);
  });

  it('is ready for a degraded report with no dependencies after startup (empty boundary)', () => {
    const assessment = assessReadiness(makeReport('degraded', [], 60), { now: NOW });

    expect(assessment.ready).toBe(true);
    expect(assessment.status).toBe('degraded');
    expect(assessment.blocking).toEqual([]);
  });
});

describe('assessReadiness — numeric boundaries', () => {
  it('honours an injected now of 0 instead of falling back to Date.now()', () => {
    // At epoch, a degradation starting at epoch is fresh. If `now` fell back to
    // the real clock (~2024+), the same timestamp would be decades stale.
    const report = makeReport(
      'degraded',
      [dependency('redis', 'degraded', new Date(0).toISOString())],
    );

    const assessment = assessReadiness(report, { now: 0 });

    expect(assessment.ready).toBe(true);
  });

  it('honours a gracePeriodMs of 0 instead of applying the default', () => {
    const report = makeReport(
      'degraded',
      [dependency('redis', 'degraded', iso(NOW))],
    );

    const assessment = assessReadiness(report, { now: NOW, gracePeriodMs: 0 });

    expect(assessment.ready).toBe(false);
    expect(assessment.reason).toBe('degraded_past_grace');
  });

  it('does not block a timestamp-less degradation when the grace period is 0', () => {
    const report = makeReport('degraded', [dependency('redis', 'degraded')]);

    expect(assessReadiness(report, { now: NOW, gracePeriodMs: 0 }).ready).toBe(true);
  });

  it('handles the maximum safe uptime without overflowing the startup gate', () => {
    const report = makeReport(
      'degraded',
      [dependency('redis', 'degraded', iso(NOW))],
      Number.MAX_SAFE_INTEGER,
    );

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.ready).toBe(true);
  });

  it('treats uptime zero with a maximum grace period as startup', () => {
    const report = makeReport(
      'degraded',
      [dependency('redis', 'degraded')],
      0,
    );

    const assessment = assessReadiness(report, {
      now: NOW,
      gracePeriodMs: Number.MAX_SAFE_INTEGER,
    });

    expect(assessment.reason).toBe('degraded_during_startup');
  });

  it('handles a large dependency set without dropping dependencies', () => {
    const dependencies = Array.from({ length: 1_000 }, (_, i) =>
      dependency(`dep_${i}`, 'degraded', iso(NOW - GRACE)),
    );
    const report = makeReport('degraded', dependencies, 60);

    const assessment = assessReadiness(report, { now: NOW });

    expect(assessment.ready).toBe(false);
    expect(Object.keys(assessment.dependencies)).toHaveLength(1_000);
    expect(assessment.blocking).toHaveLength(1_000);
    expect(assessment.blocking[0]).toBe('dep_0');
    expect(assessment.blocking[999]).toBe('dep_999');
  });

  it('does not mutate the report it is given', () => {
    const report = makeReport('degraded', [
      dependency('redis', 'degraded', iso(NOW - GRACE)),
    ]);
    const snapshot = structuredClone(report);

    assessReadiness(report, { now: NOW });

    expect(report).toEqual(snapshot);
  });
});

describe('checkInstanceReadiness', () => {
  it('runs checkAll once and assesses that exact report', async () => {
    const report = makeReport('healthy', [dependency('postgres', 'healthy')]);
    const checkAll = vi.fn().mockResolvedValue(report);
    const manager = { checkAll } as unknown as HealthCheckManager;

    const result = await checkInstanceReadiness(manager, { now: NOW });

    expect(checkAll).toHaveBeenCalledTimes(1);
    expect(checkAll).toHaveBeenCalledWith();
    expect(result.report).toBe(report);
    expect(result.assessment).toEqual(assessReadiness(report, { now: NOW }));
  });

  it('passes the readiness options through to the assessment', async () => {
    const report = makeReport(
      'degraded',
      [dependency('redis', 'degraded', iso(NOW - GRACE))],
    );
    const checkAll = vi.fn().mockResolvedValue(report);
    const manager = { checkAll } as unknown as HealthCheckManager;

    const result = await checkInstanceReadiness(manager, {
      now: NOW,
      gracePeriodMs: GRACE,
    });

    expect(result.assessment.ready).toBe(false);
    expect(result.assessment.reason).toBe('degraded_past_grace');
  });

  it('uses Date.now() when no now is supplied', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const report = makeReport(
        'degraded',
        [dependency('redis', 'degraded', iso(NOW - GRACE - 1))],
      );
      const checkAll = vi.fn().mockResolvedValue(report);
      const manager = { checkAll } as unknown as HealthCheckManager;

      const result = await checkInstanceReadiness(manager);

      expect(result.assessment.ready).toBe(false);
      expect(result.assessment.reason).toBe('degraded_past_grace');
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a checkAll failure instead of returning a verdict', async () => {
    const checkAll = vi.fn().mockRejectedValue(new Error('checker exploded'));
    const manager = { checkAll } as unknown as HealthCheckManager;

    await expect(checkInstanceReadiness(manager, { now: NOW })).rejects.toThrow(
      'checker exploded',
    );
    expect(checkAll).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
