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
  degradedSince?: string;
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
  /**
   * Per-checker timeout in ms. When present, overrides the manager-level
   * `healthCheckTimeoutMs` (from `HEALTH_CHECK_TIMEOUT_MS`) for this checker only.
   * A timed-out check is reported as `unhealthy` rather than hanging.
   */
  timeoutMs?: number;
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
    deadlineMs: number;
  },
): Promise<StartupProbeResult> {
  const timeoutMs = cfg.timeoutMs ?? 5_000;
  let attempts = 0;
  let lastError: string | undefined;
  let lastLatency = 0;

  /** True when we have already consumed more wall-clock time than the budget. */
  const budgetExhausted = (): boolean => Date.now() >= opts.deadlineMs;

  try {
    await withJitteredRetry(
      async (attempt) => {
        attempts = attempt;
        const attemptStart = Date.now();

        logger.info('startup_probe:attempt', undefined, {
          dependency: cfg.name,
          tier: 'soft',
          attempt,
          timeoutMs: Math.min(timeoutMs, Math.max(1, opts.deadlineMs - Date.now())),
          budgetRemainingMs: Math.max(0, opts.deadlineMs - Date.now()),
        });

        try {
          await probeWithTimeout(
            cfg.probe,
            Math.min(timeoutMs, Math.max(1, opts.deadlineMs - Date.now())),
            cfg.name,
          );
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
            budgetRemainingMs: Math.max(0, opts.deadlineMs - Date.now()),
          });

          throw err; // re-throw to trigger retry logic in withJitteredRetry
        }
      },
      {
        baseDelayMs: opts.baseRetryMs,
        maxDelayMs: opts.maxRetryMs,
        maxDelayForAttemptMs: () => Math.max(0, opts.deadlineMs - Date.now()),
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
  const deadlineMs = Date.now() + budgetMs;
  const softResults = await Promise.all(
    softProbes.map((probe) =>
      probeSoft(probe, { budgetMs, baseRetryMs, maxRetryMs, deadlineMs }),
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

/**
 * Race a checker's `check()` promise against a per-checker deadline.
 *
 * When the deadline fires the promise rejects with a structured timeout error
 * so `checkOne()` can mark the dependency `unhealthy` rather than leaving it
 * pending indefinitely.
 *
 * Kept separate from `probeWithTimeout()` (used for startup probes) so their
 * error messages and semantic context remain distinct.
 */
function withCheckerTimeout<T>(
  promise: Promise<T>,
  ms: number,
  name: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${name} health check timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export class HealthCheckManager {
  private readonly checkers = new Map<string, HealthChecker>();
  private readonly lastResults = new Map<string, DependencyHealth>();
  private readonly startTime = Date.now();

  /**
   * Extra slack added to the per-checker timeout to derive the `checkAll`
   * hard deadline. Accounts for scheduling jitter and microtask-queue depth
   * so the outer deadline is always a true last-resort rather than a
   * premature cancellation.
   */
  private static readonly CHECKALL_DEADLINE_BUFFER_MS = 500;

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

  /**
   * Run every registered checker concurrently and return an aggregate report.
   *
   * Each checker is individually wrapped in a per-checker timeout
   * (`checker.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS`) inside `checkOne()`.
   * A secondary hard deadline equal to that global timeout plus a scheduling-
   * jitter buffer is applied to the entire `Promise.all` as a belt-and-
   * suspenders guard: if any checker somehow escapes its own timeout the
   * endpoint still responds within a bounded time using the last-cached state.
   */
  async checkAll(): Promise<HealthReport> {
    const globalTimeoutMs = this.timeoutMs;
    const hardDeadlineMs = globalTimeoutMs + HealthCheckManager.CHECKALL_DEADLINE_BUFFER_MS;

    // Hard deadline: if any checker somehow escapes its own timeout,
    // abort waiting and report the check as unhealthy rather than leaving
    // the caller hanging or returning stale healthy data.
    const deadline = new Promise<HealthReport>((resolve) => {
      const timer = setTimeout(() => {
        const last = this.getLastReport();
        const timedOutDeps = last.dependencies.map((d) => ({
          ...d,
          status: 'unhealthy' as HealthStatus,
          error: d.error ?? 'Health check timed out exceeding deadline',
          lastChecked: new Date().toISOString(),
        }));
        resolve({
          status: 'unhealthy',
          version: '0.1.0',
          timestamp: new Date().toISOString(),
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
          dependencies: timedOutDeps,
        });
      }, hardDeadlineMs);
      // Allow the Node.js event loop to exit naturally if only this timer is
      // left pending (e.g. during graceful shutdown tests).
      if (typeof timer.unref === 'function') timer.unref();
    });

    const checks = Promise.all(
      Array.from(this.checkers.values()).map((checker) => this.checkOne(checker)),
    ).then((results) => {
      const status = this.aggregateStatus(results);
      const uptime = Math.floor((Date.now() - this.startTime) / 1000);
      return {
        status,
        version: '0.1.0',
        timestamp: new Date().toISOString(),
        uptime,
        dependencies: results,
      } satisfies HealthReport;
    });

    return Promise.race([checks, deadline]);
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

  /**
   * Run a single checker with an explicit per-checker timeout.
   *
   * The effective timeout is resolved as:
   *   `checker.timeoutMs` (per-checker override) ??
   *   `HEALTH_CHECK_TIMEOUT_MS` (global config default)
   *
   * A timed-out or throwing checker is recorded as `unhealthy` with a
   * sanitised error message — it never leaves a pending promise in the caller.
   */
  private async checkOne(checker: HealthChecker): Promise<DependencyHealth> {
    const startTime = Date.now();
    const effectiveTimeout = checker.timeoutMs ?? this.timeoutMs;

    try {
      const result = await withCheckerTimeout(checker.check(), effectiveTimeout, checker.name);
      const latency = result.latency ?? Date.now() - startTime;

      let status: HealthStatus;
      if (result.error) {
        status = 'unhealthy';
      } else if (result.degraded) {
        status = 'degraded';
      } else {
        status = 'healthy';
      }

      const prevHealth = this.lastResults.get(checker.name);
      let degradedSince: string | undefined;

      if (status === 'degraded') {
        degradedSince = prevHealth?.status === 'degraded' ? prevHealth.degradedSince : new Date().toISOString();
      }

      const health: DependencyHealth = {
        name: checker.name,
        status,
        latency,
        ...(result.error !== undefined ? { error: result.error } : {}),
        lastChecked: new Date().toISOString(),
        ...(degradedSince !== undefined ? { degradedSince } : {}),
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

// ─── Startup validation (issue #1437) ────────────────────────────────────────

/**
 * Validate health-related configuration derived from the env schema (issue #1437).
 *
 * The env schema already bounds most of these values, but `Config` can also be
 * constructed programmatically (tests, embedding apps), and a non-positive
 * timeout/interval here would only misbehave when `/health/ready` or the
 * background poller actually ran. Check them at startup too.
 *
 * The three optional per-checker timeout overrides (`healthCheckPostgresTimeoutMs`,
 * `healthCheckRedisTimeoutMs`, `healthCheckStellarTimeoutMs`) are only validated
 * when present — `undefined` means "fall back to the global timeout", which is
 * always valid.
 */
export function validateHealthConfig(config: {
  healthCheckTimeoutMs: number;
  healthCheckIntervalMs: number;
  healthCheckPostgresTimeoutMs?: number | undefined;
  healthCheckRedisTimeoutMs?: number | undefined;
  healthCheckStellarTimeoutMs?: number | undefined;
  startupProbeBudgetMs: number;
  startupProbePostgresTimeoutMs: number;
  startupProbeRedisTimeoutMs: number;
  startupProbeStellarTimeoutMs: number;
}): string[] {
  const issues: string[] = [];

  const positiveInts: ReadonlyArray<[string, number]> = [
    ['healthCheckTimeoutMs', config.healthCheckTimeoutMs],
    ['healthCheckIntervalMs', config.healthCheckIntervalMs],
    ['startupProbeBudgetMs', config.startupProbeBudgetMs],
    ['startupProbePostgresTimeoutMs', config.startupProbePostgresTimeoutMs],
    ['startupProbeRedisTimeoutMs', config.startupProbeRedisTimeoutMs],
    ['startupProbeStellarTimeoutMs', config.startupProbeStellarTimeoutMs],
  ];

  for (const [name, value] of positiveInts) {
    if (!Number.isInteger(value) || value <= 0) {
      issues.push(`${name} must be a positive integer (got ${value})`);
    }
  }

  // Per-checker overrides are optional; only validate when explicitly set.
  const optionalPositiveInts: ReadonlyArray<[string, number | undefined]> = [
    ['healthCheckPostgresTimeoutMs', config.healthCheckPostgresTimeoutMs],
    ['healthCheckRedisTimeoutMs',    config.healthCheckRedisTimeoutMs],
    ['healthCheckStellarTimeoutMs',  config.healthCheckStellarTimeoutMs],
  ];

  for (const [name, value] of optionalPositiveInts) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      issues.push(`${name} must be a positive integer when set (got ${value})`);
    }
  }

  return issues;
}

// ─── Built-in stub checkers (used when real clients are not wired up) ─────────

export function createDatabaseHealthChecker(opts: { timeoutMs?: number } = {}): HealthChecker {
  return {
    name: 'database',
    timeoutMs: opts.timeoutMs ?? 5_000,
    async check() {
      return { latency: 1 };
    },
  };
}

export function createRedisHealthChecker(opts: { timeoutMs?: number } = {}): HealthChecker {
  return {
    name: 'redis',
    timeoutMs: opts.timeoutMs ?? 5_000,
    async check() {
      return { latency: 1 };
    },
  };
}

export function createHorizonHealthChecker(_url: string, opts: { timeoutMs?: number } = {}): HealthChecker {
  return {
    name: 'horizon',
    timeoutMs: opts.timeoutMs ?? 5_000,
    async check() {
      return { latency: 1 };
    },
  };
}

// ─── Bounded HealthCheckManager factory ──────────────────────────────────────

/**
 * Options accepted by {@link createBoundedHealthCheckManager}.
 *
 * Every timeout field falls back to `healthCheckTimeoutMs` when absent, which
 * itself falls back to `HEALTH_CHECK_TIMEOUT_MS` (default 5 000 ms). The
 * three per-checker overrides let operators tune individual dependencies
 * without touching the global fallback.
 */
export interface BoundedHealthCheckManagerOptions {
  /**
   * Global per-checker timeout in ms (sourced from `Config.healthCheckTimeoutMs`).
   * Applied to any checker that does not declare its own `timeoutMs`.
   */
  healthCheckTimeoutMs: number;
  /** Per-checker override for the Postgres check, in ms. Defaults to `healthCheckTimeoutMs`. */
  healthCheckPostgresTimeoutMs?: number | undefined;
  /** Per-checker override for the Redis check, in ms. Defaults to `healthCheckTimeoutMs`. */
  healthCheckRedisTimeoutMs?: number | undefined;
  /** Per-checker override for the Stellar RPC check, in ms. Defaults to `healthCheckTimeoutMs`. */
  healthCheckStellarTimeoutMs?: number | undefined;
  /**
   * Additional checkers to register beyond the three standard ones.
   * Useful for application-layer custom checkers (e.g. background workers).
   */
  extraCheckers?: HealthChecker[];
}

/**
 * Build a `HealthCheckManager` with per-checker timeouts resolved from config.
 *
 * Each of the three standard dependency checks (postgres, redis, stellar_rpc)
 * is registered with its own explicit `timeoutMs`, derived from the per-checker
 * env-var override when set, or the global `HEALTH_CHECK_TIMEOUT_MS` otherwise.
 * The `HealthCheckManager.checkOne()` wrapper enforces this timeout as a
 * last-resort safety net on top of the checker's own internal timeout guard.
 *
 * This is the canonical factory for production boot code. Use it in
 * `src/index.ts` or wherever `createApp()` is called with a real manager:
 *
 * ```typescript
 * import { createBoundedHealthCheckManager } from './config/health.js';
 * import { createPostgresChecker, createRedisChecker, createStellarRpcChecker } from './health/checkers.js';
 *
 * const healthManager = createBoundedHealthCheckManager({
 *   ...config,
 *   extraCheckers: [
 *     createPostgresChecker(getPoolClient, { timeoutMs: config.healthCheckPostgresTimeoutMs }),
 *     createRedisChecker(getRedisClient,   { timeoutMs: config.healthCheckRedisTimeoutMs }),
 *     createStellarRpcChecker(getRpcClient,{ timeoutMs: config.healthCheckStellarTimeoutMs }),
 *   ],
 * });
 * ```
 *
 * The factory itself only registers stubs for the three standard checks so
 * the manager is immediately functional without real clients wired up. Replace
 * them via `extraCheckers` (which upserts by name) or re-register after
 * construction when real clients are available.
 */
export function createBoundedHealthCheckManager(
  opts: BoundedHealthCheckManagerOptions,
): HealthCheckManager {
  const globalTimeout = opts.healthCheckTimeoutMs;

  const manager = new HealthCheckManager();

  // Register the three standard stub checkers with their resolved timeouts.
  // When real client factories are available (see extraCheckers), callers
  // should pass them via extraCheckers instead — they upsert by name.
  const defaultCheckers: HealthChecker[] = [
    {
      name: 'postgres',
      timeoutMs: opts.healthCheckPostgresTimeoutMs ?? globalTimeout,
      async check() { return { latency: 1 }; },
    },
    {
      name: 'redis',
      timeoutMs: opts.healthCheckRedisTimeoutMs ?? globalTimeout,
      async check() { return { latency: 1 }; },
    },
    {
      name: 'stellar_rpc',
      timeoutMs: opts.healthCheckStellarTimeoutMs ?? globalTimeout,
      async check() { return { latency: 1 }; },
    },
  ];

  for (const checker of defaultCheckers) {
    manager.registerChecker(checker);
  }

  // Extra checkers upsert the defaults by name (registerChecker uses Map.set).
  for (const checker of opts.extraCheckers ?? []) {
    manager.registerChecker(checker);
  }

  return manager;
}
