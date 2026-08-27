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
 */
export interface FeatureFlagDefinition {
  name: string;
  percentage: number;
  description?: string;
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

  return definition;
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
 * @param json - Raw JSON string from env or file.
 * @returns Validated flag map.
 */
export function parseFlagsJson(json: string): FlagMap {
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

  return flags;
}

function loadFlagsFromEnv(): FlagMap {
  const inlineJson = process.env['FEATURE_FLAGS_JSON'];
  if (inlineJson?.trim()) return parseFlagsJson(inlineJson);

  const filePath = process.env['FEATURE_FLAGS_FILE']?.trim();
  if (!filePath) return new Map();

  try {
    return parseFlagsJson(fs.readFileSync(filePath, 'utf8'));
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
 * @returns Newly active feature flag map.
 */
export function prepareReloadFlags(): () => ReadonlyMap<string, FeatureFlagDefinition> {
  const nextFlags = loadFlagsFromEnv();
  return () => {
    currentFlags = nextFlags;
    return currentFlags;
  };
}

export function reloadFlags(): ReadonlyMap<string, FeatureFlagDefinition> {
  return prepareReloadFlags()();
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
