/**
 * Metric label cardinality policy and enforcement helpers.
 *
 * Prometheus/OpenMetrics time series grow with every unique label-value
 * combination. Unbounded values (stream IDs, path parameters, tenants,
 * addresses) must never appear as label values.
 *
 * @module metrics/cardinality
 * @see docs/observability/metric-cardinality.md
 */

/** Sentinel used when a path segment is recognised as high-cardinality. */
export const HIGH_CARDINALITY_BUCKET = ':id';

/** Sentinel for Stellar account / contract address path segments. */
export const ADDRESS_BUCKET = ':address';

/** Sentinel for unmatched / unrecognised dynamic paths. */
export const UNKNOWN_ROUTE_BUCKET = 'unmatched';

/**
 * Label names that are always forbidden on collectors — they encode
 * per-entity identifiers and would explode series cardinality.
 */
export const FORBIDDEN_LABEL_NAMES: ReadonlySet<string> = new Set([
  'stream_id',
  'streamId',
  'event_id',
  'eventId',
  'tenant',
  'tenant_id',
  'tenantId',
  'user_id',
  'userId',
  'address',
  'public_key',
  'publicKey',
  'wallet',
  'jti',
  'subject',
  'request_id',
  'requestId',
  'correlation_id',
  'correlationId',
  'idempotency_key',
  'idempotencyKey',
  'api_key',
  'apiKey',
  'raw_path',
  'original_url',
  'originalUrl',
  'query',
  'url',
]);

/**
 * Label names that are allowed when their values come from a closed enum
 * or a cardinality-bounded normaliser (e.g. route templates).
 */
export const ALLOWED_LABEL_NAMES: ReadonlySet<string> = new Set([
  'method',
  'route',
  'path',
  'status',
  'status_code',
  'outcome',
  'reason',
  'operation',
  'result',
  'identifier_type',
  'repository',
  'table_hint',
  'consumer_hash',
  'service',
]);

/** UUID v1–v5 (any variant nibble). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Stellar account (G…) or contract (C…) strkey — 56 chars. */
const STELLAR_STRKEY_RE = /^[GC][A-Z0-9]{55}$/;

/** Long hex / hash-like tokens (tx hashes, opaque ids). */
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;

/** Pure numeric ids. */
const NUMERIC_ID_RE = /^\d{3,}$/;

/** ULID / Crockford base32 opaque ids (26 chars). */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** Cuid-like tokens. */
const CUID_RE = /^c[a-z0-9]{24,}$/i;

/**
 * Returns true when a single path segment looks like an unbounded identifier.
 */
export function isHighCardinalitySegment(segment: string): boolean {
  if (!segment || segment === '/' || segment.startsWith(':')) return false;
  if (UUID_RE.test(segment)) return true;
  if (STELLAR_STRKEY_RE.test(segment)) return true;
  if (LONG_HEX_RE.test(segment)) return true;
  if (NUMERIC_ID_RE.test(segment)) return true;
  if (ULID_RE.test(segment)) return true;
  if (CUID_RE.test(segment)) return true;
  // Catch-all: long opaque tokens that are not known static vocabulary.
  if (segment.length >= 24 && /[0-9]/.test(segment) && /[a-z]/i.test(segment)) {
    return true;
  }
  return false;
}

/**
 * Bucket a single path segment according to the cardinality policy.
 */
export function bucketPathSegment(segment: string): string {
  if (!segment) return segment;
  if (STELLAR_STRKEY_RE.test(segment)) return ADDRESS_BUCKET;
  if (isHighCardinalitySegment(segment)) return HIGH_CARDINALITY_BUCKET;
  return segment;
}

/**
 * Normalise a request path into a bounded Prometheus `route` / `path` label.
 *
 * - Strips query strings.
 * - Collapses trailing slashes (except bare `/`).
 * - Replaces high-cardinality segments (UUIDs, numeric ids, Stellar addresses,
 *   opaque hashes) with stable buckets (`:id`, `:address`).
 *
 * @example
 * normalizeRouteLabel('/api/streams/550e8400-e29b-41d4-a716-446655440000')
 * // => '/api/streams/:id'
 */
export function normalizeRouteLabel(rawPath: string): string {
  if (!rawPath) return UNKNOWN_ROUTE_BUCKET;

  let path = rawPath.split('?')[0] ?? rawPath;
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  if (path === '/' || path === '') return '/';

  const parts = path.split('/');
  const normalised = parts.map((part, index) => {
    // Keep empty leading segment from absolute paths ("", "api", ...).
    if (index === 0 && part === '') return '';
    if (part === '') return '';
    return bucketPathSegment(part);
  });

  const joined = normalised.join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/**
 * Assert that a collector's label names comply with the cardinality policy.
 * Throws when a forbidden label name is present.
 *
 * Call this from new collector modules (or their unit tests) so high-cardinality
 * label names cannot ship unnoticed.
 */
export function assertCollectorLabels(labelNames: readonly string[]): void {
  for (const name of labelNames) {
    if (FORBIDDEN_LABEL_NAMES.has(name)) {
      throw new Error(
        `Metric label "${name}" is forbidden by the cardinality policy ` +
          `(docs/observability/metric-cardinality.md). Use a closed enum or ` +
          `normalizeRouteLabel() / a hash bucket instead.`,
      );
    }
  }
}

/**
 * Count unique label-set series for a named metric in a Prometheus text scrape.
 * Used by tests to assert series count stays bounded under varied input.
 */
export function countMetricSeries(prometheusText: string, metricName: string): number {
  const series = new Set<string>();
  const prefix = `${metricName}{`;
  for (const line of prometheusText.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    // Ignore HELP/TYPE comments (they start with '#').
    const end = line.indexOf('}');
    if (end === -1) continue;
    series.add(line.slice(0, end + 1));
  }
  // Also count bare samples with no labels: metricName <value>
  const bare = new RegExp(`^${metricName}(?:\\s|$)`);
  for (const line of prometheusText.split('\n')) {
    if (bare.test(line) && !line.startsWith(`${metricName}{`)) {
      series.add(metricName);
    }
  }
  return series.size;
}
