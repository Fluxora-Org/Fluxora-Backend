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

/** Maximum accepted length for a raw path or a single path segment. */
export const MAX_PATH_LENGTH = 2048;

/** Maximum accepted length for a Prometheus label name. */
export const MAX_LABEL_NAME_LENGTH = 255;

/** Maximum accepted length for a Prometheus metric name. */
export const MAX_METRIC_NAME_LENGTH = 255;

/** Maximum accepted length for a Prometheus text scrape handed to countMetricSeries. */
export const MAX_PROMETHEUS_TEXT_LENGTH = 1024 * 1024;

/** Machine-readable reason a cardinality input was rejected. */
export type CardinalityValidationCode =
  | 'INVALID_TYPE'
  | 'EMPTY_INPUT'
  | 'OVERSIZED_INPUT'
  | 'MALFORMED_INPUT'
  | 'FORBIDDEN_LABEL';

/**
 * Typed error for inputs rejected by the cardinality policy.
 *
 * Callers can branch on {@link code} while logs / API responses can use
 * {@link reason}, which never echoes the offending value.
 */
export class CardinalityValidationError extends Error {
  readonly code: CardinalityValidationCode;
  readonly field: string;
  readonly inputName: string;
  readonly reason: string;

  constructor(field: string, code: CardinalityValidationCode, reason: string) {
    super(`Invalid ${field}: ${reason}`);
    this.name = 'CardinalityValidationError';
    this.code = code;
    this.field = field;
    this.inputName = field;
    this.reason = reason;
  }
}

/** Control characters never belong in a metric path or label input. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/** Prometheus metric names: [a-zA-Z_:][a-zA-Z0-9_:]*. */
const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** Prometheus label names: [a-zA-Z_][a-zA-Z0-9_]*. */
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertString(
  value: unknown,
  field: string,
  maxLength: number,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new CardinalityValidationError(
      field,
      'INVALID_TYPE',
      `expected a string, received ${value === null ? 'null' : typeof value}`,
    );
  }
  if (value.trim().length === 0) {
    throw new CardinalityValidationError(field, 'EMPTY_INPUT', 'value must not be empty');
  }
  if (value.length > maxLength) {
    throw new CardinalityValidationError(
      field,
      'OVERSIZED_INPUT',
      `value must be at most ${maxLength} characters (received ${value.length})`,
    );
  }
}

function assertPathInput(
  value: unknown,
  field: string,
  maxLength = MAX_PATH_LENGTH,
): asserts value is string {
  assertString(value, field, maxLength);
  if (CONTROL_CHARS_RE.test(value)) {
    throw new CardinalityValidationError(
      field,
      'MALFORMED_INPUT',
      'value must not contain control characters',
    );
  }
}

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
  assertPathInput(segment, 'segment');
  if (segment === '/' || segment.startsWith(':')) return false;
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
  assertPathInput(segment, 'segment');
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
  assertPathInput(rawPath, 'rawPath');

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
  if (!Array.isArray(labelNames)) {
    throw new CardinalityValidationError(
      'labelNames',
      'INVALID_TYPE',
      'expected an array of label names',
    );
  }

  // Validate the whole list before rejecting anything so callers get a
  // deterministic, typed error without any partial side effects.
  for (const [index, name] of labelNames.entries()) {
    assertString(name, `labelNames[${index}]`, MAX_LABEL_NAME_LENGTH);
    if (!LABEL_NAME_RE.test(name)) {
      throw new CardinalityValidationError(
        `labelNames[${index}]`,
        'MALFORMED_INPUT',
        'label name must match [a-zA-Z_][a-zA-Z0-9_]*',
      );
    }
  }

  for (const name of labelNames) {
    if (FORBIDDEN_LABEL_NAMES.has(name)) {
      throw new CardinalityValidationError(
        'labelNames',
        'FORBIDDEN_LABEL',
        `metric label "${name}" is forbidden by the cardinality policy ` +
          `(docs/observability/metric-cardinality.md); use a closed enum or ` +
          `normalizeRouteLabel() / a hash bucket instead`,
      );
    }
  }
}

/**
 * Count unique label-set series for a named metric in a Prometheus text scrape.
 * Used by tests to assert series count stays bounded under varied input.
 */
export function countMetricSeries(prometheusText: string, metricName: string): number {
  assertString(prometheusText, 'prometheusText', MAX_PROMETHEUS_TEXT_LENGTH);
  assertString(metricName, 'metricName', MAX_METRIC_NAME_LENGTH);
  if (!METRIC_NAME_RE.test(metricName)) {
    throw new CardinalityValidationError(
      'metricName',
      'MALFORMED_INPUT',
      'metric name must match [a-zA-Z_:][a-zA-Z0-9_:]*',
    );
  }

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
