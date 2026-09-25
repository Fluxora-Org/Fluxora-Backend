/**
 * Single source of truth for the **readiness decision**.
 *
 * Two protocols expose the health of the same instance:
 *
 *  - HTTP: `GET /health/ready` (src/routes/health.ts) → 200 / 503
 *  - gRPC: `grpc.health.v1.Health.Check`/`Watch` (src/health/grpcHealth.ts)
 *    → `SERVING` / `NOT_SERVING`
 *
 * Both surface the same underlying dependency checks (`HealthCheckManager`),
 * but the *decision* used to be duplicated: the HTTP route applied the
 * startup/degraded grace period while the gRPC service mapped every
 * `degraded` report to `SERVING`. An orchestrator watching gRPC and a load
 * balancer watching HTTP could therefore reach different conclusions about
 * the same instance — one routing traffic to it, the other draining it.
 *
 * This module removes that class of bug by construction:
 *
 *  - `checkInstanceReadiness()` runs the live dependency checks once and
 *    returns both the raw report and its assessment.
 *  - `assessReadiness()` is a pure function of a `HealthReport`, so the same
 *    report always yields the same verdict — for either protocol.
 *
 * Each dependency contributes identically on both surfaces: the per-dependency
 * statuses in `ReadinessAssessment.dependencies` are the exact statuses the
 * aggregate verdict (`ready`) is computed from.
 */

import type { HealthCheckManager, HealthReport, HealthStatus } from '../config/health.js';

/**
 * How long a dependency may stay `degraded` before it blocks readiness.
 *
 * During the first `gracePeriodMs` of process uptime a degraded dependency
 * fails readiness outright (we should not accept traffic while still warming
 * up). Afterwards a freshly degraded dependency is tolerated until it has
 * been degraded for the full grace period.
 */
export const DEFAULT_READINESS_GRACE_PERIOD_MS = 30_000;

/** Why an instance was judged not ready. */
export type NotReadyReason =
  | 'unhealthy'
  | 'degraded_during_startup'
  | 'degraded_past_grace';

export interface ReadinessAssessment {
  /** Whether the instance should receive traffic. */
  ready: boolean;
  /** Aggregate status from the underlying report (`healthy` | `degraded` | `unhealthy`). */
  status: HealthStatus;
  /**
   * Flat `{ dependencyName: status }` map, identical for every protocol.
   * This is what both surfaces report as the per-dependency contributions.
   */
  dependencies: Record<string, HealthStatus>;
  /** Names of the dependencies whose status currently blocks readiness. */
  blocking: string[];
  /** Present only when `ready` is false. */
  reason?: NotReadyReason;
}

export interface ReadinessOptions {
  /** Grace period in ms. Defaults to {@link DEFAULT_READINESS_GRACE_PERIOD_MS}. */
  gracePeriodMs?: number;
  /** Injectable clock (tests). Defaults to `Date.now()`. */
  now?: number;
}

/** Flatten a report's dependencies into the shared `{ name: status }` map. */
function toDependencyMap(report: HealthReport): Record<string, HealthStatus> {
  const dependencies: Record<string, HealthStatus> = {};
  for (const dep of report.dependencies) {
    dependencies[dep.name] = dep.status;
  }
  return dependencies;
}

/**
 * Decide readiness from a `HealthReport`.
 *
 * Pure — no clocks, no I/O beyond the injected `now` — so the HTTP route and
 * the gRPC service cannot disagree for the same report.
 *
 * Degraded classification (mirrors the documented `/health/ready` contract):
 *  - any dependency `unhealthy`                          → not ready
 *  - any dependency `degraded` during process startup    → not ready
 *  - any dependency `degraded` for ≥ `gracePeriodMs`     → not ready
 *  - otherwise                                           → ready
 */
export function assessReadiness(
  report: HealthReport,
  opts: ReadinessOptions = {},
): ReadinessAssessment {
  const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_READINESS_GRACE_PERIOD_MS;
  const now = opts.now ?? Date.now();
  const dependencies = toDependencyMap(report);

  if (report.status === 'unhealthy') {
    return {
      ready: false,
      status: report.status,
      dependencies,
      blocking: report.dependencies.filter((d) => d.status === 'unhealthy').map((d) => d.name),
      reason: 'unhealthy',
    };
  }

  if (report.status === 'degraded') {
    const uptimeMs = report.uptime * 1000;

    // Startup phase: we are still warming up, so do not accept traffic yet.
    if (uptimeMs < gracePeriodMs) {
      return {
        ready: false,
        status: report.status,
        dependencies,
        blocking: report.dependencies.filter((d) => d.status === 'degraded').map((d) => d.name),
        reason: 'degraded_during_startup',
      };
    }

    // Steady state: tolerate a freshly degraded dependency, but drain the
    // instance once the degradation has persisted past the grace period.
    const stale = report.dependencies.filter((d) => {
      if (d.status !== 'degraded' || !d.degradedSince) return false;
      const degradedSinceMs = Date.parse(d.degradedSince);
      if (Number.isNaN(degradedSinceMs)) return false;
      return now - degradedSinceMs >= gracePeriodMs;
    });

    if (stale.length > 0) {
      return {
        ready: false,
        status: report.status,
        dependencies,
        blocking: stale.map((d) => d.name),
        reason: 'degraded_past_grace',
      };
    }
  }

  return { ready: true, status: report.status, dependencies, blocking: [] };
}

/**
 * Run the live dependency checks once and assess readiness from that single
 * report. Both the HTTP readiness probe and the gRPC health service call
 * this, so they observe the same underlying checks and the same verdict.
 */
export async function checkInstanceReadiness(
  healthManager: HealthCheckManager,
  opts: ReadinessOptions = {},
): Promise<{ report: HealthReport; assessment: ReadinessAssessment }> {
  const report = await healthManager.checkAll();
  return { report, assessment: assessReadiness(report, opts) };
}
