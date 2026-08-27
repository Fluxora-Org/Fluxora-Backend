/**
 * LaunchDarkly-style feature flags with deterministic percentage rollout.
 *
 * Flag definitions are loaded from FEATURE_FLAGS_JSON or FEATURE_FLAGS_FILE and
 * can be hot-reloaded by calling reloadFlags(). Rollout decisions are stable per
 * flag and requester, making the service safe to use across horizontally scaled
 * replicas without shared state.
 *
 * @module config/featureFlags
 */
import crypto from 'crypto';
import fs from 'fs';

/**
 * Runtime feature flag definition.
 *
 * @property name - Unique feature flag name.
 * @property percentage - Rollout percentage in the inclusive range 0-100.
 * @property description - Optional operator-facing note.
 * @property minMigration - Minimum database migration timestamp (e.g.
 *   "20260728000000") that must be applied before this flag can be enabled.
 *   When set, the flag is silently disabled if the latest applied migration is
 *   older than this value. Absent means no schema dependency.
 */
export interface FeatureFlagDefinition {
  name: string;
  percentage: number;
  description?: string;
  minMigration?: string;
}

type FlagMap = Map<string, FeatureFlagDefinition>;

let currentFlags: FlagMap = new Map();

/**
 * Compute a deterministic unsigned 32-bit hash.
 *
 * This function is retained as a small utility for callers and tests that need
 * stable non-cryptographic hashing. Feature flag rollout uses SHA-256 below so
 * buckets are not trivially predictable from exposed requester identifiers.
 *
 * @param input - Value to hash.
 * @returns Unsigned 32-bit FNV-1a hash.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

/**
 * Return the rollout bucket for a flag/requester pair.
 *
 * @security The requester identifier is hashed with the flag name and never
 * stored or logged here. SHA-256 keeps buckets deterministic while avoiding
 * predictable bucket assignments for API keys or client IPs.
 *
 * @param flagName - Feature flag name.
 * @param requesterId - Stable API key id/key material or client IP.
 * @returns Integer bucket in [0, 99].
 */
export function getRolloutBucket(flagName: string, requesterId: string): number {
  const digest = crypto
    .createHash('sha256')
    .update(flagName)
    .update('\0')
    .update(requesterId)
    .digest();

  return digest.readUInt32BE(0) % 100;
}

function normalizePercentage(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 100) return undefined;
  return value;
}

function parseFlagEntry(item: unknown): FeatureFlagDefinition | undefined {
  if (typeof item !== 'object' || item === null) return undefined;

  const entry = item as Record<string, unknown>;
  const rawName = entry['name'];
  const rawPercentage = entry['percentage'];
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const percentage = normalizePercentage(rawPercentage);

  if (name.length === 0 || percentage === undefined) return undefined;

  const definition: FeatureFlagDefinition = { name, percentage };
  if (typeof entry['description'] === 'string') {
    definition.description = entry['description'];
  }
  if (typeof entry['minMigration'] === 'string' && entry['minMigration'].trim().length > 0) {
    definition.minMigration = entry['minMigration'].trim();
  }

  return definition;
}

/**
 * Check schema compatibility for a set of feature flags.
 *
 * Flags with a `minMigration` requirement are tested against the latest applied
 * migration. Incompatible flags are returned so callers can strip them or log
 * warnings. Migration names are timestamp-prefixed strings that sort
 * lexicographically, so a simple string comparison determines ordering.
 *
 * @param flags - Flag map to check.
 * @param latestMigration - Latest applied migration name, or null if none.
 * @returns Map of flag names that are incompatible with the current schema.
 */
export function checkSchemaCompatibility(
  flags: ReadonlyMap<string, FeatureFlagDefinition>,
  latestMigration: string | null,
): Map<string, FeatureFlagDefinition> {
  const incompatible: Map<string, FeatureFlagDefinition> = new Map();

  for (const [name, flag] of flags) {
    if (!flag.minMigration) continue;

    if (latestMigration === null || latestMigration < flag.minMigration) {
      incompatible.set(name, flag);
      process.stderr.write(
        `[featureFlags] Flag "${name}" requires migration ${flag.minMigration} ` +
          `but latest applied is ${latestMigration ?? '(none)'} — flag disabled\n`,
      );
    }
  }

  return incompatible;
}

