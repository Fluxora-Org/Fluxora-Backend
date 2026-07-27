/**
 * Health check management and tiered startup dependency probing.
 *
 * ## HealthCheckManager
 * Runtime dependency health checking used by `/health/ready` and the gRPC
 * health service. Checkers are registered at application boot and polled on
 * demand or on a background interval.
 *
 * ## Tiered Startup Probing — `probeStartupDependencies()`
 * Implements a two-tier strategy for checking external dependencies before the
 * HTTP server starts accepting traffic:
 *
 * ### HARD tier (Postgres)
 * Postgres is a synchronous, critical dependency. A single probe attempt is
 * made with a short, configurable timeout. On failure the process **exits
 * immediately** with a structured error log so on-call engineers can identify
 * the root cause (bad DATABASE_URL, network partition, auth failure) without
 * waiting for container-orchestrator readiness timeouts to expire.
 *
 * ### SOFT tier (Redis, Stellar RPC)
 * Redis and Stellar RPC are degradable dependencies — the application can
 * serve traffic in a reduced-capability mode when they are unavailable.
 * Each soft dependency is retried with **decorrelated jitter backoff**
 * (`withJitteredRetry`) up to a bounded total budget
 * (`STARTUP_PROBE_BUDGET_MS`). If the budget is exhausted the dependency is
 * marked **degraded** (rather than throwing) and startup continues.
 *
 * ### Logging
 * Every probe attempt logs:
 *   - `dependency` — the dependency name
 *   - `tier` — `'hard'` or `'soft'`
 *   - `attempt` — 1-based attempt count
 *   - `outcome` — `'success'` | `'retry'` | `'degraded'` | `'fatal'`
 *   - `latencyMs` — round-trip time for the attempt
 *   - `error` — sanitised error message (credentials stripped)
 *
 * ### Security
 * All error messages are passed through `sanitiseErrorMessage()` from
 * `src/health/checkers.ts` so connection strings, passwords, and hostnames
 * are never emitted in logs.
 */

import { getConfig } from './env.js';
import { logger } from '../lib/logger.js';
import { withJitteredRetry } from '../lib/retry.js';
import { sanitiseErrorMessage } from '../health/checkers.js';

// ─── Re-exports ───────────────────────────────────────────────────────────────
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DependencyHealth {
  name: string;
  status: HealthStatus;
  latency?: number;
  error?: string;
  lastChecked: string;
}

export interface HealthReport {
  status: HealthStatus;
  version: string;
  timestamp: string;
  uptime: number;
  dependencies: DependencyHealth[];
}

export interface HealthChecker {
  name: string;
  /** Return `degraded: true` to signal high-latency / partial availability without a hard error. */
  check(): Promise<{ latency: number; error?: string; degraded?: boolean }>;
}

// ─── Startup Probing Types ────────────────────────────────────────────────────

/**
 * Tier classification for a startup dependency probe.
 *
 * - `'hard'`  — fatal dependency; a failed probe causes an immediate process exit.
 * - `'soft'`  — degradable dependency; retry-with-backoff, falls back to degraded mode.
 */
export type DependencyTier = 'hard' | 'soft';

/**
 * Configuration for a single startup dependency probe.
 *
 * @property name        Human-readable dependency name (used in log fields).
 * @property tier        Probe tier — `'hard'` (fast-fail) or `'soft'` (retry+degrade).
 * @property probe       Async function that attempts a connectivity check.
 *                       Should resolve on success and throw on failure.
 * @property timeoutMs   Maximum time for a single probe attempt, in milliseconds.
 *                       Defaults to `STARTUP_PROBE_TIMEOUT_MS` from config or 5 000 ms.
 */
export interface StartupProbeConfig {
  name: string;
  tier: DependencyTier;
  /** Attempt a connectivity check. Resolves on success, throws on failure. */
  probe(): Promise<void>;
  /** Per-attempt timeout in ms. Overrides the per-dependency config default. */
  timeoutMs?: number;
}

/**
 * Overall options passed to `probeStartupDependencies()`.
 *
 * @property probes          Ordered list of probes to run.
 * @property budgetMs        Total wall-clock budget in ms for all soft-tier retries.
 *                           Defaults to `STARTUP_PROBE_BUDGET_MS` from env or 30 000 ms.
 * @property baseRetryMs     Initial retry delay for soft probes (jitter lower bound), ms.
 *                           Defaults to 250 ms.
 * @property maxRetryMs      Maximum retry delay for soft probes (jitter upper bound), ms.
 *                           Defaults to 5 000 ms.
 * @property onProcessExit   Override the process-exit handler (test seam; defaults to
 *                           `() => process.exit(1)`).
 */
