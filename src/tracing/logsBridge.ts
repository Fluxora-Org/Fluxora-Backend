import { getRuntimeEnv } from '../config/runtime-env.js';
/**
 * OpenTelemetry Logs Bridge for Fluxora Backend.
 *
 * Forwards every structured log entry emitted by `src/lib/logger.ts` as an
 * OpenTelemetry {@link https://opentelemetry.io/docs/specs/otel/logs/ LogRecord},
 * enabling log-trace correlation in backends such as Datadog and Elastic.
 *
 * ## Additive design
 * The bridge does NOT replace existing console/file logging. It runs alongside
 * it. Each call to `write()` in `src/lib/logger.ts` first writes its JSON line
 * to stdout/stderr (unchanged) and then – when
 * `TRACING_OTEL_ENABLED=true` – emits an equivalent OTel LogRecord.
 *
 * ## PII handling
 * All metadata attached to a LogRecord is sanitized using the same
 * {@link sanitize} / {@link redactKeysInString} pipeline that the structured
 * logger already applies. No PII escapes through the OTel path.
 *
 * ## Trace / span correlation
 * When a request is active, `trace.getActiveSpan()?.spanContext()` supplies
 * the W3C `traceId` and `spanId`. These are attached to every LogRecord so
 * that log and trace backends can join entries without additional work.
 *
 * ## Failure safety
 * Any error thrown by the OTel SDK is caught and silently ignored. A broken
 * exporter or misconfigured collector can never affect application behaviour.
 *
 * ## Input validation
 * Caller-supplied input is validated before any LogRecord is built or emitted.
 * Invalid input raises a {@link LogsBridgeValidationError} carrying the
 * offending `field` and a machine-readable `reason`, so callers can tell why
 * the entry was rejected. Validation runs before any sanitisation or OTel
 * logger access, so a rejected entry has no observable side effects.
 *
 * ## Environment variables
 * | Variable              | Default | Description                           |
 * |---------------------- |---------|---------------------------------------|
 * | `TRACING_OTEL_ENABLED`| `false` | Enable the bridge; all other calls    |
 * |                       |         | are no-ops when this is `false`.       |
 *
 * @module logsBridge
 */

import { logs, SeverityNumber, type LogRecord as OtelLogRecord } from '@opentelemetry/api-logs';
import { context, trace } from '@opentelemetry/api';
import { sanitize, redactKeysInString } from '../pii/sanitizer.js';
import type { LogLevel } from '../lib/logger.js';

// ── Internal constants ────────────────────────────────────────────────────────

/** Instrumentation scope name registered with the OTel LoggerProvider. */
const INSTRUMENTATION_SCOPE = 'fluxora-backend/logs-bridge';

/** Instrumentation scope version – kept in sync with the package version at runtime. */
const INSTRUMENTATION_VERSION =
  (typeof process !== 'undefined' && getRuntimeEnv().npm_package_version) || '0.0.0';

// ── Input validation ─────────────────────────────────────────────────────────

/** Maximum UTF-8 byte length accepted for a log message. */
export const LOGS_BRIDGE_MAX_MESSAGE_BYTES = 64 * 1024;

/** Maximum UTF-8 byte length accepted for a correlation ID. */
export const LOGS_BRIDGE_MAX_CORRELATION_ID_BYTES = 256;

/** Maximum UTF-8 byte length accepted for the serialised metadata object. */
export const LOGS_BRIDGE_MAX_META_BYTES = 64 * 1024;

/** Field in the logs bridge API that failed validation. */
export type LogsBridgeValidationField =
  | 'enabled'
  | 'level'
  | 'message'
  | 'correlationId'
  | 'meta';

/** Machine-readable reason an input was rejected. */
export type LogsBridgeValidationReason =
  | 'invalid_type'
  | 'invalid_level'
  | 'empty'
  | 'oversized'
  | 'unserializable';

/**
 * Typed error raised when a logs bridge input is malformed, empty or too large.
 *
 * `field` identifies which argument is wrong and `reason` explains the failure
 * class without requiring callers to parse the human-readable message.
 */