/**
 * Parse feature flag JSON.
 *
 * Supported formats:
 * - Array: [{ "name": "streams_enhanced_response", "percentage": 25 }]
 * - Object: { "streams_enhanced_response": { "percentage": 25 } }
 * - Object shorthand: { "streams_enhanced_response": 25 }
 *
 * Invalid entries are skipped so a malformed flag cannot crash the process.
 *
 * When `latestMigration` is provided, flags whose `minMigration` requirement
 * exceeds the latest applied migration are silently stripped from the result
 * and a warning is logged for each.
 *
 * @param json - Raw JSON string from env or file.
 * @param latestMigration - Latest applied migration name, or null to skip
 *   schema compatibility checks.
 * @returns Validated flag map.
 */
export function parseFlagsJson(
  json: string,
  latestMigration?: string | null,
): FlagMap {
  const flags: FlagMap = new Map();
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    process.stderr.write('[featureFlags] Invalid feature flags JSON — falling back to empty map\n');
    return flags;
  }

  const entries: unknown[] = [];
  if (Array.isArray(parsed)) {
    entries.push(...parsed);
  } else if (typeof parsed === 'object' && parsed !== null) {
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number') {
        entries.push({ name, percentage: value });
      } else if (typeof value === 'object' && value !== null) {
        entries.push({ name, ...(value as Record<string, unknown>) });
      }
    }
  } else {
    process.stderr.write('[featureFlags] Feature flags config must be an array or object\n');
    return flags;
  }

  for (const item of entries) {
    const definition = parseFlagEntry(item);
    if (definition) flags.set(definition.name, definition);
  }

  if (latestMigration !== undefined) {
    const incompatible = checkSchemaCompatibility(flags, latestMigration);
    for (const name of incompatible.keys()) {
      flags.delete(name);
    }
  }

  return flags;
}

function loadFlagsFromEnv(latestMigration?: string | null): FlagMap {
  const inlineJson = process.env['FEATURE_FLAGS_JSON'];
  if (inlineJson?.trim()) return parseFlagsJson(inlineJson, latestMigration);

  const filePath = process.env['FEATURE_FLAGS_FILE']?.trim();
  if (!filePath) return new Map();

  try {
    return parseFlagsJson(fs.readFileSync(filePath, 'utf8'), latestMigration);
  } catch (err) {
    process.stderr.write(`[featureFlags] Could not read FEATURE_FLAGS_FILE: ${err instanceof Error ? err.message : String(err)} — falling back to empty map\n`);
    return new Map();
  }
}

/**
 * Reload flag definitions from the configured source.
 *
 * The active map is replaced atomically after parsing, so requests never observe
 * a partially loaded configuration.
 *
 * When `latestMigration` is provided, flags whose `minMigration` requirement
 * exceeds the latest applied migration are silently excluded.
 *
 * @param latestMigration - Latest applied migration name, or null/undefined to
 *   skip schema compatibility checks.
 * @returns A commit function that swaps in the newly loaded flag map.
 */
export function prepareReloadFlags(
  latestMigration?: string | null,
): () => ReadonlyMap<string, FeatureFlagDefinition> {
  const nextFlags = loadFlagsFromEnv(latestMigration);
  return () => {
    currentFlags = nextFlags;
    return currentFlags;
  };
}

export function reloadFlags(
  latestMigration?: string | null,
): ReadonlyMap<string, FeatureFlagDefinition> {
  return prepareReloadFlags(latestMigration)();
}

/**
 * Check whether a feature flag is enabled for a requester.
 *
 * @param flagName - Feature flag to evaluate.
 * @param requesterId - Stable requester identity, preferably API key id/key or IP.
 * @returns True when the flag exists and the requester's bucket is within rollout.
 */
export function isEnabled(flagName: string, requesterId: string): boolean {
  const flag = currentFlags.get(flagName);
  if (!flag) return false;
  if (flag.percentage <= 0) return false;
  if (flag.percentage >= 100) return true;

  return getRolloutBucket(flagName, requesterId || 'anonymous') < flag.percentage;
}

/**
 * Return the current flag definitions.
 *
 * @returns Read-only map of flag definitions.
 */
export function getFlags(): ReadonlyMap<string, FeatureFlagDefinition> {
  return currentFlags;
}

currentFlags = loadFlagsFromEnv();
