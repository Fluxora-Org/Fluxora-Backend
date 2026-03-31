/**
 * Structured, PII-safe logger for Fluxora backend.
 *
 * Wraps standard console output with automatic redaction of
 * sensitive fields and Stellar keys. Every log entry is emitted
 * as a single JSON line so downstream aggregators can parse it
 * without custom grammars.
 */

import { sanitize, redactKeysInString } from '../pii/sanitizer.js';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

interface LogEntry {
  level: LogLevel;
  ts: string;
  msg: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    ts: new Date().toISOString(),
    msg: redactKeysInString(message),
  };

  if (meta) {
    const safe = sanitize(meta);
    for (const [key, value] of Object.entries(safe)) {
      if (key !== 'level' && key !== 'ts' && key !== 'msg') {
        entry[key] = value;
      }
    }
  }

  const line = JSON.stringify(entry);

  switch (level) {
    case LogLevel.ERROR:
      console.error(line);
      break;
    case LogLevel.WARN:
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    emit(LogLevel.DEBUG, message, meta);
  },
  info(message: string, meta?: Record<string, unknown>): void {
    emit(LogLevel.INFO, message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    emit(LogLevel.WARN, message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    emit(LogLevel.ERROR, message, meta);
  },
};