export class LogsBridgeValidationError extends Error {
  readonly code = 'LOGS_BRIDGE_INVALID_INPUT';
  readonly field: LogsBridgeValidationField;
  readonly reason: LogsBridgeValidationReason;

  constructor(
    field: LogsBridgeValidationField,
    reason: LogsBridgeValidationReason,
    detail: string,
  ) {
    super(`logsBridge: invalid ${field}: ${detail}`);
    this.name = 'LogsBridgeValidationError';
    this.field = field;
    this.reason = reason;
    Object.setPrototypeOf(this, LogsBridgeValidationError.prototype);
  }
}

const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const rendered = value.length > 32 ? `${value.slice(0, 32)}…` : value;
    return `string ${JSON.stringify(rendered)}`;
  }
  return typeof value;
}

function assertValidLevel(level: unknown): asserts level is LogLevel {
  if (typeof level !== 'string' || !VALID_LOG_LEVELS.includes(level as LogLevel)) {
    throw new LogsBridgeValidationError(
      'level',
      'invalid_level',
      `expected one of ${VALID_LOG_LEVELS.join(', ')}; received ${describeValue(level)}`,
    );
  }
}

function assertValidMessage(message: unknown): asserts message is string {
  if (typeof message !== 'string') {
    throw new LogsBridgeValidationError(
      'message',
      'invalid_type',
      `expected a string; received ${describeValue(message)}`,
    );
  }

  // Bound the raw value before trimming or sanitising so an oversized input
  // is rejected without doing work proportional to its size.
  const bytes = Buffer.byteLength(message, 'utf8');
  if (bytes > LOGS_BRIDGE_MAX_MESSAGE_BYTES) {
    throw new LogsBridgeValidationError(
      'message',
      'oversized',
      `expected at most ${LOGS_BRIDGE_MAX_MESSAGE_BYTES} UTF-8 bytes; received ${bytes}`,
    );
  }

  if (message.trim().length === 0) {
    throw new LogsBridgeValidationError(
      'message',
      'empty',
      'expected a non-empty, non-whitespace string',
    );
  }
}

function assertValidCorrelationId(
  correlationId: unknown,
): asserts correlationId is string | undefined {
  // `null` is accepted as an explicit "no correlation ID" value; it has always
  // been ignored by the bridge and is not malformed input.
  if (correlationId === undefined || correlationId === null) return;

  if (typeof correlationId !== 'string') {
    throw new LogsBridgeValidationError(
      'correlationId',
      'invalid_type',
      `expected a string or undefined; received ${describeValue(correlationId)}`,
    );
  }

  const bytes = Buffer.byteLength(correlationId, 'utf8');
  if (bytes > LOGS_BRIDGE_MAX_CORRELATION_ID_BYTES) {
    throw new LogsBridgeValidationError(
      'correlationId',
      'oversized',
      `expected at most ${LOGS_BRIDGE_MAX_CORRELATION_ID_BYTES} UTF-8 bytes; received ${bytes}`,
    );
  }

  if (correlationId.trim().length === 0) {
    throw new LogsBridgeValidationError(
      'correlationId',
      'empty',
      'expected a non-empty, non-whitespace string when provided',
    );
  }
}

function assertValidMeta(meta: unknown): asserts meta is Record<string, unknown> | undefined {
  // `null` is accepted as an explicit "no metadata" value, matching the
  // bridge's historical `meta ? ... : {}` behaviour.
  if (meta === undefined || meta === null) return;

  if (typeof meta !== 'object' || Array.isArray(meta)) {
    throw new LogsBridgeValidationError(
      'meta',
      'invalid_type',
      `expected a plain object or undefined; received ${describeValue(meta)}`,
    );
  }

  const prototype = Object.getPrototypeOf(meta);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LogsBridgeValidationError(
      'meta',
      'invalid_type',
      'expected a plain object or undefined',
    );
  }

  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(meta);
  } catch {
    throw new LogsBridgeValidationError(
      'meta',
      'unserializable',
      'metadata must not contain circular references or non-JSON values',
    );
  }

  if (serialised === undefined) {
    throw new LogsBridgeValidationError(
      'meta',
      'unserializable',
      'metadata could not be serialised',
    );
  }

  const bytes = Buffer.byteLength(serialised, 'utf8');
  if (bytes > LOGS_BRIDGE_MAX_META_BYTES) {
    throw new LogsBridgeValidationError(
      'meta',
      'oversized',
      `expected at most ${LOGS_BRIDGE_MAX_META_BYTES} UTF-8 bytes; received ${bytes}`,
    );
  }
}