export interface StartupProbeOptions {
  probes: StartupProbeConfig[];
  budgetMs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  /** @internal Test seam — called instead of process.exit(1) for hard failures. */
  onProcessExit?: (reason: string) => never;
}

/**
 * Per-dependency outcome returned from `probeStartupDependencies()`.
 *
 * @property name        Dependency name.
 * @property tier        Probe tier.
 * @property outcome     `'success'`   — probe passed on at least one attempt.
 *                       `'degraded'`  — soft probe exhausted budget; service starts in degraded mode.
 * @property attempts    Total number of probe attempts made.
 * @property latencyMs   Round-trip time of the final (or only) attempt, ms.
 * @property error       Sanitised last error message, if any.
 */
export interface StartupProbeResult {
  name: string;
  tier: DependencyTier;
  outcome: 'success' | 'degraded';
  attempts: number;
  latencyMs: number;
  error?: string;
}

// ─── Startup Probing Implementation ──────────────────────────────────────────

/**
 * Default process-exit handler for hard-tier failures.
 * Separated to allow test injection via `onProcessExit`.
 */
function defaultProcessExit(reason: string): never {
  // Force-flush is a best-effort; errors here are silenced
  process.nextTick(() => process.exit(1));
  throw new Error(reason); // unreachable in production; satisfies TypeScript
}

/**
 * Wrap a probe function with a per-attempt timeout.
 *
 * @param probe     Async function performing the check.
 * @param timeoutMs Maximum wall-clock time allowed, in milliseconds.
 * @param label     Dependency name used in the timeout error message.
 */
