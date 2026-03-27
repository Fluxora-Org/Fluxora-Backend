/**
 * Fluxora Backend Logging Utility
 *
 * Provides structured logging for operators to observe health and diagnose
 * incidents without relying on tribal knowledge.
 *
 * @module utils/logger
 */

import type { Request, Response, NextFunction } from 'express';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

export interface LogEntry {
  timestamp: string;
  level: string;
  service: string;
  message: string;
  context?: Record<string, unknown> | undefined;
  error?: {
    name: string;
    message: string;
    code?: string | undefined;
    stack?: string | undefined;
  } | undefined;
}

let currentLogLevel = (() => {
  const envLevel = process.env['LOG_LEVEL']?.toUpperCase();
  switch (envLevel) {
    case 'ERROR': return LogLevel.ERROR;
    case 'WARN':  return LogLevel.WARN;
    case 'INFO':  return LogLevel.INFO;
    case 'DEBUG': return LogLevel.DEBUG;
    default:      return LogLevel.INFO;
  }
})();

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

function formatLogEntry(entry: LogEntry): string {
  const contextStr = entry.context !== undefined ? ` ${JSON.stringify(entry.context)}` : '';
  const errorStr = entry.error !== undefined
    ? ` [ERROR: ${entry.error.name}: ${entry.error.message}]`
    : '';
  return `[${entry.timestamp}] ${entry.level}: ${entry.service} - ${entry.message}${contextStr}${errorStr}`;
}

function createLogEntry(
  level: string,
  message: string,
  context?: Record<string, unknown>,
  err?: Error & { code?: string },
): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'fluxora-backend',
    message,
  };

  if (context !== undefined) {
    entry.context = context;
  }

  if (err !== undefined) {
    const errorEntry: LogEntry['error'] = {
      name: err.name,
      message: err.message,
    };
    if (err.code !== undefined) errorEntry!.code = err.code;
    if (err.stack !== undefined) errorEntry!.stack = err.stack;
    entry.error = errorEntry;
  }

  return entry;
}

function log(
  level: LogLevel,
  levelStr: string,
  message: string,
  context?: Record<string, unknown>,
  err?: Error,
): void {
  if (level > currentLogLevel) return;

  const entry = createLogEntry(levelStr, message, context, err);
  const formatted = formatLogEntry(entry);

  if (level === LogLevel.ERROR) {
    console.error(formatted);
  } else if (level === LogLevel.WARN) {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
}

export function error(message: string, context?: Record<string, unknown>, err?: Error): void {
  log(LogLevel.ERROR, 'ERROR', message, context, err);
}

export function warn(message: string, context?: Record<string, unknown>): void {
  log(LogLevel.WARN, 'WARN', message, context);
}

export function info(message: string, context?: Record<string, unknown>): void {
  log(LogLevel.INFO, 'INFO', message, context);
}

export function debug(message: string, context?: Record<string, unknown>): void {
  log(LogLevel.DEBUG, 'DEBUG', message, context);
}

export namespace SerializationLogger {
  export function validationFailed(
    fieldName: string,
    receivedValue: unknown,
    errorCode: string,
    requestId?: string,
  ): void {
    error('Decimal validation failed', {
      field: fieldName,
      receivedType: typeof receivedValue,
      receivedValue: String(receivedValue).slice(0, 100),
      errorCode,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  export function amountSerialized(fieldCount: number, requestId?: string): void {
    debug('Amount fields serialized', {
      fieldCount,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  export function precisionLossPrevented(
    fieldName: string,
    originalValue: unknown,
    requestId?: string,
  ): void {
    warn('Precision loss prevented during serialization', {
      field: fieldName,
      originalValue: String(originalValue).slice(0, 100),
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  export function outOfRangeRejected(
    fieldName: string,
    value: unknown,
    requestId?: string,
  ): void {
    warn('Out-of-range decimal value rejected', {
      field: fieldName,
      value: String(value).slice(0, 100),
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
}

/**
 * Express middleware to attach a request ID from the x-request-id header.
 * @deprecated Prefer requestIdMiddleware from errors.ts for new code.
 */
export function requestIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  (req as Request & { id?: string }).id =
    typeof incoming === 'string' && incoming.length > 0
      ? incoming
      : `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  next();
}
