/**
 * Structured JSON logger.
 *
 * Every log record is a single-line JSON object containing at minimum:
 *   { timestamp, level, message }
 * plus an optional `correlationId` and any extra `meta` fields.
 *
 * Output goes to stdout for info/warn/debug and stderr for error so that
 * log-shipping agents and shell pipelines can separate severity streams.
 */

import { sanitize, redactKeysInString } from '../pii/sanitizer.js';
import { getCorrelationId } from '../tracing/middleware.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  correlationId?: string;
  [key: string]: unknown;
}

function write(level: LogLevel, message: string, correlationId?: string, meta?: Record<string, unknown>): void {
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

export function info(message: string, context: LogContext = {}): void {
  const { correlationId, meta } = splitContext(context);
  write('info', message, correlationId, meta);
}

export function warn(message: string, context: LogContext = {}): void {
  const { correlationId, meta } = splitContext(context);
  write('warn', message, correlationId, meta);
}

export function error(message: string, context: LogContext = {}, err?: Error): void {
  const { correlationId, meta } = splitContext(context);
  write('error', message, correlationId, { ...meta, ...(err ? { error: err.message, stack: err.stack } : {}) });
}

export function debug(message: string, context: LogContext = {}): void {
  if (process.env.LOG_LEVEL === 'debug') {
    const { correlationId, meta } = splitContext(context);
    write('debug', message, correlationId, meta);
  }
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
  debug(message: string, correlationId?: string, meta?: Record<string, unknown>): void {
    write('debug', message, correlationId, meta);
  },
  info(message: string, correlationId?: string, meta?: Record<string, unknown>): void {
    write('info', message, correlationId, meta);
  },
  warn(message: string, correlationId?: string, meta?: Record<string, unknown>): void {
    write('warn', message, correlationId, meta);
  },
  error(message: string, correlationId?: string, meta?: Record<string, unknown>): void {
    write('error', message, correlationId, meta);
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