async function probeWithTimeout(
  probe: () => Promise<void>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} startup probe timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    probe().then(
      () => { clearTimeout(timer); resolve(); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Probe a **hard** dependency (fast-fail on first error).
 *
 * A single attempt is made. On failure the sanitised error is logged and
 * `onProcessExit` is called (which terminates the process in production).
 *
 * @returns `StartupProbeResult` on success; calls `onProcessExit` on failure.
 */
async function probeHard(
  cfg: StartupProbeConfig,
  onProcessExit: (reason: string) => never,
): Promise<StartupProbeResult> {
  const timeoutMs = cfg.timeoutMs ?? 5_000;
  const start = Date.now();

  logger.info('startup_probe:attempt', undefined, {
    dependency: cfg.name,
    tier: 'hard',
    attempt: 1,
    timeoutMs,
  });

  try {
    await probeWithTimeout(cfg.probe, timeoutMs, cfg.name);
    const latencyMs = Date.now() - start;

    logger.info('startup_probe:success', undefined, {
      dependency: cfg.name,
      tier: 'hard',
      attempt: 1,
      outcome: 'success',
      latencyMs,
    });

    return { name: cfg.name, tier: 'hard', outcome: 'success', attempts: 1, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const raw = err instanceof Error ? err.message : String(err);
    const error = sanitiseErrorMessage(raw);

    logger.error('startup_probe:fatal', undefined, {
      dependency: cfg.name,
      tier: 'hard',
      attempt: 1,
      outcome: 'fatal',
      latencyMs,
      error,
      action: 'process will exit',
    });

    return onProcessExit(
      `Hard dependency "${cfg.name}" failed startup probe: ${error}`,
    );
  }
}

/**
 * Probe a **soft** dependency with retry-and-backoff within a wall-clock budget.
 *
 * Attempts are made using decorrelated jitter backoff (`withJitteredRetry`).
 * The `maxAttempts` cap is computed conservatively so we do not exceed the
 * budget: it is set to a large number and the retry predicate checks elapsed
 * time. This lets the jitter algorithm remain stateless while still honouring
 * the overall wall-clock budget.
 *
 * On budget exhaustion the probe returns `outcome: 'degraded'` — startup
 * continues and the dependency is flagged as unavailable.
 */
async function probeSoft(
  cfg: StartupProbeConfig,
  opts: {
    budgetMs: number;
    baseRetryMs: number;
    maxRetryMs: number;
  },
): Promise<StartupProbeResult> {
  const timeoutMs = cfg.timeoutMs ?? 5_000;
  const probeStart = Date.now();
  let attempts = 0;
  let lastError: string | undefined;
  let lastLatency = 0;

  /** True when we have already consumed more wall-clock time than the budget. */
  const budgetExhausted = (): boolean => Date.now() - probeStart >= opts.budgetMs;

  try {
    await withJitteredRetry(
      async (attempt) => {
        attempts = attempt;
        const attemptStart = Date.now();

        logger.info('startup_probe:attempt', undefined, {
          dependency: cfg.name,
          tier: 'soft',
          attempt,
          timeoutMs,
          budgetRemainingMs: Math.max(0, opts.budgetMs - (Date.now() - probeStart)),
        });

        try {
          await probeWithTimeout(cfg.probe, timeoutMs, cfg.name);
          lastLatency = Date.now() - attemptStart;
          lastError = undefined;

          logger.info('startup_probe:success', undefined, {
            dependency: cfg.name,
            tier: 'soft',
            attempt,
            outcome: 'success',
            latencyMs: lastLatency,
          });
        } catch (err) {
          lastLatency = Date.now() - attemptStart;
          const raw = err instanceof Error ? err.message : String(err);
          lastError = sanitiseErrorMessage(raw);

          logger.warn('startup_probe:retry', undefined, {
            dependency: cfg.name,
            tier: 'soft',
            attempt,
            outcome: 'retry',
            latencyMs: lastLatency,
            error: lastError,
            budgetRemainingMs: Math.max(0, opts.budgetMs - (Date.now() - probeStart)),
          });

          throw err; // re-throw to trigger retry logic in withJitteredRetry
        }
      },
      {
        baseDelayMs: opts.baseRetryMs,
        maxDelayMs: opts.maxRetryMs,
        // A large cap; actual stopping is done via the isRetryable predicate
        maxAttempts: 1_000,
      },
      // isRetryable: stop retrying when budget is exhausted
      (_err) => !budgetExhausted(),
    );

    // Success path
    return {
      name: cfg.name,
      tier: 'soft',
      outcome: 'success',
      attempts,
      latencyMs: lastLatency,
    };
  } catch {
    // Budget exhausted or final retry failed — degrade gracefully
    logger.warn('startup_probe:degraded', undefined, {
      dependency: cfg.name,
      tier: 'soft',
      attempts,
      outcome: 'degraded',
      latencyMs: lastLatency,
      error: lastError,
      action: 'service will start in degraded mode',
    });

    return {
      name: cfg.name,
      tier: 'soft',
      outcome: 'degraded',
      attempts,
      latencyMs: lastLatency,
      error: lastError,
    };
  }
}

/**
 * Run tiered startup dependency probes and return a summary.
 *
 * Hard probes run sequentially before soft probes (so a missing Postgres
 * connection kills the process before we waste time retrying Redis).
 *
 * Soft probes run **concurrently** — each consumes the shared budget
 * independently, so the total startup delay is bounded by `budgetMs`, not
 * `n × budgetMs`.
 *
 * @param opts  Probe configuration and tuning knobs.
 * @returns     Array of per-dependency results (only reachable when all hard
 *              probes pass; soft probes always produce a result).
 *
 * @example
 * ```typescript
 * const results = await probeStartupDependencies({
 *   probes: [
 *     { name: 'postgres', tier: 'hard', probe: postgresProbe, timeoutMs: 3_000 },
 *     { name: 'redis',    tier: 'soft', probe: redisProbe,    timeoutMs: 2_000 },
 *     { name: 'stellar_rpc', tier: 'soft', probe: rpcProbe,  timeoutMs: 5_000 },
 *   ],
 *   budgetMs: 30_000,
 * });
 * ```
 */
export async function probeStartupDependencies(
  opts: StartupProbeOptions,
): Promise<StartupProbeResult[]> {
  const budgetMs = opts.budgetMs ?? readBudgetFromConfig();
  const baseRetryMs = opts.baseRetryMs ?? 250;
  const maxRetryMs = opts.maxRetryMs ?? 5_000;
  const onProcessExit = opts.onProcessExit ?? defaultProcessExit;

  logger.info('startup_probe:begin', undefined, {
    dependencies: opts.probes.map((p) => ({ name: p.name, tier: p.tier })),
    budgetMs,
  });

  const results: StartupProbeResult[] = [];

  // ── Phase 1: Hard probes (sequential, fail-fast) ────────────────────────
  const hardProbes = opts.probes.filter((p) => p.tier === 'hard');
  for (const probe of hardProbes) {
    const result = await probeHard(probe, onProcessExit);
    results.push(result);
  }

  // ── Phase 2: Soft probes (concurrent, retry-with-backoff) ───────────────
  const softProbes = opts.probes.filter((p) => p.tier === 'soft');
  const softResults = await Promise.all(
    softProbes.map((probe) =>
      probeSoft(probe, { budgetMs, baseRetryMs, maxRetryMs }),
    ),
  );
  results.push(...softResults);

  const degraded = results.filter((r) => r.outcome === 'degraded');
  const allHealthy = degraded.length === 0;

  logger.info('startup_probe:complete', undefined, {
    outcome: allHealthy ? 'healthy' : 'degraded',
    degradedDependencies: degraded.map((r) => r.name),
    results: results.map((r) => ({
      name: r.name,
      tier: r.tier,
      outcome: r.outcome,
      attempts: r.attempts,
      latencyMs: r.latencyMs,
    })),
  });

  return results;
}

/**
 * Read the startup probe budget from the live config (if initialized).
 * Falls back to 30 000 ms when config is not yet available (rare edge case
 * during bootstrapping before `initializeConfig()` is called).
 */
function readBudgetFromConfig(): number {
  try {
    return getConfig().startupProbeBudgetMs;
  } catch {
    return 30_000;
  }
}

// ─── HealthCheckManager ───────────────────────────────────────────────────────

export class HealthCheckManager {
  private readonly checkers = new Map<string, HealthChecker>();
  private readonly lastResults = new Map<string, DependencyHealth>();
  private readonly startTime = Date.now();

  private get timeoutMs() { return getConfig().healthCheckTimeoutMs; }
  private get intervalMs() { return getConfig().healthCheckIntervalMs; }

  registerChecker(checker: HealthChecker): void {
    this.checkers.set(checker.name, checker);
    this.lastResults.set(checker.name, {
      name: checker.name,
      status: 'healthy',
      lastChecked: new Date().toISOString(),
    });
  }

  async checkAll(): Promise<HealthReport> {
    const results = await Promise.all(
      Array.from(this.checkers.values()).map((checker) => this.checkOne(checker))
    );

    const status = this.aggregateStatus(results);
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    return {
      status,
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptime,
      dependencies: results,
    };
  }

  getLastReport(version = '0.1.0'): HealthReport {
    const results = Array.from(this.lastResults.values());
    return {
      status: this.aggregateStatus(results),
      version,
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      dependencies: results,
    };
  }

  private async checkOne(checker: HealthChecker): Promise<DependencyHealth> {
    const startTime = Date.now();

    try {
      const result = await checker.check();
      const latency = result.latency ?? Date.now() - startTime;

      let status: HealthStatus;
      if (result.error) {
        status = 'unhealthy';
      } else if (result.degraded) {
        status = 'degraded';
      } else {
        status = 'healthy';
      }

      const health: DependencyHealth = {
        name: checker.name,
        status,
        latency,
        ...(result.error !== undefined ? { error: result.error } : {}),
        lastChecked: new Date().toISOString(),
      };

      this.lastResults.set(checker.name, health);
      return health;
    } catch (err) {
      const latency = Date.now() - startTime;
      const error = err instanceof Error ? err.message : String(err);

      const health: DependencyHealth = {
        name: checker.name,
        status: 'unhealthy',
        latency,
        error,
        lastChecked: new Date().toISOString(),
      };

      this.lastResults.set(checker.name, health);
      return health;
    }
  }

  private aggregateStatus(dependencies: DependencyHealth[]): HealthStatus {
    if (dependencies.some((dependency) => dependency.status === 'unhealthy')) {
      return 'unhealthy';
    }

    if (dependencies.some((dependency) => dependency.status === 'degraded')) {
      return 'degraded';
    }

    return 'healthy';
  }
}

// ─── Built-in stub checkers (used when real clients are not wired up) ─────────

export function createDatabaseHealthChecker(): HealthChecker {
  return {
    name: 'database',
    async check() {
      return { latency: 1 };
    },
  };
}

export function createRedisHealthChecker(): HealthChecker {
  return {
    name: 'redis',
    async check() {
      return { latency: 1 };
    },
  };
}

export function createHorizonHealthChecker(_url: string): HealthChecker {
  return {
    name: 'horizon',
    async check() {
      return { latency: 1 };
    },
  };
}
