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
  
  // meta is spread first so core fields (timestamp, level, message, correlationId)
  // always take precedence and cannot be overwritten by callers.
  const record: LogRecord = {
    ...sanitizedMeta,
    timestamp: new Date().toISOString(),
    level,
    message: sanitizedMessage,
    ...(correlationId !== undefined ? { correlationId } : {}),
  };
  const line = JSON.stringify(record) + '\n';
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

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
};
