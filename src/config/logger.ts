/**
 * Logger module for Fluxora Backend
 * 
 * Provides structured logging for operational observability.
 * Operators can diagnose incidents by reviewing logs without tribal knowledge.
 * 
 * Log levels:
 * - debug: Development and detailed diagnostics
 * - info: Normal operational events
 * - warn: Degraded conditions, recoverable errors
 * - error: Failures requiring operator attention
 */

import { sanitize, redactKeysInString } from '../pii/sanitizer.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * OCSF (Open Cybersecurity Schema Framework) fields for slow-query log entries.
 * Compatible with Splunk, Datadog, and Elastic SIEM ingestion pipelines.
 * Ref: OCSF Database Activity (class_uid 5001)
 */
export interface SlowQueryLogEntry {
  log_type: 'slow_query';
  /** OCSF class_uid for Database Activity */
  class_uid: 5001;
  /** OCSF activity_id: 1 = Query */
  activity_id: 1;
  /** OCSF severity_id: 3 = Medium */
  severity_id: 3;
  severity: 'Medium';
  /** ISO-8601 timestamp */
  time: string;
  /** SHA-256 prefix of the SQL (never raw SQL) */
  query_hash: string;
  /** Wall-clock duration in milliseconds */
  duration_ms: number;
  /** Table name extracted from SQL keywords */
  table_hint: string;
  /** Request correlation ID */
  correlation_id?: string;
}

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    context?: Record<string, unknown> | undefined;
    error?: {
        name: string;
        message: string;
        stack?: string | undefined;
    } | undefined;
}

/**
 * Logger instance for structured logging
 */
export class Logger {
    private minLevel: LogLevel;
    private levelOrder: Record<LogLevel, number> = {
        debug: 0,
        info: 1,
        warn: 2,
        error: 3,
    };

    constructor(minLevel: LogLevel = 'info') {
        this.minLevel = minLevel;
    }

    /**
     * Check if a log level should be emitted
     */
    private shouldLog(level: LogLevel): boolean {
        return this.levelOrder[level] >= this.levelOrder[this.minLevel];
    }

    /**
     * Format and emit a log entry
     */
    private emit(entry: LogEntry): void {
        if (!this.shouldLog(entry.level)) {
            return;
        }

        // Sanitize the entry
        const sanitizedEntry: LogEntry = {
            ...entry,
            timestamp: new Date().toISOString(),
            message: redactKeysInString(entry.message),
        };

        // Sanitize context if present
        if (sanitizedEntry.context) {
            sanitizedEntry.context = sanitize(sanitizedEntry.context);
        }

        // Sanitize error if present
        if (sanitizedEntry.error) {
            sanitizedEntry.error = {
                name: sanitizedEntry.error.name,
                message: redactKeysInString(sanitizedEntry.error.message),
                stack: sanitizedEntry.error.stack ? redactKeysInString(sanitizedEntry.error.stack) : undefined,
            };
        }

        // Use appropriate console method
        const method = sanitizedEntry.level === 'error' ? 'error' : sanitizedEntry.level === 'warn' ? 'warn' : 'log';
        console[method](JSON.stringify(sanitizedEntry));
    }

    /**
     * Log debug message
     */
    debug(message: string, context?: Record<string, unknown>): void {
        this.emit({ timestamp: '', level: 'debug', message, ...(context !== undefined ? { context } : {}) });
    }

    /**
     * Log info message
     */
    info(message: string, context?: Record<string, unknown>): void {
        this.emit({ timestamp: '', level: 'info', message, ...(context !== undefined ? { context } : {}) });
    }

    /**
     * Log warning message
     */
    warn(message: string, context?: Record<string, unknown>): void {
        this.emit({ timestamp: '', level: 'warn', message, ...(context !== undefined ? { context } : {}) });
    }

    /**
     * Log error message
     */
    error(message: string, error?: Error, context?: Record<string, unknown>): void {
        const errorInfo: LogEntry['error'] = error
            ? {
                name: error.name,
                message: error.message,
                ...(error.stack !== undefined ? { stack: error.stack } : {}),
            }
            : undefined;

        this.emit({
            timestamp: '',
            level: 'error',
            message,
            ...(context !== undefined ? { context } : {}),
            ...(errorInfo !== undefined ? { error: errorInfo } : {}),
        });
    }

    /**
     * Emit a SIEM-compatible OCSF slow-query log entry.
     * Fields follow OCSF Database Activity (class_uid 5001).
     * Raw SQL and parameter values are never included.
     */
    slowQuery(fields: Omit<SlowQueryLogEntry, 'log_type' | 'class_uid' | 'activity_id' | 'severity_id' | 'severity' | 'time'>): void {
        const entry: SlowQueryLogEntry = {
            log_type: 'slow_query',
            class_uid: 5001,
            activity_id: 1,
            severity_id: 3,
            severity: 'Medium',
            time: new Date().toISOString(),
            ...fields,
        };
        console.warn(JSON.stringify(entry));
    }

    /**
     * Create a child logger with additional context
     */
    child(context: Record<string, unknown>): ContextualLogger {
        return new ContextualLogger(this, context);
    }

    /**
     * Set minimum log level
     */
    setLevel(level: LogLevel): void {
        this.minLevel = level;
    }
}

/**
 * Logger with persistent context (e.g., request ID, user ID)
 */
export class ContextualLogger {
    constructor(
        private logger: Logger,
        private context: Record<string, unknown>
    ) { }

    debug(message: string, context?: Record<string, unknown>): void {
        this.logger.debug(message, { ...this.context, ...context });
    }

    info(message: string, context?: Record<string, unknown>): void {
        this.logger.info(message, { ...this.context, ...context });
    }

    warn(message: string, context?: Record<string, unknown>): void {
        this.logger.warn(message, { ...this.context, ...context });
    }

    error(message: string, error?: Error, context?: Record<string, unknown>): void {
        this.logger.error(message, error, { ...this.context, ...context });
    }
}

/**
 * Global logger instance
 */
let globalLogger: Logger | null = null;

/**
 * Initialize global logger
 */
export function initializeLogger(level: LogLevel = 'info'): Logger {
    if (globalLogger) {
        return globalLogger;
    }

    globalLogger = new Logger(level);
    return globalLogger;
}

/**
 * Get global logger instance
 */
export function getLogger(): Logger {
    if (!globalLogger) {
        globalLogger = new Logger('info');
    }
    return globalLogger;
}

/**
 * Reset logger (for testing)
 */
export function resetLogger(): void {
    globalLogger = null;
}
