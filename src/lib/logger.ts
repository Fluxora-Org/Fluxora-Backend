/**
 * Structured JSON logger.
 *
 * Every log record is a single-line JSON object containing at minimum:
 *   { timestamp, level, message }
 * plus an optional `correlationId` and any extra `meta` fields.
 *
 * Output goes to stdout for info/warn/debug and stderr for error so that
 * log-shipping agents and shell pipelines can separate severity streams.
 *
 * ## OpenTelemetry Logs Bridge
 * When `TRACING_OTEL_ENABLED=true` and {@link initLogsBridge} has been called,
 * each log entry is also forwarded to the OTel Logs API via
 * `src/tracing/logsBridge.ts`. The OTel emission is **additive** — existing
 * console/file behaviour is never altered.
 */

import { sanitize, sanitizeError, redactKeysInString } from '../pii/sanitizer.js';
import { getCorrelationId } from '../tracing/middleware.js';
import { forwardToOtel } from '../tracing/logsBridge.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  correlationId?: string;
  [key: string]: unknown;
}

/**
 * Log levels ordered from most to least verbose. The order is load-bearing: a
 * record is emitted when its level ranks at or above the active level (see
 * {@link isLevelEnabled}).
 */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolve the level the logger starts with.
 *
 * `LOG_LEVEL` wins when it holds a valid level. Otherwise production-like
 * environments default to `info` (the schema default) while test and local
 * environments default to `debug`, so nothing is silently dropped there.
 */
function resolveInitialLogLevel(): LogLevel {
  const configured = process.env.LOG_LEVEL;
  if (isLogLevel(configured)) return configured;
  return process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
    ? 'info'
    : 'debug';
}

let activeLogLevel: LogLevel = resolveInitialLogLevel();

/**
 * Whether a record at `level` should be emitted for the active level.
 *
 * `error` is unconditionally enabled: error output is the one failure signal
 * operators must never be able to silence through configuration.
 */
export function isLevelEnabled(level: LogLevel, active: LogLevel = activeLogLevel): boolean {
  if (level === 'error') return true;
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[active];
}

/** Set the active log level. Invalid values are ignored; the active level is returned. */
export function setLogLevel(level: LogLevel): LogLevel {
  if (isLogLevel(level)) activeLogLevel = level;
  return activeLogLevel;
}

/** The level the logger is currently filtering at. */
export function getLogLevel(): LogLevel {
  return activeLogLevel;
}

function write(
  level: LogLevel,
  message: string,
  correlationId?: string,
  meta?: Record<string, unknown>,
  options: { force?: boolean } = {}
): void {
  if (!options.force && !isLevelEnabled(level)) return;
  // Sanitize the message and metadata
  const sanitizedMessage = redactKeysInString(message);
  const sanitizedMeta = meta ? sanitize(meta) : undefined;
  
  const currentCorrelationId = correlationId ?? getCorrelationId();

  // meta is spread first so core fields (timestamp, level, message, correlationId)
  // always take precedence and cannot be overwritten by callers.
  const record: LogRecord = {
    ...sanitizedMeta,
    timestamp: new Date().toISOString(),
    level,
    message: sanitizedMessage,
    ...(currentCorrelationId && currentCorrelationId !== 'unknown' ? { correlationId: currentCorrelationId } : {}),
  };
  const line = JSON.stringify(record) + '\n';
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }

  // Additive OTel emission: forward the log record to the OTel Logs API when
  // TRACING_OTEL_ENABLED=true. This is a no-op when the bridge is disabled.
  // Errors thrown by the bridge are swallowed inside forwardToOtel() so they
  // can never interfere with the primary logging path.
  forwardToOtel(level, sanitizedMessage, currentCorrelationId, sanitizedMeta);
}

/**
 * Emit a record that bypasses level filtering.
 *
 * Reserved for boot-time diagnostics (for example the effective log level)
 * that must always be visible, even when the configured level would otherwise
 * suppress them.
 */
export function writeAlways(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  write(level, message, undefined, meta, { force: true });
}

/**
 * Backward-compatible functional API.
 *
 * Several modules (auth middleware, stream routes, repositories, the
 * indexer service, etc.) still import standalone `debug`/`info`/`warn`/
 * `error`/`SerializationLogger` from the logger module using the
 * pre-consolidation signature `(message, context)` rather than the
 * `logger.<level>(message, correlationId?, meta?)` object API above. These
 * shims restore that surface — routed through the same sanitizing `write()`
 * — so existing call sites keep working without each needing to be touched.
 */
export interface LogContext {
  correlationId?: string;
  [key: string]: unknown;
}

function splitContext(context: LogContext = {}): { correlationId?: string; meta?: Record<string, unknown> } {
  const { correlationId, ...meta } = context;
  return { correlationId, meta };
}