function assertValidLogInput(
  level: unknown,
  message: unknown,
  correlationId: unknown,
  meta: unknown,
): void {
  assertValidLevel(level);
  assertValidMessage(message);
  assertValidCorrelationId(correlationId);
  assertValidMeta(meta);
}

// ── Severity mapping ─────────────────────────────────────────────────────────

/**
 * Map a Fluxora log level string to the matching OTel {@link SeverityNumber}.
 *
 * The mapping follows the OpenTelemetry specification:
 * - `debug` → {@link SeverityNumber.DEBUG} (5)
 * - `info`  → {@link SeverityNumber.INFO}  (9)
 * - `warn`  → {@link SeverityNumber.WARN}  (13)
 * - `error` → {@link SeverityNumber.ERROR} (17)
 *
 * @param level - Fluxora log level string.
 * @returns The corresponding OTel SeverityNumber.
 */
function toSeverityNumber(level: LogLevel): SeverityNumber {
  switch (level) {
    case 'debug':
      return SeverityNumber.DEBUG;
    case 'info':
      return SeverityNumber.INFO;
    case 'warn':
      return SeverityNumber.WARN;
    case 'error':
      return SeverityNumber.ERROR;
    default: {
      // Exhaustiveness guard — unknown levels default to INFO.
      const _exhaustive: never = level;
      void _exhaustive;
      return SeverityNumber.INFO;
    }
  }
}

// ── Bridge state ──────────────────────────────────────────────────────────────

/**
 * Enabled flag. Set once by {@link initLogsBridge} and read on every log call.
 * Guarded by a boolean rather than a nullable reference so the hot-path branch
 * predictor stays warm.
 */
let bridgeEnabled = false;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the logs bridge.
 *
 * Must be called once during application startup (after the OTel SDK has
 * been started) when `TRACING_OTEL_ENABLED=true`. Subsequent calls are
 * idempotent.
 *
 * The bridge is a pure no-op until this function is called with
 * `enabled: true`.
 *
 * @param input.enabled - Whether to activate the bridge.
 *                        Typically `config.tracingOtelEnabled`.
 * @throws {LogsBridgeValidationError} When `input` or `input.enabled` is not
 *         the expected shape. The enabled state is not changed on rejection.
 *
 * @example
 * ```ts
 * import { initLogsBridge } from './tracing/logsBridge.js';
 * import { config } from './config/env.js';
 *
 * // After startTracing():
 * initLogsBridge({ enabled: config.tracingOtelEnabled });
 * ```
 */
export function initLogsBridge(input: { enabled: boolean }): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new LogsBridgeValidationError(
      'enabled',
      'invalid_type',
      `expected an object with a boolean "enabled" field; received ${describeValue(input)}`,
    );
  }

  const { enabled } = input as { enabled?: unknown };
  if (typeof enabled !== 'boolean') {
    throw new LogsBridgeValidationError(
      'enabled',
      'invalid_type',
      `expected a boolean; received ${describeValue(enabled)}`,
    );
  }

  bridgeEnabled = enabled;
}

/**
 * Returns `true` when the bridge has been activated.
 * Exposed primarily for testing; application code should not need this.
 */
export function isLogsBridgeEnabled(): boolean {
  return bridgeEnabled;
}

/**
 * Reset the bridge to the disabled state.
 *
 * **For testing only.** Not thread-safe; do not call in production code.
 */
export function resetLogsBridge(): void {
  bridgeEnabled = false;
}

