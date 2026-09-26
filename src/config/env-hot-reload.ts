/**
 * SIGHUP hot-reload machinery for runtime-tunable configuration.
 *
 * Extracted from the original single-file `env.ts` verbatim; behavior is
 * unchanged. The subset of variables that may change at runtime (rate limits,
 * tracing sample rate, log level, feature-flag sources) is rebuilt from
 * `process.env` on each refresh; restart-only secrets are detected and
 * reported but never applied.
 */
import { warn } from '../lib/logger.js';
import type { LogLevel } from './env-schema/types.js';

/**
 * Reset the startup env snapshot back to null.
 *
 * **FOR TESTING ONLY.** Allows each test to exercise
 * `captureStartupEnvSnapshot()` / `reloadHotConfig()` in isolation without
 * full module reloading. Never call this in production code.
 *
 * @internal
 */
export function resetStartupEnvSnapshot(): void {
  startupEnvSnapshot = null;
  lastHotConfig = null;
  reloadGeneration = 0;
}

// ─── Hot-reload support ───────────────────────────────────────────────────────

/**
 * The subset of configuration values that can be changed at runtime by
 * sending SIGHUP to the process. All other variables require a full restart.
 */
export interface HotConfig {
  rateLimitIpWindowMs: number | undefined;
  rateLimitIpMax: number | undefined;
  rateLimitApikeyWindowMs: number | undefined;
  rateLimitApikeyMax: number | undefined;
  rateLimitAdminWindowMs: number | undefined;
  rateLimitAdminMax: number | undefined;
  tracingSampleRate: number;
  tracingEnabled: boolean;
  logLevel: LogLevel;
  featureFlagsJson: string | undefined;
  featureFlagsFile: string | undefined;
}

/**
 * Result of a full config-refresh cycle (parse + apply).
 * Used by the SIGHUP handler and tests to assert deterministic outcomes.
 */
export interface ConfigRefreshResult {
  /** Frozen HotConfig snapshot that was applied. */
  hot: HotConfig;
  /** Monotonic generation counter; increments on every successful refresh. */
  generation: number;
  /** Restart-only keys that differ from the startup snapshot (never applied). */
  restartOnlyChanges: readonly RestartOnlyKey[];
  /** Whether the refresh applied a config that differs from the previous one. */
  changed: boolean;
  /** Wall-clock duration of the refresh in milliseconds. */
  durationMs: number;
}

/**
 * The set of env-var keys whose change requires a full process restart.
 * If any of these change between the startup snapshot and a SIGHUP, a WARN
 * is emitted but the new value is intentionally not applied.
 */
const RESTART_ONLY_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'INDEXER_WORKER_TOKEN',
] as const;
type RestartOnlyKey = (typeof RESTART_ONLY_KEYS)[number];

/** Snapshot of restart-only env values captured at process startup. */
let startupEnvSnapshot: Readonly<Record<RestartOnlyKey, string | undefined>> | null = null;

/**
 * Last successfully built HotConfig. Exposed so request paths (rate limiter,
 * tracing, logger) and the SIGHUP handler share one deterministic snapshot
 * across retries and deploys — not a fresh parse of process.env each time.
 */
let lastHotConfig: HotConfig | null = null;

/** Monotonic generation counter for successful reloads (observability + tests). */
let reloadGeneration = 0;

/**
 * Serialize concurrent SIGHUP / refresh calls so only one apply runs at a time.
 * Node is single-threaded, but nested/re-entrant signal handlers and tests
 * that fire multiple refreshes in one tick still need a clear total order.
 */
let reloadInFlight: Promise<ConfigRefreshResult> | null = null;

/**
 * Capture the current values of restart-only env variables.
 * Call this once during startup, before any SIGHUP handler is registered.
 * Subsequent calls are no-ops (the first snapshot is preserved).
 */
export function captureStartupEnvSnapshot(): void {
  if (startupEnvSnapshot !== null) return;
  const snapshot = {} as Record<RestartOnlyKey, string | undefined>;
  for (const key of RESTART_ONLY_KEYS) {
    snapshot[key] = process.env[key];
  }
  startupEnvSnapshot = Object.freeze(snapshot);
}

/**
 * Return the last HotConfig produced by `reloadHotConfig()` / `refreshHotConfig()`,
 * or `null` if no reload has run yet. Callers that need stable mid-request
 * views of hot config should prefer this over re-parsing process.env.
 */
export function getLastHotConfig(): HotConfig | null {
  return lastHotConfig;
}

