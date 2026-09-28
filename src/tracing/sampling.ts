/**
 * Trace sampling strategies.
 *
 * Extracted from `src/tracing/hooks.ts` in #1518.
 *
 * Issue #757: Head-based and tail-based trace sampling strategies.
 *
 * Head-based sampling: the decision to keep or drop a trace is made at the
 * beginning of the trace, keyed off the trace ID hash. Because the decision
 * is derived deterministically from the trace ID, all services in the call
 * graph that see the same trace ID make the same keep/drop decision, so you
 * never get partial traces.
 *
 * Tail-based sampling: the decision is made at span-end time based on the
 * span's outcome. The current implementation always keeps spans that contain
 * an error status or an error event, without buffering all spans in memory.
 *
 * Per-route overrides: individual API routes can have their own sample rates
 * configured via TRACING_PER_ROUTE_OVERRIDES (JSON env var), overriding the
 * global rate for traffic on that route.
 */

import type { Span } from './types.js';

/**
 * Available sampling strategy identifiers.
 *
 * - `'head'`   — deterministic decision keyed on trace ID (recommended for production)
 * - `'tail'`   — decision made at span-end time; keeps error spans always
 * - `'always'` — keep every span (useful for development / debugging)
 * - `'never'`  — drop every span (useful for benchmarking overhead)
 */
export type SamplingStrategy = 'head' | 'tail' | 'always' | 'never';

/**
 * Configuration for head-based sampling.
 *
 * The sample decision is made once at trace creation time using a
 * deterministic hash of the trace ID. All services observing the same
 * trace ID will make the same decision.
 */
export interface HeadSamplingConfig {
  strategy: 'head';
  /** Fraction of traces to keep, in [0, 1]. Default 1.0 (keep all). */
  sampleRate: number;
  /**
   * Per-route sample rate overrides.
   * Keys are route path prefixes (e.g. `"/health"`, `"/api/streams"`).
   * Values are sample rates in [0, 1].
   * Exact matches are checked first; then longest prefix match.
   */
  perRouteOverrides?: Record<string, number>;
  /**
   * Per-tenant sample rate overrides.
   * Keys are tenant IDs.
   * Values are sample rates in [0, 1].
   * Exact matches only.
   */
  perTenantOverrides?: Record<string, number>;
}

/**
 * Configuration for tail-based sampling.
 *
 * The decision is made at span-end time. Error spans are always kept when
 * `keepErrorSpans` is true, without requiring full in-memory buffering.
 */
export interface TailSamplingConfig {
  strategy: 'tail';
  /** Fraction of non-error spans to keep, in [0, 1]. Default 0.1. */
  sampleRate: number;
  /**
   * When true, any span with status `'error'` or an event named `'error'`
   * is always kept regardless of `sampleRate`.
   */
  keepErrorSpans: boolean;
}

/** Always-on (keep every span) sampling config. */
export interface AlwaysSamplingConfig {
  strategy: 'always';
}

/** Always-off (drop every span) sampling config. */
export interface NeverSamplingConfig {
  strategy: 'never';
}

/** Union of all supported sampling config shapes. */
export type SamplingConfig =
  | HeadSamplingConfig
  | TailSamplingConfig
  | AlwaysSamplingConfig
  | NeverSamplingConfig;

// ─── FNV-1a 32-bit hash (no dependencies, pure function) ──────────────────────

/**
 * Compute a 32-bit FNV-1a hash of a UTF-16 string.
 *
 * Used by head-based sampling so the trace-ID → keep/drop decision is:
 * - Deterministic: same traceId → same hash → same bucket → same decision.
 * - Uniform: good distribution across the [0, 999] bucket space.
 * - Fast: O(n) time, zero allocations.
 *
 * @param input - Any string (typically a trace ID).
 * @returns Unsigned 32-bit integer.
 */
export function samplingFnv1a32(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash >>> 0) * 16777619; // FNV prime
    hash >>>= 0; // keep 32-bit unsigned
  }
  return hash >>> 0;
}

/**
 * Determine whether a trace should be sampled using head-based (upfront) logic.
 *
 * The bucket is derived as `samplingFnv1a32(traceId) % 1000`, giving 1000
 * evenly-sized slots. A trace is kept when its bucket is less than
 * `Math.round(sampleRate * 1000)`.
 *
 * This function is **pure** — identical inputs always produce identical
 * outputs, across processes and replicas, with no shared state.
 *
 * @param traceId    - The W3C trace ID (hex string) or correlation ID.
 * @param sampleRate - Fraction in [0, 1]. 0 = never, 1 = always.
 * @returns `true` if the trace should be kept.
 */
export function shouldSampleHead(traceId: string, sampleRate: number): boolean {
  if (Number.isNaN(sampleRate) || !Number.isFinite(sampleRate)) return false;
  const clampedRate = Math.max(0, Math.min(1, sampleRate));
  if (clampedRate <= 0) return false;
  if (clampedRate >= 1) return true;
  const bucket = samplingFnv1a32(traceId) % 1000;
  return bucket < Math.round(clampedRate * 1000);
}

/**
 * Determine whether a finished span should be kept using tail-based logic.
 *
 * Rules (applied in order):
 * 1. If `config.keepErrorSpans` is true and the span has `status === 'error'`,
 *    keep it unconditionally.
 * 2. If `config.keepErrorSpans` is true and the span has any event named
 *    `'error'`, keep it unconditionally.
 * 3. Otherwise, apply a random sample at `config.sampleRate`.
 *
 * Note: Step 3 uses `Math.random()` (non-deterministic) deliberately — tail
 * sampling is about keeping a representative sample of healthy traffic after
 * the fact. Only head-based sampling uses deterministic hashing.
 *
 * @param span   - The completed span to evaluate.
 * @param config - Tail sampling configuration.
 * @returns `true` if the span should be kept.
 */
export function shouldSampleTail(span: Span, config: TailSamplingConfig): boolean {
  if (config.keepErrorSpans) {
    if (span.status === 'error') return true;
    if (span.events.some((e) => e.name === 'error')) return true;
  }
  if (config.sampleRate >= 1) return true;
  if (config.sampleRate <= 0) return false;
  return Math.random() < config.sampleRate;
}

/**
 * Resolve a per-route sample rate override for a given route path.
 *
 * Lookup order:
 * 1. Exact match (`overrides[route]`)
 * 2. Longest prefix match (the override key that is a prefix of `route`
 *    and is the longest such key)
 * 3. `undefined` — no override applies; use the global sample rate
 *
 * @param route     - The incoming request path (e.g. `"/api/streams/abc"`).
 * @param overrides - Map of route path → sample rate.
 * @returns The matched override (`{ rate, key }`), or `undefined` if no match.
 *   The `key` is the override that matched, so callers can rewrite the
 *   recorded route attribute to the canonical (non-identifying) override key.
 */
export function resolvePerRouteOverride(
  route: string,
  overrides: Record<string, number>
): { rate: number; key: string } | undefined {
  // 1. Exact match
  if (Object.prototype.hasOwnProperty.call(overrides, route)) {
    return { rate: overrides[route], key: route };
  }

  // 2. Longest prefix match (segment-aware)
  let best: { key: string; rate: number } | undefined;
  for (const [key, rate] of Object.entries(overrides)) {
    const isPrefix = key.endsWith('/') ? route.startsWith(key) : route.startsWith(`${key}/`);
    if (isPrefix) {
      if (best === undefined || key.length > best.key.length) {
        best = { key, rate };
      }
    }
  }

  return best;
}