/**
 * Forward a single structured log entry as an OTel {@link LogRecord}.
 *
 * Called by the patched `write()` function in `src/lib/logger.ts` **after**
 * the normal console/file write has already occurred. If the bridge is
 * disabled this function returns immediately without allocating any objects.
 *
 * ### PII guarantees
 * - `message` is run through {@link redactKeysInString} to mask any Stellar
 *   keys that escaped into the message text.
 * - `meta` is deep-sanitized via {@link sanitize}, which removes or masks
 *   every field listed in `src/pii/policy.ts`.
 *
 * ### Trace correlation
 * If an active OTel span exists in the current async context, its W3C
 * `traceId` and `spanId` are attached to the LogRecord as
 * `trace.id` / `span.id` attributes and the OTel context is propagated so
 * that collector pipelines can link the record to its trace.
 *
 * ### Failure safety
 * Any exception thrown by the OTel SDK (network error, serialisation error,
 * provider not initialised, etc.) is swallowed so that logging always
 * succeeds regardless of tracing health.
 *
 * ### Input validation
 * When the bridge is enabled, malformed, empty or oversized inputs raise a
 * {@link LogsBridgeValidationError} before sanitisation or OTel logger access.
 * Validation errors are caller errors and are never swallowed.
 *
 * @param level         - Log level: `'debug' | 'info' | 'warn' | 'error'`.
 * @param message       - Non-empty human-readable log message.
 * @param correlationId - Optional request correlation ID.
 * @param meta          - Optional structured metadata (will be sanitized here).
 * @throws {LogsBridgeValidationError} When an input is malformed, empty or
 *         exceeds the documented size limits.
 */
export function forwardToOtel(
  level: LogLevel,
  message: string,
  correlationId: string | undefined,
  meta: Record<string, unknown> | undefined,
): void {
  if (!bridgeEnabled) return;

  // Validate before sanitising, building attributes or touching the OTel
  // logger. A rejected entry therefore has no observable side effects and the
  // typed error is not swallowed by the failure-safety catch below.
  assertValidLogInput(level, message, correlationId, meta);

  try {
    // ── Sanitize inputs ────────────────────────────────────────────────────
    // The structured logger has already run redactKeysInString on the message
    // and sanitize on meta, but we run them again here as a defence-in-depth
    // measure: the bridge must never forward PII to an external collector even
    // if the caller skips sanitization.
    const safeMessage = redactKeysInString(message);
    const safeMeta: Record<string, unknown> = meta
      ? (sanitize(meta as Record<string, unknown>) as Record<string, unknown>)
      : {};

    // ── Build attributes ───────────────────────────────────────────────────
    // Flatten the meta object into OTel attribute key/value pairs.
    // Only primitive-compatible values are included; nested objects are
    // JSON-stringified so they survive attribute serialisation.
    const attributes: Record<string, string | number | boolean> = {};

    if (correlationId) {
      attributes['correlation.id'] = correlationId;
    }

    for (const [key, value] of Object.entries(safeMeta)) {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        // Run Stellar key masking on string values as a final defence-in-depth
        // pass. This catches keys embedded in free-form text that `sanitize()`
        // would not redact because the field name is not in the PII deny-list.
        attributes[key] = typeof value === 'string' ? redactKeysInString(value) : value;
      } else if (value !== null && value !== undefined) {
        // Nested object or array: stringify to preserve information without
        // losing data in backends that don't support nested attributes.
        try {
          attributes[key] = JSON.stringify(value);
        } catch {
          // Circular structures etc. — skip the field.
        }
      }
    }

    // ── Capture trace context ──────────────────────────────────────────────
    // Attempt to correlate the log record with the currently active OTel
    // span. Failing to find a span is normal (e.g. background jobs outside
    // a request context) and must not throw.
    const activeCtx = context.active();
    const spanContext = trace.getActiveSpan()?.spanContext();

    if (spanContext) {
      attributes['trace.id'] = spanContext.traceId;
      attributes['span.id'] = spanContext.spanId;
    }

    // ── Build and emit the LogRecord ───────────────────────────────────────
    const logRecord: OtelLogRecord = {
      timestamp: Date.now(),
      severityNumber: toSeverityNumber(level),
      severityText: level.toUpperCase(),
      body: safeMessage,
      attributes,
      context: activeCtx,
    };

    logs
      .getLogger(INSTRUMENTATION_SCOPE, INSTRUMENTATION_VERSION)
      .emit(logRecord);
  } catch {
    // OTel failures must never surface to the caller.
    // The structured log line was already written to stdout/stderr before
    // this function was called, so no data is lost.
  }
}