function normalizeLogArguments(
  correlationOrContext?: string | LogContext,
  meta?: Record<string, unknown>,
): { correlationId?: string; meta?: Record<string, unknown> } {
  if (typeof correlationOrContext === 'string') {
    return { correlationId: correlationOrContext, meta };
  }

  if (correlationOrContext && typeof correlationOrContext === 'object') {
    const { correlationId, ...rest } = correlationOrContext as LogContext;
    const mergedMeta = Object.keys(rest).length > 0 ? (rest as Record<string, unknown>) : meta;
    return {
      correlationId: typeof correlationId === 'string' ? correlationId : undefined,
      meta: mergedMeta,
    };
  }

  return { meta };
}

export function info(message: string, correlationOrContext?: string | LogContext, meta?: Record<string, unknown>): void {
  const { correlationId, meta: resolvedMeta } = normalizeLogArguments(correlationOrContext, meta);
  write('info', message, correlationId, resolvedMeta);
}

export function warn(message: string, correlationOrContext?: string | LogContext, meta?: Record<string, unknown>): void {
  const { correlationId, meta: resolvedMeta } = normalizeLogArguments(correlationOrContext, meta);
  write('warn', message, correlationId, resolvedMeta);
}

export function error(
  message: string,
  correlationOrContext?: string | LogContext,
  errOrMeta?: Error | Record<string, unknown>,
  maybeMeta?: Record<string, unknown>,
): void {
  const normalized = normalizeLogArguments(
    typeof correlationOrContext === 'string' || correlationOrContext && typeof correlationOrContext === 'object'
      ? correlationOrContext
      : undefined,
    typeof errOrMeta === 'object' && errOrMeta !== null && !(errOrMeta instanceof Error)
      ? errOrMeta
      : maybeMeta,
  );

  const finalMeta =
    typeof errOrMeta === 'object' && errOrMeta !== null && errOrMeta instanceof Error
      ? { ...(normalized.meta ?? {}), error: sanitizeError(errOrMeta) }
      : { ...(normalized.meta ?? {}), ...(errOrMeta && typeof errOrMeta === 'object' && !(errOrMeta instanceof Error) ? errOrMeta : {}) };

  write('error', message, normalized.correlationId, finalMeta);
}

export function debug(message: string, correlationOrContext?: string | LogContext, meta?: Record<string, unknown>): void {
  const { correlationId, meta: resolvedMeta } = normalizeLogArguments(correlationOrContext, meta);
  write('debug', message, correlationId, resolvedMeta);
}

export const SerializationLogger = {
  validationFailed: (field: string, raw: unknown, code: string, requestId?: string): void => {
    warn(`Decimal validation failed: ${field}`, { field, raw, code, requestId });
  },
  amountSerialized: (count: number, requestId?: string): void => {
    debug(`Amounts serialized: ${count}`, { requestId });
  },
};

export const logger = {
  debug(message: string, correlationOrContext?: string | LogContext, meta?: Record<string, unknown>): void {
    const { correlationId, meta: resolvedMeta } = normalizeLogArguments(correlationOrContext, meta);
    write('debug', message, correlationId, resolvedMeta);
  },
  info(message: string, correlationOrContext?: string | LogContext, meta?: Record<string, unknown>): void {
    const { correlationId, meta: resolvedMeta } = normalizeLogArguments(correlationOrContext, meta);
    write('info', message, correlationId, resolvedMeta);
  },
  warn(message: string, correlationOrContext?: string | LogContext, meta?: Record<string, unknown>): void {
    const { correlationId, meta: resolvedMeta } = normalizeLogArguments(correlationOrContext, meta);
    write('warn', message, correlationId, resolvedMeta);
  },
  error(message: string, correlationOrContext?: string | LogContext, meta?: Record<string, unknown>): void {
    const { correlationId, meta: resolvedMeta } = normalizeLogArguments(correlationOrContext, meta);
    write('error', message, correlationId, resolvedMeta);
  },
  /**
   * Emit a SIEM-compatible OCSF slow-query log entry (OCSF Database Activity, class_uid 5001).
   * Raw SQL and parameter values are never included — only the query_hash, duration, and table hint.
   */
  slowQuery(fields: {
    query_hash: string;
    duration_ms: number;
    table_hint: string;
    correlation_id?: string;
  }): void {
    const currentCorrelationId = fields.correlation_id ?? getCorrelationId();
    const outFields = { ...fields };
    if (currentCorrelationId && currentCorrelationId !== 'unknown') {
      outFields.correlation_id = currentCorrelationId;
    } else {
      delete outFields.correlation_id;
    }
    const record = {
      log_type: 'slow_query',
      class_uid: 5001,       // OCSF Database Activity
      activity_id: 1,        // Query
      severity_id: 3,        // Medium
      severity: 'Medium',
      time: new Date().toISOString(),
      ...outFields,
    };
    process.stdout.write(JSON.stringify(record) + '\n');
  },
};

export type Logger = typeof logger;

