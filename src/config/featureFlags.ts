/**
 * Feature Flag Service — percentage-rollout with deterministic bucketing.
 *
 * Implements a LaunchDarkly-style feature flag system that:
 * - Supports arbitrary named flags with percentage-based rollout (0-100)
 * - Uses a stable FNV-1a hash keyed on (flagName + requesterId) to assign
 *   each requester to a deterministic bucket, so the same requester always
 *   gets the same on/off decision for a given flag percentage.
 * - Loads flag definitions from `FEATURE_FLAGS_JSON` env var (inline JSON)
 *   or from a file path specified by `FEATURE_FLAGS_FILE`, without requiring
 *   a process restart when the percentage changes.
 * - Exposes `reloadFlags()` for use by the SIGHUP handler (issue #764).
 *
 * ## Security
 * - Flag names are used as strings only; no eval or dynamic access.
 * - The requesterId is never logged in flag decisions.
 * - File reads are guarded with try/catch; malformed JSON falls back to an
 *   empty flag map so a bad config file cannot crash the service.
 * - The flag map is replaced atomically (single assignment) so concurrent
 *   requests never observe a partially-updated map.
 *
 * ## Determinism guarantee
 * FNV-1a 32-bit: offset_basis=2166136261, prime=16777619.
 * bucket = fnv1a(flagName + ':' + requesterId) % 100
 * enabled = bucket < percentage
 *
 * With a fixed flag+percentage, every requester ID maps to the same bucket
 * on every call, on every replica, with no shared state needed.
 *
 * @module config/featureFlags
 */

import fs from 'fs';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single feature flag definition.
 *
 * @property name        - Unique flag identifier (e.g. `"streams_enhanced_response"`).
 * @property percentage  - Rollout percentage 0–100. 0 = disabled for everyone,
 *                         100 = enabled for everyone.
 * @property description - Optional human-readable description.
 */
export interface FeatureFlagDefinition {
  name: string;
  percentage: number;
  description?: string;
}

/** Internal flag map: flagName → definition */
type FlagMap = Map<string, FeatureFlagDefinition>;

// ─── Module state (atomically replaced on reload) ─────────────────────────────

/** The currently active flag map.  Replaced atomically by reloadFlags(). */
let currentFlags: FlagMap = new Map();

// ─── FNV-1a 32-bit hash ───────────────────────────────────────────────────────

/**
 * Compute a 32-bit FNV-1a hash of the given string.
 *
 * Properties:
 * - Pure function: same input → same output always.
 * - No external dependencies.
 * - Uniform distribution suitable for percentage bucketing.
 *
 * @param input - Arbitrary UTF-16 string.
 * @returns Unsigned 32-bit integer hash.
 */
export function fnv1a32(input: string): number {
  // FNV offset basis for 32-bit variant.
  let hash = 0x811c9dc5; // 2166136261

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by FNV prime 16777619, keeping result within 32 bits.
    // Using bit tricks to stay within safe integer range.
    hash = (hash >>> 0) * 16777619;
    // Truncate back to 32-bit unsigned.
    hash >>>= 0;
  }

  return hash >>> 0; // ensure unsigned
}

/**
 * Determine the rollout bucket (0–99) for a given flag + requester pair.
 *
 * The bucket is derived from FNV-1a(flagName + ':' + requesterId) % 100.
 * The flag name is included in the hash so that a single requester gets
 * independent, uncorrelated buckets across different flags.
 *
 * @param flagName    - Flag identifier.
 * @param requesterId - Stable requester identity (API key or IP address).
 * @returns Integer in [0, 99].
 */
function getBucket(flagName: string, requesterId: string): number {
  return fnv1a32(`${flagName}:${requesterId}`) % 100;
}

// ─── Flag loading ─────────────────────────────────────────────────────────────

/**
 * Parse a JSON string into a validated FlagMap.
 *
 * Expected format: `FeatureFlagDefinition[]`
 * Invalid entries (non-object, missing name, out-of-range percentage) are
 * silently skipped and a warning is printed to stderr.
 *
 * @param json - Raw JSON string.
 * @returns Populated FlagMap (may be empty on parse failure).
 */