/** Monotonic generation of the last successful hot-config build (0 = never). */
export function getHotConfigGeneration(): number {
  return reloadGeneration;
}

/** Stable serialization of a HotConfig for equality / change detection. */
function hotConfigFingerprint(hot: HotConfig): string {
  return [
    hot.rateLimitIpWindowMs ?? '',
    hot.rateLimitIpMax ?? '',
    hot.rateLimitApikeyWindowMs ?? '',
    hot.rateLimitApikeyMax ?? '',
    hot.rateLimitAdminWindowMs ?? '',
    hot.rateLimitAdminMax ?? '',
    hot.tracingSampleRate,
    hot.tracingEnabled ? '1' : '0',
    hot.logLevel,
    hot.featureFlagsJson ?? '',
    hot.featureFlagsFile ?? '',
  ].join('\u0001');
}

/**
 * Parse optional positive integers for rate-limit fields.
 * Empty, non-numeric, zero, and negative values → undefined (use defaults).
 * Leading/trailing whitespace is tolerated via parseInt.
 */
function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function parseFloat01(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

function parseBoolHot(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function parseLogLevelHot(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (raw !== undefined && (VALID_LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return fallback;
}

/**
 * Detect restart-only key drift vs the startup snapshot.
 * Emits one WARN per changed key (variable NAME only — never the value).
 */
function detectRestartOnlyChanges(): RestartOnlyKey[] {
  if (startupEnvSnapshot === null) {
    captureStartupEnvSnapshot();
  }
  const changed: RestartOnlyKey[] = [];
  for (const key of RESTART_ONLY_KEYS) {
    const original = startupEnvSnapshot![key];
    const current = process.env[key];
    if (current !== original) {
      changed.push(key);
      warn(`SIGHUP: restart-only variable ${key} changed — restart required to apply`, {
        variable: key,
      });
    }
  }
  return changed;
}

/**
 * Parse the whitelisted hot-reloadable keys from `process.env` and return a
 * fully-built `HotConfig` object.
 *
 * If any restart-only key has changed since startup, a WARN is logged for each
 * changed key. The new value is NOT applied — callers receive only the
 * hot-reloadable portion.
 *
 * The build is atomic: the returned object is fully constructed before it is
 * returned to the caller; no intermediate state is ever visible.
 *
 * Determinism guarantees:
 * - Same `process.env` → same frozen HotConfig fields (stable defaults).
 * - The latest successful build is stored and exposed via `getLastHotConfig()`.
 * - Generation counter increments so deploys/retries can observe apply order.
 *
 * Requires `captureStartupEnvSnapshot()` to have been called first. If it has
 * not been called yet, a snapshot is taken implicitly now so that the function
 * still works in isolation (e.g. in tests).
 */
export function reloadHotConfig(): HotConfig {
  detectRestartOnlyChanges();

  const newConfig: HotConfig = {
    rateLimitIpWindowMs: parseOptionalPositiveInt(process.env.RATE_LIMIT_IP_WINDOW_MS),
    rateLimitIpMax: parseOptionalPositiveInt(process.env.RATE_LIMIT_IP_MAX),
    rateLimitApikeyWindowMs: parseOptionalPositiveInt(process.env.RATE_LIMIT_APIKEY_WINDOW_MS),
    rateLimitApikeyMax: parseOptionalPositiveInt(process.env.RATE_LIMIT_APIKEY_MAX),
    rateLimitAdminWindowMs: parseOptionalPositiveInt(process.env.RATE_LIMIT_ADMIN_WINDOW_MS),
    rateLimitAdminMax: parseOptionalPositiveInt(process.env.RATE_LIMIT_ADMIN_MAX),
    tracingSampleRate: parseFloat01(process.env.TRACING_SAMPLE_RATE, 1),
    tracingEnabled: parseBoolHot(process.env.TRACING_ENABLED, false),
    logLevel: parseLogLevelHot(process.env.LOG_LEVEL, 'info'),
    featureFlagsJson: process.env.FEATURE_FLAGS_JSON || undefined,
    featureFlagsFile: process.env.FEATURE_FLAGS_FILE || undefined,
  };

  const frozen = Object.freeze(newConfig);
  lastHotConfig = frozen;
  reloadGeneration += 1;
  return frozen;
}

/**
 * Full config-refresh path used by the SIGHUP handler.
 *
 * Builds a HotConfig, then invokes the provided apply callbacks in a fixed
 * order. Concurrent callers share one in-flight promise so rapid SIGHUPs
 * (or deploy-time retries) collapse to a single deterministic apply.
 *
 * Auth note: this path never reloads secrets/tokens. Restart-only keys are
 * detected and reported but never applied.
 *
 * @param apply - Side-effect callbacks (rate limits, flags, log level, metrics).
 *                Thrown errors propagate so the SIGHUP handler can log failure
 *                without killing the process.
 */
export async function refreshHotConfig(apply?: {
  /** Two-phase commit style (preferred): return a commit fn from preparation. */
  prepareRateLimits?: (hot: HotConfig) => () => void;
  prepareFeatureFlags?: (hot: HotConfig) => () => void;
  prepareLogLevel?: (level: LogLevel) => () => void;
  /** Legacy direct-apply style (still supported). */
  applyRateLimits?: (hot: HotConfig) => void;
  applyFeatureFlags?: () => void;
  applyLogLevel?: (level: LogLevel) => void;
  onSuccess?: (result: ConfigRefreshResult) => void;
  onFailure?: (error: unknown, durationMs: number) => void;
}): Promise<ConfigRefreshResult> {
  // Coalesce concurrent callers onto one in-flight apply. Work is deferred to a
  // microtask so `reloadInFlight` is assigned before any body runs — otherwise a
  // fully-synchronous async IIFE would finish (and clear the flag) before the
  // assignment, breaking both coalescing and sequential change detection.
  if (reloadInFlight) {
    return reloadInFlight;
  }

  const started = Date.now();
  const run = Promise.resolve()
    .then((): ConfigRefreshResult => {
      const previous = lastHotConfig;
      const restartOnlyChanges = detectRestartOnlyChanges();

      const hot: HotConfig = Object.freeze({
        rateLimitIpWindowMs: parseOptionalPositiveInt(process.env.RATE_LIMIT_IP_WINDOW_MS),
        rateLimitIpMax: parseOptionalPositiveInt(process.env.RATE_LIMIT_IP_MAX),
        rateLimitApikeyWindowMs: parseOptionalPositiveInt(process.env.RATE_LIMIT_APIKEY_WINDOW_MS),
        rateLimitApikeyMax: parseOptionalPositiveInt(process.env.RATE_LIMIT_APIKEY_MAX),
        rateLimitAdminWindowMs: parseOptionalPositiveInt(process.env.RATE_LIMIT_ADMIN_WINDOW_MS),
        rateLimitAdminMax: parseOptionalPositiveInt(process.env.RATE_LIMIT_ADMIN_MAX),
        tracingSampleRate: parseFloat01(process.env.TRACING_SAMPLE_RATE, 1),
        tracingEnabled: parseBoolHot(process.env.TRACING_ENABLED, false),
        logLevel: parseLogLevelHot(process.env.LOG_LEVEL, 'info'),
        featureFlagsJson: process.env.FEATURE_FLAGS_JSON || undefined,
        featureFlagsFile: process.env.FEATURE_FLAGS_FILE || undefined,
      });

      const changed =
        previous === null || hotConfigFingerprint(previous) !== hotConfigFingerprint(hot);

      // Resolve prepare callbacks — prefer the prepare* form (two-phase commit);
      // fall back to the legacy apply* form for backward compatibility.
      const commitRateLimits = apply?.prepareRateLimits
        ? apply.prepareRateLimits(hot)
        : apply?.applyRateLimits
          ? () => apply.applyRateLimits!(hot)
          : undefined;

      const commitFeatureFlags = apply?.prepareFeatureFlags
        ? apply.prepareFeatureFlags(hot)
        : apply?.applyFeatureFlags
          ? () => apply.applyFeatureFlags!()
          : undefined;

      const commitLogLevel = apply?.prepareLogLevel
        ? apply.prepareLogLevel(hot.logLevel)
        : apply?.applyLogLevel
          ? () => apply.applyLogLevel!(hot.logLevel)
          : undefined;

      // Commit side effects in a fixed order for deterministic deploys/retries.
      commitRateLimits?.();
      commitFeatureFlags?.();
      commitLogLevel?.();

      lastHotConfig = hot;
      reloadGeneration += 1;

      const result: ConfigRefreshResult = Object.freeze({
        hot,
        generation: reloadGeneration,
        restartOnlyChanges: Object.freeze([...restartOnlyChanges]),
        changed,
        durationMs: Date.now() - started,
      });

      apply?.onSuccess?.(result);
      return result;
    })
    .catch((error: unknown) => {
      apply?.onFailure?.(error, Date.now() - started);
      throw error;
    })
    .finally(() => {
      reloadInFlight = null;
    });

  reloadInFlight = run;
  return run;
}
