/**
 * Fluxora Backend Logging Utility
 * 
 * Purpose: Provide structured logging for operators to observe health and diagnose
 * incidents without relying on tribal knowledge.
 * 
 * Log levels:
 * - ERROR: Failures that require immediate attention
 * - WARN: Potential issues or degraded behavior
 * - INFO: Normal operational events
 * - DEBUG: Detailed information for troubleshooting
 * 
 * @module utils/logger
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

/**
 * Log entry structure for machine-readable logging
 */
export interface LogEntry {
  timestamp: string;
  level: string;
  service: string;
  message: string;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    code?: string;
    stack?: string;
  };
}

/**
 * Current log level (can be configured via environment)
 */
let currentLogLevel = (() => {
  const envLevel = process.env.LOG_LEVEL?.toUpperCase();
  switch (envLevel) {
    case 'ERROR': return LogLevel.ERROR;
    case 'WARN': return LogLevel.WARN;
    case 'INFO': return LogLevel.INFO;
    case 'DEBUG': return LogLevel.DEBUG;
    default: return LogLevel.INFO;
  }
})();

/**
 * Set the log level programmatically
 */
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

/**
 * Format a log entry as a string
 */
function formatLogEntry(entry: LogEntry): string {
  const contextStr = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
  const errorStr = entry.error ? ` [ERROR: ${entry.error.name}: ${entry.error.message}]` : '';
  return `[${entry.timestamp}] ${entry.level}: ${entry.service} - ${entry.message}${contextStr}${errorStr}`;
}

/**
 * Create a log entry object
 */
function createLogEntry(
  level: string,
  message: string,
  context?: Record<string, unknown>,
  error?: Error & { code?: string }
): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'fluxora-backend',
    message,
    context,
  };

  if (error) {
    entry.error = {
      name: error.name,
      message: error.message,
      code: 'code' in error ? (error as { code?: string }).code : undefined,
      stack: error.stack,
    };
  }

  return entry;
}

/**
 * Core logging function
 */
function log(level: LogLevel, levelStr: string, message: string, context?: Record<string, unknown>, error?: Error): void {
  if (level > currentLogLevel) {
    return;
  }

  const entry = createLogEntry(levelStr, message, context, error);
  const formatted = formatLogEntry(entry);

  if (level === LogLevel.ERROR) {
    console.error(formatted);
  } else if (level === LogLevel.WARN) {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
}

/**
 * Log an error message
 */
export function error(message: string, context?: Record<string, unknown>, err?: Error): void {
  log(LogLevel.ERROR, 'ERROR', message, context, err);
}

/**
 * Log a warning message
 */
export function warn(message: string, context?: Record<string, unknown>): void {
  log(LogLevel.WARN, 'WARN', message, context);
}

/**
 * Log an informational message
 */
export function info(message: string, context?: Record<string, unknown>): void {
  log(LogLevel.INFO, 'INFO', message, context);
}

/**
 * Log a debug message
 */
export function debug(message: string, context?: Record<string, unknown>): void {
  log(LogLevel.DEBUG, 'DEBUG', message, context);
}

/**
 * Log serialization-specific events for diagnostics
 */
export namespace SerializationLogger {
  /**
   * Log a validation failure for decimal string
   */
  export function validationFailed(
    fieldName: string,
    receivedValue: unknown,
    errorCode: string,
    requestId?: string
  ): void {
    error('Decimal validation failed', {
      field: fieldName,
      receivedType: typeof receivedValue,
      receivedValue: String(receivedValue).slice(0, 100), // Truncate for logging
      errorCode,
      requestId,
    });
  }

  /**
   * Log successful serialization of amount fields
   */
  export function amountSerialized(
    fieldCount: number,
    requestId?: string
  ): void {
    debug('Amount fields serialized', {
      fieldCount,
      requestId,
    });
  }

  /**
   * Log precision loss prevention
   */
  export function precisionLossPrevented(
    fieldName: string,
    originalValue: unknown,
    requestId?: string
  ): void {
    warn('Precision loss prevented during serialization', {
      field: fieldName,
      originalValue: String(originalValue).slice(0, 100),
      requestId,
    });
  }

  /**
   * Log out-of-range value rejection
   */
  export function outOfRangeRejected(
    fieldName: string,
    value: unknown,
    requestId?: string
  ): void {
    warn('Out-of-range decimal value rejected', {
      field: fieldName,
      value: String(value).slice(0, 100),
      requestId,
    });
  }
}

/**
 * Express middleware to add request ID to all requests
 */
export function requestIdMiddleware(req: { headers: Record<string, string | string[] | undefined>; id?: string }, _res: unknown, next: () => void): void {
  req.id = (req.headers['x-request-id'] as string) || `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  next();
}