function parseFlagsJson(json: string): FlagMap {
  const map: FlagMap = new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    process.stderr.write(
      `[featureFlags] Failed to parse FEATURE_FLAGS_JSON: invalid JSON\n`,
    );
    return map;
  }

  if (!Array.isArray(parsed)) {
    process.stderr.write(
      `[featureFlags] FEATURE_FLAGS_JSON must be a JSON array of flag definitions\n`,
    );
    return map;
  }

  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const name = typeof entry['name'] === 'string' ? entry['name'] : null;
    const percentage = typeof entry['percentage'] === 'number' ? entry['percentage'] : null;

    if (!name || name.trim().length === 0) {
      process.stderr.write(`[featureFlags] Skipping flag with missing/empty name\n`);
      continue;
    }
    if (percentage === null || percentage < 0 || percentage > 100) {
      process.stderr.write(
        `[featureFlags] Skipping flag "${name}": percentage must be 0–100\n`,
      );
      continue;
    }

    const def: FeatureFlagDefinition = {
      name: name.trim(),
      percentage,
    };
    if (typeof entry['description'] === 'string') {
      def.description = entry['description'];
    }

    map.set(def.name, def);
  }

  return map;
}

/**
 * Load flag definitions from environment variables.
 *
 * Precedence:
 * 1. `FEATURE_FLAGS_JSON` — inline JSON string (highest priority)
 * 2. `FEATURE_FLAGS_FILE` — path to a JSON file
 * 3. Empty map (default when neither is set)
 *
 * All I/O errors are caught; the function always returns a valid FlagMap.
 */
function loadFlagsFromEnv(): FlagMap {
  const inlineJson = process.env['FEATURE_FLAGS_JSON'];
  if (inlineJson && inlineJson.trim().length > 0) {
    return parseFlagsJson(inlineJson);
  }

  const filePath = process.env['FEATURE_FLAGS_FILE'];
  if (filePath && filePath.trim().length > 0) {
    try {
      const content = fs.readFileSync(filePath.trim(), 'utf-8');
      return parseFlagsJson(content);
    } catch (err) {
      process.stderr.write(
        `[featureFlags] Failed to read FEATURE_FLAGS_FILE "${filePath}": ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  return new Map();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reload flag definitions from the environment without a process restart.
 *
 * Reads `FEATURE_FLAGS_JSON` or `FEATURE_FLAGS_FILE` and atomically replaces
 * the in-memory flag map.  Safe to call from a SIGHUP handler.
 *
 * @returns The new flag map (for logging/diagnostics).
 */
export function reloadFlags(): Map<string, FeatureFlagDefinition> {
  const newFlags = loadFlagsFromEnv();
  // Atomic replacement: a single assignment is synchronous and uninterruptible
  // in Node.js's single-threaded event loop.
  currentFlags = newFlags;
  return newFlags;
}

/**
 * Determine whether a named feature flag is enabled for a given requester.
 *
 * The decision is deterministic: the same `(flagName, requesterId)` pair
 * always produces the same result for the current flag percentage, without
 * any shared state or random number generation.
 *
 * @param flagName    - The name of the feature flag to check.
 * @param requesterId - A stable identifier for the requester, such as an
 *                      API key or IP address.  Must not be empty.
 * @returns `true` if the requester's bucket falls within the rollout
 *          percentage; `false` if the flag is unknown, disabled (0%), or the
 *          requester is outside the rollout window.
 */
export function isEnabled(flagName: string, requesterId: string): boolean {
  const flag = currentFlags.get(flagName);
  if (!flag) return false;
  if (flag.percentage <= 0) return false;
  if (flag.percentage >= 100) return true;

  const bucket = getBucket(flagName, requesterId || 'anonymous');
  return bucket < flag.percentage;
}

/**
 * Return a read-only snapshot of the currently loaded flag definitions.
 *
 * Callers must not mutate the returned map.
 *
 * @returns Map from flag name to {@link FeatureFlagDefinition}.
 */
export function getFlags(): ReadonlyMap<string, FeatureFlagDefinition> {
  return currentFlags;
}

// ─── Initialise on module load ────────────────────────────────────────────────
// Load flags eagerly so the first call to isEnabled() sees the right config.
currentFlags = loadFlagsFromEnv();
